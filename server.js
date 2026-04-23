const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Database ---
// Render provides DATABASE_URL automatically when you link a PostgreSQL instance
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// --- Init DB tables + seed ---
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS content (
      id TEXT PRIMARY KEY DEFAULT 'main',
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS content_backups (
      id SERIAL PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'admin'
    );
  `);

  // Seed default admin if no users exist
  const { rows } = await pool.query('SELECT COUNT(*) FROM users');
  if (parseInt(rows[0].count) === 0) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASS || 'why2025!', 10);
    await pool.query('INSERT INTO users (username, password, role) VALUES ($1, $2, $3)',
      ['admin', hash, 'admin']);
    console.log('Default admin created — user: admin');
  }

  // Seed content from JSON file if DB is empty
  const contentCheck = await pool.query('SELECT COUNT(*) FROM content');
  if (parseInt(contentCheck.rows[0].count) === 0) {
    const seedFile = path.join(__dirname, 'data', 'content.json');
    if (fs.existsSync(seedFile)) {
      const seedData = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
      await pool.query('INSERT INTO content (id, data) VALUES ($1, $2)', ['main', JSON.stringify(seedData)]);
      console.log('Content seeded from data/content.json');
    }
  }

  console.log('Database initialized');
}

// --- Middleware ---
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'why-cms-secret-2025-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production' ? true : false,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  },
  proxy: process.env.NODE_ENV === 'production',
}));

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// Serve static files (index.html, admin.html, assets)
app.use(express.static(__dirname, {
  index: false,
  extensions: ['html'],
}));

// --- Auth Middleware ---
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// --- Routes ---

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// --- Auth API ---
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];

    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.user = { username: user.username, role: user.role };
    res.json({ success: true, user: { username: user.username, role: user.role } });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/session', (req, res) => {
  if (req.session && req.session.user) {
    res.json({ authenticated: true, user: req.session.user });
  } else {
    res.json({ authenticated: false });
  }
});

// --- Content API ---
app.get('/api/content', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM content WHERE id = $1', ['main']);
    if (rows.length === 0) return res.status(404).json({ error: 'No content found' });
    res.json(rows[0].data);
  } catch (e) {
    console.error('Content read error:', e);
    res.status(500).json({ error: 'Failed to load content' });
  }
});

app.put('/api/content', requireAuth, async (req, res) => {
  try {
    // Backup current version
    await pool.query(
      'INSERT INTO content_backups (data) SELECT data FROM content WHERE id = $1',
      ['main']
    );
    // Update
    await pool.query(
      'INSERT INTO content (id, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()',
      ['main', JSON.stringify(req.body)]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('Content save error:', e);
    res.status(500).json({ error: 'Failed to save content' });
  }
});

app.patch('/api/content/:section', requireAuth, async (req, res) => {
  try {
    const section = req.params.section;
    // Backup
    await pool.query(
      'INSERT INTO content_backups (data) SELECT data FROM content WHERE id = $1',
      ['main']
    );
    // Update specific section using jsonb_set
    await pool.query(
      `UPDATE content SET data = jsonb_set(data, $1, $2::jsonb), updated_at = NOW() WHERE id = $3`,
      [`{${section}}`, JSON.stringify(req.body), 'main']
    );
    res.json({ success: true });
  } catch (e) {
    console.error('Section update error:', e);
    res.status(500).json({ error: 'Failed to update section' });
  }
});

// --- Change Password ---
app.post('/api/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [req.session.user.username]);
    const user = rows[0];

    if (!bcrypt.compareSync(currentPassword, user.password)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const hash = bcrypt.hashSync(newPassword, 10);
    await pool.query('UPDATE users SET password = $1 WHERE username = $2', [hash, user.username]);
    res.json({ success: true });
  } catch (e) {
    console.error('Password change error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- AI Chat (OpenAI GPT) ---
const OPENAI_KEY = process.env.OPENAI_API_KEY;

// Simple in-memory rate limit: max 20 requests per IP per hour
const chatLimits = new Map();
function chatRateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const window = 60 * 60 * 1000; // 1 hour
  if (!chatLimits.has(ip)) chatLimits.set(ip, []);
  const hits = chatLimits.get(ip).filter(t => now - t < window);
  if (hits.length >= 20) return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
  hits.push(now);
  chatLimits.set(ip, hits);
  next();
}

// Build system prompt from DB content
async function buildSystemPrompt(profile) {
  let contentData = {};
  try {
    const { rows } = await pool.query('SELECT data FROM content WHERE id = $1', ['main']);
    if (rows.length) contentData = rows[0].data;
  } catch(e) {}

  const services = (contentData.services?.items || []).map(s => s.en?.title).join(', ');
  const clients = (contentData.clients || []).join(', ');
  const team = (contentData.team?.members || []).map(m => `${m.name} (${m.role})`).join(', ');

  let profileContext = '';
  if (profile) {
    if (profile.intent) profileContext += `\nVisitor intent: ${profile.intent}`;
    if (profile.sector) profileContext += `\nVisitor sector: ${profile.sector}`;
    if (profile.interest) profileContext += `\nVisitor interest: ${profile.interest}`;
  }

  return `You are the AI assistant for WHY (justwhy.it), a creative technology studio based in Rome, Italy.
WHY transforms ideas into dynamic, evolutionary communication systems.

Core philosophy: WHY doesn't chase technology trends. It asks "why" — starting from the right question to build systems that evolve, communicate, and last.

Services: ${services}
Key clients: ${clients}
Team: ${team}
Technologies: Unreal Engine 5, Unity, WebGL (PlayCanvas, Babylon, Three.js), AR (Spark AR, Vuforia), Motion Capture, Virtual Production, AI (OpenAI, generative), Dolby Atmos, Quest/Vive/Varjo.

Company: Founded 2021 in Rome as spinoff from Centounopercento (20+ years experience). 10 in-house resources + network. Joint venture FRY with Frame by Frame S.p.A.
${profileContext}

Guidelines:
- Be concise, professional, and warm. Match WHY's tone: bold, tech-forward, substance over buzzwords.
- Answer questions about services, capabilities, team, and approach.
- If asked about pricing or timelines, explain that each project is custom and suggest scheduling a call at info@justwhy.it.
- Respond in the same language the visitor uses (Italian or English).
- Keep answers under 150 words unless the visitor asks for detail.`;
}

app.post('/api/chat', chatRateLimit, async (req, res) => {
  if (!OPENAI_KEY) {
    return res.status(503).json({ error: 'AI chat not configured' });
  }

  try {
    const { messages, profile } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages' });
    }

    const systemPrompt = await buildSystemPrompt(profile);

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: systemPrompt }, ...messages.slice(-10)],
        stream: true,
        max_tokens: 500,
        temperature: 0.7,
      }),
    });

    if (!openaiRes.ok) {
      const err = await openaiRes.text();
      console.error('OpenAI error:', err);
      return res.status(502).json({ error: 'AI service error' });
    }

    // Stream SSE to client
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = openaiRes.body;
    let buffer = '';

    reader.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              res.write(`data: ${JSON.stringify({ content })}\n\n`);
            }
          } catch(e) {}
        }
      }
    });

    reader.on('end', () => {
      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });

    reader.on('error', (err) => {
      console.error('Stream error:', err);
      if (!res.writableEnded) res.end();
    });

  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Generate personalized content after onboarding
app.post('/api/personalize', chatRateLimit, async (req, res) => {
  if (!OPENAI_KEY) {
    return res.json({ headline: null, subtitle: null });
  }

  try {
    const { profile, lang } = req.body;

    const prompt = `Generate a personalized one-line headline and subtitle for a visitor to WHY's website (creative tech studio in Rome).

Visitor profile:
- Intent: ${profile.intent || 'exploring'}
- Sector: ${profile.sector || 'general'}
- Interest: ${profile.interest || 'general'}
- Language: ${lang === 'it' ? 'Italian' : 'English'}

Respond ONLY with JSON: {"headline":"...","subtitle":"..."}
The headline should be max 6 words, bold, no punctuation. The subtitle max 20 words, referencing their sector/interest.`;

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 100,
        temperature: 0.8,
      }),
    });

    if (!openaiRes.ok) return res.json({ headline: null, subtitle: null });

    const data = await openaiRes.json();
    const text = data.choices?.[0]?.message?.content || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      res.json(JSON.parse(match[0]));
    } else {
      res.json({ headline: null, subtitle: null });
    }
  } catch(e) {
    console.error('Personalize error:', e);
    res.json({ headline: null, subtitle: null });
  }
});

// --- Health check (Render uses this) ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Start ---
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n  WHY Website + CMS`);
    console.log(`  ─────────────────────────`);
    console.log(`  Site:  http://localhost:${PORT}`);
    console.log(`  Admin: http://localhost:${PORT}/admin`);
    console.log(`  Env:   ${process.env.NODE_ENV || 'development'}`);
    console.log(`  ─────────────────────────\n`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
