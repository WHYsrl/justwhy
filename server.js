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
      image TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS image TEXT;
    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS timeline TEXT;
    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
    ALTER TABLE contact_requests ADD COLUMN IF NOT EXISTS message TEXT;
    CREATE TABLE IF NOT EXISTS particle_shapes (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      image_data TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS particle_settings (
      id TEXT PRIMARY KEY DEFAULT 'main',
      data JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT NOW()
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
- CRITICAL LANGUAGE RULE: ${lang === 'it' ? 'The site is set to ITALIAN. You MUST respond in Italian regardless of the language the user writes in. Always reply in Italian.' : 'The site is set to ENGLISH. Respond in English by default. If the user writes in another language, respond in that same language.'}
- Be concise, professional, and warm. Match WHY's tone: bold, tech-forward, substance over buzzwords.
- Answer questions about services, capabilities, team, and approach.
- If asked about pricing or timelines, explain that each project is custom and suggest scheduling a call or meeting.
- When the conversation naturally reaches a point where the visitor should get in touch (pricing questions, project discussions, wanting to go deeper), suggest scheduling a meeting or a call and include the exact tag [TALK] in your message. For example: "${lang === 'it' ? 'Fissiamo una call per approfondire? [TALK]' : 'Shall we schedule a call to discuss? [TALK]'}". Always place [TALK] right after the call-to-action sentence. Do NOT use email addresses — the [TALK] tag will be converted into an interactive button.
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
async function buildImagePrompt(briefData, workflow) {
  try {
    // Summarize workflow phases for the image prompt
    let workflowSummary = '';
    if (workflow && Array.isArray(workflow)) {
      const phases = workflow.map(p => `${p.title}: ${p.description || ''} (tools: ${(p.tools||[]).join(', ')})`).join('\n');
      workflowSummary = `\n\nPROPOSED SOLUTION (workflow phases):\n${phases}`;
    }

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: `You are a world-class art director at a creative technology studio. Write a single image-generation prompt (max 300 words) for a hero visual that represents the FINAL DELIVERABLE of this specific project — what the end result will look like in action.

CLIENT BRIEF:
- Client/Brand: ${briefData.company || 'not specified'}
- Sector: ${briefData.sector || 'not specified'}
- Goal: ${briefData.goal || 'not specified'}
- Motivation: ${briefData.why || 'not specified'}
- Description: ${briefData.description || 'not specified'}
- Target audience: ${briefData.target || 'not specified'}
${workflowSummary}

CRITICAL REQUIREMENTS:
- The image must show the FINAL PRODUCT in use — the actual deliverable being experienced by real people in a real environment
- If the solution is a VR experience, show someone wearing a headset in the right venue with the content visible
- If it's an interactive installation, show it in a physical space with people engaging
- If it's a web/app, show it on devices in the context where the target audience would use it
- If it's a game, show the game interface with players
- If it's an AI system, show the interface/dashboard in use
- The technologies from the workflow (${workflow ? workflow.flatMap(p=>p.tools||[]).filter((v,i,a)=>a.indexOf(v)===i).join(', ') : 'various'}) should be evident in the visual — show their output, not logos
- ${briefData.company ? `The "${briefData.company}" brand must appear naturally in the scene (on screens, signage, UI, or product packaging)` : 'No text in the image'}
- Dark, premium aesthetic: near-black background (#050505), electric lime (#c8ff00) for UI accents and highlights
- Cinematic lighting, photorealistic, shot like a premium case study photograph
- HUMAN ANATOMY: If people appear in the scene, pay extreme attention to correct human anatomy — proper number of fingers (5 per hand), natural proportions, realistic faces, correct body posture. No deformed hands, extra limbs, or uncanny features.
- The image should make the client say "YES, this is exactly what I want"

Respond ONLY with the prompt text, nothing else.` }],
        max_completion_tokens: 500,
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

    // Try Clearbit Logo API (free, no auth needed, returns PNG) — 5s timeout
    const logoUrl = `https://logo.clearbit.com/${domain}?size=400`;
    const ac = new AbortController();
    const logoTimeout = setTimeout(() => ac.abort(), 5000);
    const res = await fetch(logoUrl, { redirect: 'follow', signal: ac.signal });
    clearTimeout(logoTimeout);
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
async function generateProjectImage(briefData, workflow) {
  if (!OPENAI_KEY) return null;
  try {
    // Build smart prompt (using workflow) + fetch logo in parallel
    const [smartPrompt, logoData] = await Promise.all([
      buildImagePrompt(briefData, workflow),
      fetchClientLogo(briefData.website)
    ]);

    const finalPrompt = smartPrompt || `A sophisticated concept visualization for a ${briefData.sector || 'technology'} project by ${briefData.company || 'a client'}. Goal: ${briefData.goal || 'innovation'}. ${briefData.description ? briefData.description.slice(0, 300) : ''} Dark background (#050505), electric lime (#c8ff00) accents. Cinematic, photorealistic, ultra high quality. If people appear, ensure correct human anatomy: proper number of fingers, natural proportions, realistic faces.`;

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
      const errText = await imgRes.text();
      console.error('Image generation error:', errText);
      // If content policy rejection (likely brand/trademark), retry with periphrasis
      if (errText.includes('content_policy') || errText.includes('safety') || imgRes.status === 400) {
        const brand = briefData.company || '';
        const sector = briefData.sector || 'technology';
        const periphrasis = `a leading ${sector} company`;
        console.log(`Retrying image generation: replacing "${brand}" with "${periphrasis}"...`);
        const cleanPrompt = finalPrompt
          .replace(new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), periphrasis)
          .replace(/"[^"]*" brand must appear/gi, `fictional branding for ${periphrasis} should appear`);
        const retryRes = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
          body: JSON.stringify({ model: 'gpt-image-2', prompt: cleanPrompt, n: 1, size: '1536x1024', quality: 'medium' }),
        });
        if (retryRes.ok) {
          const retryData = await retryRes.json();
          const b64r = retryData.data?.[0]?.b64_json;
          if (b64r) return `data:image/png;base64,${b64r}`;
        }
      }
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
  const { name, email, sector, goal, why: whyR, service, company, website, description, kpi, target, budget, timeline, lang } = req.body;

  // Save submission to DB
  async function saveSubmission(workflow, image) {
    try {
      await pool.query(
        'INSERT INTO submissions (name, email, sector, goal, why, company, website, description, kpi, target, budget, timeline, workflow, image) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
        [name, email, sector, goal || service, whyR, company, website, description, kpi, target, budget, timeline, workflow ? JSON.stringify(workflow) : null, image || null]
      );
    } catch(e) { console.error('Save submission error:', e); }
  }

  if (!OPENAI_KEY) {
    const wf = generateFallbackWorkflow(sector, service, lang);
    await saveSubmission(wf, null);
    // Always send email if address provided (fallback even if user left the page)
    if (email) sendWorkflowEmail({ email, name, workflow: wf, image: null, lang }).catch(() => {});
    return res.json({ workflow: wf, image: null });
  }

  try {
    const { sector, goal, why: whyReason, service, company, website, description, kpi, target, budget, timeline, lang } = req.body;

    const wfPrompt = `You are a senior creative technology strategist at WHY (justwhy.it), a Rome-based creative technology studio.

WHY's capabilities (use ONLY what's relevant — never list them all):
- 3D Real Time: Unreal Engine 5, Unity, Three.js, WebGL, Blender — virtual showrooms, configurators, digital twins, real-time architectural viz
- Immersive Video: 360° video, spatial video, volumetric capture, interactive documentary — brand films, virtual tours, training
- XR (AR/VR/MR): Meta Quest, Apple Vision Pro, WebXR, ARKit/ARCore — immersive experiences, try-on, spatial computing
- Phygital Activations: sensors, projection mapping, interactive installations, LED walls, IoT — events, retail, exhibitions
- Instant Games: HTML5 games, playable ads, gamification platforms — engagement, loyalty, branded entertainment
- AI Systems: LLM integration, computer vision, generative AI, recommendation engines, chatbots — automation, personalization, content generation

A potential client submitted this brief:
- Sector: ${sector || 'not specified'}
- Goal/Service needed: ${goal || 'not specified'}
- Why (their motivation): ${whyReason || 'not specified'}
- Company: ${company || 'not specified'}
- Website: ${website || 'not specified'}
- Project description: ${description || 'not specified'}
- KPI: ${kpi || 'not specified'}
- Target audience: ${target || 'not specified'}
- Budget range: ${budget || 'not specified'}
- Available timeline: ${timeline || 'not specified'}

THINK carefully about what this client actually needs. Then generate a workflow as a JSON array.

RULES:
1. Use 3 to 7 phases depending on project complexity. A simple landing page needs 3, a complex XR experience might need 7. Match the scope.
2. Phase titles must be PROJECT-SPECIFIC, not generic. Instead of "Discovery & Analysis", say "Luxury Brand Immersion & Audience Mapping" or "Game Mechanics Design & Prototype". Make each title tell a story.
3. "tools" — list ONLY the specific technologies relevant to THIS phase. A branding phase uses Figma, not Unreal. A 3D phase uses Blender/UE5, not Google Analytics.
4. "description" — be concrete and specific to their industry. Reference their actual product/service, their audience, their KPI.
5. "deliverables" — name real, tangible outputs. Not "Report" but "Competitive UX Audit of top 5 ${sector || ''} competitors" or "Interactive prototype with 3 user flows".
6. DO NOT include technologies WHY doesn't use for this type of project. If the project is a website, don't mention Unreal Engine. If it's a VR experience, don't mention Google Analytics.
7. Duration must be realistic for the scope.
8. TIMELINE CONSTRAINT: If the client specified an available timeline (e.g. "4 settimane"), the SUM of all phase durations MUST NOT exceed that limit. Compress phases, run them in parallel, or merge them to fit. If the timeline is "non so" or not specified, use your best judgment for realistic timing.

Each phase: { "id": number, "title": string, "duration": string, "description": string (${lang === 'it' ? 'in Italian' : 'in English'}), "deliverables": [2-3 items], "tools": [1-3 relevant tools] }

All text in ${lang === 'it' ? 'Italian' : 'English'}.
Respond ONLY with the JSON array.`;

    // Step 1: Generate workflow first
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: wfPrompt }],
        max_completion_tokens: 1500,
        temperature: 0.8,
      }),
    });

    if (!openaiRes.ok) {
      console.error('OpenAI workflow error:', await openaiRes.text());
      const wf = generateFallbackWorkflow(sector, service, lang);
      const projectImage = await generateProjectImage({ sector, goal, why: whyReason, company, website, description, target, service }, wf);
      await saveSubmission(wf, projectImage);
      if (email) sendWorkflowEmail({ email, name, workflow: wf, image: projectImage, lang }).catch(() => {});
      return res.json({ workflow: wf, image: projectImage });
    }

    const data = await openaiRes.json();
    const text = data.choices?.[0]?.message?.content || '';
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const wf = JSON.parse(match[0]);
      // Step 2: Generate image using BOTH brief AND workflow output
      const projectImage = await generateProjectImage({ sector, goal, why: whyReason, company, website, description, target, service }, wf);
      await saveSubmission(wf, projectImage);
      // Always send email — works even if user closed the browser
      if (email) sendWorkflowEmail({ email, name, workflow: wf, image: projectImage, lang }).catch(() => {});
      res.json({ workflow: wf, image: projectImage });
    } else {
      await saveSubmission(null, null);
      res.status(500).json({ error: 'Failed to parse workflow' });
    }
  } catch (e) {
    console.error('Workflow error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Send workflow email helper (used by /api/workflow automatically) ---
async function sendWorkflowEmail({ email, name, workflow, image, lang }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY || !email || !workflow) return null;

  const it = lang === 'it';
  const greeting = name ? (it ? `Ciao ${name},` : `Hi ${name},`) : (it ? 'Ciao,' : 'Hi,');

  const phasesHtml = workflow.map((p, i) => `
    <tr>
      <td style="padding:16px 20px;border-bottom:1px solid #1a1a1a">
        <div style="color:#c8ff00;font-size:12px;font-weight:700;letter-spacing:2px;margin-bottom:4px">0${p.id} — ${p.duration || ''}</div>
        <div style="font-size:16px;font-weight:700;color:#ffffff;margin-bottom:6px">${p.title}</div>
        <div style="font-size:14px;color:#999;line-height:1.6">${p.description}</div>
        ${p.tools && p.tools.length ? `<div style="margin-top:8px">${p.tools.map(t => `<span style="display:inline-block;font-size:11px;color:#c8ff00;border:1px solid rgba(200,255,0,.2);padding:2px 8px;margin:2px 4px 2px 0">${t}</span>`).join('')}</div>` : ''}
      </td>
    </tr>`).join('');

  // Parse base64 image for attachment
  let imgAttachment = null;
  let imgHtmlBlock = '';
  if (image && image.startsWith('data:image/')) {
    try {
      const [meta, b64] = image.split(',');
      const mimeMatch = meta.match(/data:(image\/\w+);/);
      const mime = mimeMatch ? mimeMatch[1] : 'image/png';
      const ext = mime.split('/')[1] || 'png';
      imgAttachment = { content: b64, filename: `why-project-visual.${ext}`, type: mime };
      imgHtmlBlock = `<tr><td style="padding:20px;border-bottom:1px solid #1a1a1a;text-align:center">
        <p style="color:#c8ff00;font-size:12px;font-weight:700;letter-spacing:2px;margin:0 0 12px">${it ? 'PROJECT VISUAL' : 'PROJECT VISUAL'}</p>
        <p style="color:#666;font-size:13px;margin:0">${it ? '📎 Il visual del progetto è allegato a questa email' : '📎 The project visual is attached to this email'}</p>
      </td></tr>`;
    } catch(e) { console.error('Image attachment parse error:', e); }
  }

  const htmlBody = `
  <div style="background:#050505;padding:40px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
    <div style="max-width:600px;margin:0 auto">
      <div style="text-align:center;margin-bottom:30px">
        <div style="font-size:24px;font-weight:800;color:#ffffff;letter-spacing:2px">WHY</div>
        <div style="font-size:11px;color:#666;letter-spacing:3px;margin-top:4px">CREATIVE TECHNOLOGY STUDIO</div>
      </div>
      <div style="background:#0a0a0a;border:1px solid #1a1a1a;padding:30px">
        <p style="color:#ccc;font-size:15px;line-height:1.7;margin:0 0 10px">${greeting}</p>
        <p style="color:#ccc;font-size:15px;line-height:1.7;margin:0 0 25px">${it ? 'Ecco il workflow personalizzato che WHY AI ha elaborato per il tuo progetto:' : 'Here\'s the custom workflow WHY AI has crafted for your project:'}</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #1a1a1a;margin-top:10px">
          ${imgHtmlBlock}
          ${phasesHtml}
        </table>
        <div style="text-align:center;margin-top:30px">
          <a href="https://justwhy.it/#brief" style="display:inline-block;background:#c8ff00;color:#050505;font-weight:700;font-size:13px;letter-spacing:1px;padding:14px 32px;text-decoration:none;text-transform:uppercase">${it ? 'Parliamone →' : 'Let\'s talk →'}</a>
        </div>
        <p style="text-align:center;margin-top:15px">
          <a href="https://justwhy.it" style="color:#c8ff00;font-size:12px;text-decoration:none;letter-spacing:1px">${it ? 'Visita justwhy.it →' : 'Visit justwhy.it →'}</a>
        </p>
      </div>
      <div style="text-align:center;margin-top:20px">
        <p style="color:#444;font-size:12px">WHY srl — Roma, Italia</p>
        <a href="https://justwhy.it" style="color:#666;font-size:12px">justwhy.it</a>
      </div>
    </div>
  </div>`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'WHY AI <ai@justwhy.it>',
        to: [email],
        subject: it ? 'Il tuo workflow personalizzato — WHY' : 'Your custom workflow — WHY',
        html: htmlBody,
        ...(imgAttachment ? { attachments: [imgAttachment] } : {})
      })
    });
    const result = await resp.json();
    if (resp.ok) {
      console.log('Workflow email sent to', email, '- id:', result.id);
      return result.id;
    } else {
      console.error('Resend error:', result);
      return null;
    }
  } catch (e) {
    console.error('Resend fetch error:', e);
    return null;
  }
}

