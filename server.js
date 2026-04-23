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
    CREATE TABLE IF NOT EXISTS submissions (
      id SERIAL PRIMARY KEY,
      name TEXT,
      email TEXT,
      sector TEXT,
      goal TEXT,
      why TEXT,
      company TEXT,
      website TEXT,
      description TEXT,
      kpi TEXT,
      target TEXT,
      budget TEXT,
      workflow JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS contact_requests (
      id SERIAL PRIMARY KEY,
      name TEXT,
      email TEXT,
      mode TEXT,
      channel TEXT,
      contact TEXT,
      sector TEXT,
      goal TEXT,
      why TEXT,
      message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
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

// Build system prompt from DB content + CMS ai_context
async function buildSystemPrompt(profile, lang) {
  let contentData = {};
  try {
    const { rows } = await pool.query('SELECT data FROM content WHERE id = $1', ['main']);
    if (rows.length) contentData = rows[0].data;
  } catch(e) {}

  const services = (contentData.services?.items || []).map(s => s.en?.title).join(', ');
  const clients = (contentData.clients || []).join(', ');
  const team = (contentData.team?.members || []).map(m => `${m.name} (${m.role})`).join(', ');
  const aiContext = contentData.ai_context || '';

  let profileContext = '';
  if (profile) {
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
${aiContext ? '\nAdditional context from the team:\n' + aiContext : ''}
${profileContext}

Guidelines:
- CRITICAL: Always respond in the same language the user writes in. If they write in Italian, respond in Italian. If in English, respond in English.${lang ? ` The site is currently set to ${lang === 'it' ? 'Italian' : 'English'}.` : ''}
- Be concise, professional, and warm. Match WHY's tone: bold, tech-forward, substance over buzzwords.
- Answer questions about services, capabilities, team, and approach.
- If asked about pricing or timelines, explain that each project is custom and suggest scheduling a call at info@justwhy.it.
- Keep answers under 150 words unless the visitor asks for detail.`;
}

// Chat endpoint — non-streaming for Node.js fetch compatibility
app.post('/api/chat', chatRateLimit, async (req, res) => {
  if (!OPENAI_KEY) {
    return res.status(503).json({ error: 'AI chat not configured' });
  }

  try {
    const { messages, profile, lang } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages' });
    }

    const systemPrompt = await buildSystemPrompt(profile, lang);

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        messages: [{ role: 'system', content: systemPrompt }, ...messages.slice(-10)],
        max_completion_tokens: 500,
        temperature: 0.7,
      }),
    });

    if (!openaiRes.ok) {
      const err = await openaiRes.text();
      console.error('OpenAI chat error:', err);
      return res.status(502).json({ error: 'AI service error' });
    }

    const data = await openaiRes.json();
    const content = data.choices?.[0]?.message?.content || '';
    res.json({ content });

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
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: prompt }],
        max_completion_tokens: 100,
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

// --- Project Image Generation (OpenAI gpt-image-2) ---

// Step 1: Use GPT to craft a detailed, project-specific image prompt
async function buildImagePrompt(briefData) {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: `You are a world-class art director. Write a single image-generation prompt (max 250 words) for a hero visual that represents this specific project:

Client/Brand: ${briefData.company || 'not specified'}
Sector: ${briefData.sector || 'not specified'}
Goal: ${briefData.goal || 'not specified'}
Motivation: ${briefData.why || 'not specified'}
Description: ${briefData.description || 'not specified'}
Target audience: ${briefData.target || 'not specified'}

Requirements:
- The image must visually tell the story of THIS specific project — not a generic tech visual
- Include concrete visual elements that represent the client's industry and the project deliverable (e.g. a virtual showroom for luxury, an interactive installation for retail, a game interface for gamification)
- ${briefData.company ? `Prominently feature the "${briefData.company}" brand name/logo as elegant typography integrated into the scene` : 'No text in the image'}
- Dark background (#050505), with electric lime (#c8ff00) as accent color for highlights, glows, UI elements
- Cinematic lighting, ultra high quality, photorealistic materials
- The composition should feel like a premium project presentation or pitch deck hero image
- Include environmental context: if it's retail show a store, if it's an event show a venue, if it's digital show screens/devices in context

Respond ONLY with the prompt text, nothing else.` }],
        max_completion_tokens: 400,
        temperature: 0.8,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error('Image prompt generation error:', e);
    return null;
  }
}

// Step 2: Try to fetch client logo from their website domain
async function fetchClientLogo(websiteUrl) {
  if (!websiteUrl) return null;
  try {
    // Extract domain from URL
    let domain = websiteUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
    if (!domain || domain.length < 3) return null;

    // Try Clearbit Logo API (free, no auth needed, returns PNG)
    const logoUrl = `https://logo.clearbit.com/${domain}?size=400`;
    const res = await fetch(logoUrl, { redirect: 'follow' });
    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('image')) return null;

    const buffer = await res.arrayBuffer();
    const b64 = Buffer.from(buffer).toString('base64');
    const mime = contentType.includes('svg') ? 'image/svg+xml' : contentType.includes('png') ? 'image/png' : 'image/jpeg';
    return { dataUrl: `data:${mime};base64,${b64}`, b64, mime };
  } catch (e) {
    console.error('Logo fetch error:', e);
    return null;
  }
}

// Step 3: Generate the project image
async function generateProjectImage(briefData) {
  if (!OPENAI_KEY) return null;
  try {
    // Build smart prompt + fetch logo in parallel
    const [smartPrompt, logoData] = await Promise.all([
      buildImagePrompt(briefData),
      fetchClientLogo(briefData.website)
    ]);

    const finalPrompt = smartPrompt || `A sophisticated concept visualization for a ${briefData.sector || 'technology'} project by ${briefData.company || 'a client'}. Goal: ${briefData.goal || 'innovation'}. ${briefData.description ? briefData.description.slice(0, 300) : ''} Dark background (#050505), electric lime (#c8ff00) accents. Cinematic, photorealistic, ultra high quality.`;

    console.log('Image prompt:', finalPrompt.slice(0, 120) + '...');
    if (logoData) console.log('Client logo fetched successfully');

    // If we have a logo, use the edits endpoint to compose it into the scene
    if (logoData && !logoData.mime.includes('svg')) {
      try {
        const FormData = (await import('node:buffer')).Buffer ? null : null;
        // Use multipart form for edits endpoint
        const boundary = '----WHYBoundary' + Date.now();
        const imagePart = Buffer.from(logoData.b64, 'base64');

        // Build multipart body
        const parts = [];
        const addField = (name, value) => {
          parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
        };
        const addFile = (name, filename, contentType, data) => {
          parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`));
          parts.push(data);
          parts.push(Buffer.from('\r\n'));
        };

        addField('model', 'gpt-image-2');
        addField('prompt', `${finalPrompt}\n\nIMPORTANT: Integrate the provided logo image naturally and prominently into the scene — place it as a glowing, elegant brand mark within the composition.`);
        addField('size', '1536x1024');
        addField('quality', 'medium');
        addFile('image[]', 'logo.png', logoData.mime, imagePart);
        parts.push(Buffer.from(`--${boundary}--\r\n`));

        const body = Buffer.concat(parts);

        const editRes = await fetch('https://api.openai.com/v1/images/edits', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENAI_KEY}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
          body,
        });

        if (editRes.ok) {
          const editData = await editRes.json();
          const b64 = editData.data?.[0]?.b64_json;
          if (b64) return `data:image/png;base64,${b64}`;
        } else {
          console.error('Image edit with logo failed:', await editRes.text(), '— falling back to generation');
        }
      } catch (editErr) {
        console.error('Logo compositing error:', editErr, '— falling back to generation');
      }
    }

    // Fallback: standard generation (no logo image, but brand name in prompt)
    const imgRes = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-image-2',
        prompt: finalPrompt,
        n: 1,
        size: '1536x1024',
        quality: 'medium',
      }),
    });

    if (!imgRes.ok) {
      console.error('Image generation error:', await imgRes.text());
      return null;
    }

    const imgData = await imgRes.json();
    const b64 = imgData.data?.[0]?.b64_json;
    return b64 ? `data:image/png;base64,${b64}` : null;
  } catch (e) {
    console.error('Image generation error:', e);
    return null;
  }
}

// --- Workflow Generation (GPT-5.4 full, with fallback) ---
function generateFallbackWorkflow(sector, service, lang) {
  const isIt = lang === 'it';
  const svc = service || '3D Real Time';
  return [
    { id: 1, title: isIt ? 'Discovery & Analisi' : 'Discovery & Analysis', duration: isIt ? '1 settimana' : '1 week', description: isIt ? `Analisi del brand, del settore ${sector || ''} e degli obiettivi. Benchmark competitivo e definizione KPI.` : `Brand analysis, ${sector || ''} sector research and goal definition. Competitive benchmark and KPI setup.`, deliverables: ['Brief Document', 'Benchmark Report'], tools: ['Miro', 'Figma'] },
    { id: 2, title: isIt ? 'Concept & Design' : 'Concept & Design', duration: isIt ? '2 settimane' : '2 weeks', description: isIt ? `Ideazione creativa e progettazione UX/UI per la soluzione ${svc}.` : `Creative ideation and UX/UI design for the ${svc} solution.`, deliverables: ['Moodboard', 'Wireframes', 'Design System'], tools: ['Figma', 'Blender', 'Midjourney'] },
    { id: 3, title: isIt ? 'Sviluppo & Produzione' : 'Development & Production', duration: isIt ? '4-6 settimane' : '4-6 weeks', description: isIt ? `Sviluppo tecnico, produzione contenuti 3D/video, integrazione sistemi.` : `Technical development, 3D/video content production, system integration.`, deliverables: ['Alpha Build', 'Asset Library', 'Technical Docs'], tools: ['Unreal Engine 5', 'Three.js', 'Python'] },
    { id: 4, title: isIt ? 'Testing & Ottimizzazione' : 'Testing & Optimization', duration: isIt ? '1 settimana' : '1 week', description: isIt ? `QA, test di performance, ottimizzazione cross-device e accessibilità.` : `QA, performance testing, cross-device optimization and accessibility.`, deliverables: ['QA Report', 'Performance Audit'], tools: ['BrowserStack', 'Lighthouse'] },
    { id: 5, title: isIt ? 'Launch & Supporto' : 'Launch & Support', duration: isIt ? '1 settimana + ongoing' : '1 week + ongoing', description: isIt ? `Deployment, monitoraggio, formazione e supporto post-lancio.` : `Deployment, monitoring, training and post-launch support.`, deliverables: ['Launch Checklist', 'Analytics Dashboard', 'Training Session'], tools: ['Render', 'Google Analytics', 'Hotjar'] },
  ];
}

app.post('/api/workflow', chatRateLimit, async (req, res) => {
  const { name, email, sector, goal, why: whyR, service, company, website, description, kpi, target, budget, lang } = req.body;

  // Save submission to DB
  async function saveSubmission(workflow) {
    try {
      await pool.query(
        'INSERT INTO submissions (name, email, sector, goal, why, company, website, description, kpi, target, budget, workflow) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [name, email, sector, goal || service, whyR, company, website, description, kpi, target, budget, workflow ? JSON.stringify(workflow) : null]
      );
    } catch(e) { console.error('Save submission error:', e); }
  }

  if (!OPENAI_KEY) {
    const wf = generateFallbackWorkflow(sector, service, lang);
    await saveSubmission(wf);
    return res.json({ workflow: wf, image: null });
  }

  try {
    const { sector, goal, why: whyReason, service, company, website, description, kpi, target, budget, lang } = req.body;

    const wfPrompt = `You are a creative technology strategist at WHY, a Rome-based studio specializing in 3D Real Time, Immersive Video, XR, Phygital Activations, Instant Games, and AI Systems.

A potential client has submitted a project brief:
- Sector: ${sector || 'not specified'}
- Goal: ${goal || 'not specified'}
- Why (motivation): ${whyReason || 'not specified'}
- Company: ${company || 'not specified'}
- Website: ${website || 'not specified'}
- Project description: ${description || 'not specified'}
- KPI: ${kpi || 'not specified'}
- Target audience: ${target || 'not specified'}
- Budget range: ${budget || 'not specified'}

Generate a proposed project workflow as a JSON array of phases. Each phase has:
- "id": sequential number
- "title": phase name (${lang === 'it' ? 'in Italian' : 'in English'})
- "duration": estimated duration (e.g. "2 weeks")
- "description": one sentence (${lang === 'it' ? 'in Italian' : 'in English'})
- "deliverables": array of 2-3 deliverable names
- "tools": array of 1-3 technologies/tools WHY would use

Create 4-6 phases. Be specific to their sector and needs. Use WHY's actual tech stack.
Respond ONLY with the JSON array, no markdown, no explanation.`;

    // Run workflow generation and image generation in parallel
    const [openaiRes, projectImage] = await Promise.all([
      fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: wfPrompt }],
          max_completion_tokens: 1000,
          temperature: 0.7,
        }),
      }),
      generateProjectImage({ sector, goal, why: whyReason, company, website, description, target, service })
    ]);

    if (!openaiRes.ok) {
      console.error('OpenAI workflow error:', await openaiRes.text());
      const wf = generateFallbackWorkflow(sector, service, lang);
      await saveSubmission(wf);
      return res.json({ workflow: wf, image: projectImage });
    }

    const data = await openaiRes.json();
    const text = data.choices?.[0]?.message?.content || '';
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const wf = JSON.parse(match[0]);
      await saveSubmission(wf);
      res.json({ workflow: wf, image: projectImage });
    } else {
      await saveSubmission(null);
      res.status(500).json({ error: 'Failed to parse workflow' });
    }
  } catch (e) {
    console.error('Workflow error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Submissions API (admin only) ---
app.get('/api/submissions', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM submissions ORDER BY created_at DESC LIMIT 100');
    res.json(rows);
  } catch(e) {
    console.error('Submissions error:', e);
    res.status(500).json({ error: 'Failed to load submissions' });
  }
});

// --- Contact Requests ---
app.post('/api/contact-request', chatRateLimit, async (req, res) => {
  try {
    const { name, email, mode, channel, contact, sector, goal, why, message } = req.body;
    await pool.query(
      'INSERT INTO contact_requests (name, email, mode, channel, contact, sector, goal, why, message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [name, email, mode, channel, contact, sector, goal, why, message]
    );
    res.json({ success: true });
  } catch(e) {
    console.error('Contact request error:', e);
    res.status(500).json({ error: 'Failed to save' });
  }
});

app.get('/api/contact-requests', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM contact_requests ORDER BY created_at DESC LIMIT 100');
    res.json(rows);
  } catch(e) {
    res.status(500).json({ error: 'Failed to load' });
  }
});

app.delete('/api/submissions/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM submissions WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

// --- Team photo upload (base64 stored in content) ---
app.post('/api/upload-photo', requireAuth, express.json({ limit: '5mb' }), async (req, res) => {
  try {
    const { memberIndex, dataUrl } = req.body;
    if (typeof memberIndex !== 'number' || !dataUrl) return res.status(400).json({ error: 'Invalid data' });
    // Save photo data URL directly into the team member's photo field
    const { rows } = await pool.query('SELECT data FROM content WHERE id = $1', ['main']);
    if (!rows.length) return res.status(404).json({ error: 'No content' });
    const content = rows[0].data;
    if (content.team?.members?.[memberIndex]) {
      content.team.members[memberIndex].photo = dataUrl;
      await pool.query('UPDATE content SET data = $1, updated_at = NOW() WHERE id = $2', [JSON.stringify(content), 'main']);
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'Member not found' });
    }
  } catch(e) {
    console.error('Upload error:', e);
    res.status(500).json({ error: 'Upload failed' });
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