// --- Explicit email send endpoint (kept for frontend opt-in confirmation) ---
app.post('/api/send-workflow-email', chatRateLimit, async (req, res) => {
  const id = await sendWorkflowEmail(req.body);
  if (id) res.json({ ok: true, id });
  else res.status(500).json({ error: 'Email send failed' });
});

// --- Submissions API (admin only) ---
app.get('/api/submissions', requireAuth, async (req, res) => {
  try {
    const status = req.query.status || 'active';
    const q = status === 'all'
      ? 'SELECT * FROM submissions ORDER BY created_at DESC LIMIT 200'
      : 'SELECT * FROM submissions WHERE COALESCE(status,\'active\') = $1 ORDER BY created_at DESC LIMIT 200';
    const params = status === 'all' ? [] : [status];
    const { rows } = await pool.query(q, params);
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

// Bulk operations
app.post('/api/submissions/bulk', requireAuth, async (req, res) => {
  try {
    const { ids, action } = req.body;
    if (!ids?.length) return res.status(400).json({ error: 'No ids' });
    if (action === 'delete') {
      await pool.query('DELETE FROM submissions WHERE id = ANY($1::int[])', [ids]);
    } else if (action === 'archive') {
      await pool.query("UPDATE submissions SET status = 'archived' WHERE id = ANY($1::int[])", [ids]);
    } else if (action === 'restore') {
      await pool.query("UPDATE submissions SET status = 'active' WHERE id = ANY($1::int[])", [ids]);
    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }
    res.json({ success: true, count: ids.length });
  } catch(e) {
    res.status(500).json({ error: 'Bulk operation failed' });
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

// --- Particle Shapes API ---
app.get('/api/particle-shapes', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, image_data, sort_order FROM particle_shapes ORDER BY sort_order ASC, id ASC');
    res.json(rows);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Failed to load shapes' }); }
});

app.post('/api/particle-shapes', requireAuth, express.json({ limit: '5mb' }), async (req, res) => {
  try {
    const { name, image_data } = req.body;
    if (!name || !image_data) return res.status(400).json({ error: 'name and image_data required' });
    const maxOrder = await pool.query('SELECT COALESCE(MAX(sort_order),0)+1 as next FROM particle_shapes');
    const { rows } = await pool.query(
      'INSERT INTO particle_shapes (name, image_data, sort_order) VALUES ($1, $2, $3) RETURNING id, name, sort_order',
      [name, image_data, maxOrder.rows[0].next]
    );
    res.json(rows[0]);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Failed to save shape' }); }
});

app.put('/api/particle-shapes/:id', requireAuth, async (req, res) => {
  try {
    const { name, sort_order } = req.body;
    await pool.query('UPDATE particle_shapes SET name=COALESCE($1,name), sort_order=COALESCE($2,sort_order) WHERE id=$3',
      [name, sort_order, req.params.id]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Failed to update shape' }); }
});

app.delete('/api/particle-shapes/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM particle_shapes WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Failed to delete shape' }); }
});

app.put('/api/particle-shapes-order', requireAuth, async (req, res) => {
  try {
    const { order } = req.body; // array of ids in desired order
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
    for (let i = 0; i < order.length; i++) {
      await pool.query('UPDATE particle_shapes SET sort_order=$1 WHERE id=$2', [i, order[i]]);
    }
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Failed to reorder' }); }
});

// --- Particle Settings API ---
app.get('/api/particle-settings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data FROM particle_settings WHERE id=$1', ['main']);
    res.json(rows.length ? rows[0].data : {});
  } catch(e) { console.error(e); res.status(500).json({ error: 'Failed to load settings' }); }
});

app.put('/api/particle-settings', requireAuth, async (req, res) => {
  try {
    const data = req.body;
    await pool.query(`
      INSERT INTO particle_settings (id, data, updated_at) VALUES ('main', $1, NOW())
      ON CONFLICT (id) DO UPDATE SET data=$1, updated_at=NOW()
    `, [JSON.stringify(data)]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Failed to save settings' }); }
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
