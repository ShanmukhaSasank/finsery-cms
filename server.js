const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const app = express();
const PORT = 3000;

// ── Config ──────────────────────────────────────────────────────────────────
const N8N_WEBHOOK_URL = 'https://n8n.finsery-staging.com/webhook/finsery-article';
// ↑ Replace with your actual n8n Webhook node URL

const DB_PATH = path.join(__dirname, 'finsery.db');

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── DB ───────────────────────────────────────────────────────────────────────
let db;

async function initDb() {
  const SQL = await initSqlJs();
  db = fs.existsSync(DB_PATH)
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();

  db.run(`
    CREATE TABLE IF NOT EXISTS submissions (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      content_id             TEXT    NOT NULL,
      title                  TEXT    NOT NULL,
      primary_keyword        TEXT    NOT NULL,
      intent                 TEXT    NOT NULL,
      angle                  TEXT    NOT NULL,
      finsery_pro_tip        TEXT    DEFAULT 'no',
      content_specification  TEXT    NOT NULL,
      key_takeaway           TEXT    DEFAULT 'no',
      story_hook             TEXT    DEFAULT 'no',
      accordion              TEXT    DEFAULT 'no',
      reference_links        TEXT,
      avoid                  TEXT,
      brand_mention          TEXT,
      tone                   TEXT    NOT NULL,
      target_audience        TEXT    NOT NULL,
      word_count             INTEGER NOT NULL,
      category               TEXT    NOT NULL,
      tags                   TEXT    DEFAULT '[]',
      automate               INTEGER DEFAULT 1,
      wp_draft_link          TEXT    DEFAULT '',
      submitted_at           TEXT    NOT NULL,
      n8n_status             TEXT    DEFAULT 'pending',
      created_at             TEXT    DEFAULT (datetime('now'))
    )
  `);
  saveDb();
  console.log('✅ Database ready');
}

function saveDb() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

// ── POST /submit ─────────────────────────────────────────────────────────────
app.post('/submit', async (req, res) => {
  const {
    content_id, title, primary_keyword, intent, angle,
    finsery_pro_tip, content_specification, key_takeaway, story_hook,
    accordion, reference_links, avoid, brand_mention, tone,
    target_audience, word_count, category, tags, automate, submitted_at
  } = req.body;

  // Required field check
  if (!title || !primary_keyword || !intent || !angle || !content_specification
      || !tone || !target_audience || !word_count || !category) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  let submissionId;
  try {
    db.run(`
      INSERT INTO submissions
        (content_id, title, primary_keyword, intent, angle, finsery_pro_tip,
         content_specification, key_takeaway, story_hook, accordion,
         reference_links, avoid, brand_mention, tone, target_audience,
         word_count, category, tags, automate, submitted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        content_id || '', title, primary_keyword, intent, angle,
        finsery_pro_tip || 'no', content_specification,
        key_takeaway || 'no', story_hook || 'no', accordion || 'no',
        reference_links || '', avoid || '', brand_mention || '',
        tone, target_audience, word_count, category,
        JSON.stringify(tags || []),
        automate ? 1 : 0,
        submitted_at || new Date().toISOString()
      ]
    );
    const r = db.exec('SELECT last_insert_rowid()');
    submissionId = r[0].values[0][0];
    saveDb();
    console.log(`📝 Saved #${submissionId} [${content_id}]: "${title}"`);
  } catch (e) {
    console.error('DB error:', e.message);
    return res.status(500).json({ error: 'Failed to save submission.' });
  }

  // Only trigger n8n if automate = true
  let n8nStatus = 'skipped';
  if (automate) {
    const payload = { ...req.body, submission_id: submissionId };
    try {
      const n8nRes = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      n8nStatus = n8nRes.ok ? 'triggered' : 'n8n_error';
      console.log(`🚀 n8n: ${n8nStatus} for #${submissionId}`);
    } catch (e) {
      n8nStatus = 'n8n_unreachable';
      console.warn('⚠️  n8n unreachable:', e.message);
    }
    db.run('UPDATE submissions SET n8n_status = ? WHERE id = ?', [n8nStatus, submissionId]);
    saveDb();
  }

  return res.json({ success: true, submission_id: submissionId, n8n_status: n8nStatus });
});

// ── PATCH /submissions/:id/wp-draft — called by n8n when WP draft is created
app.patch('/submissions/:id/wp-draft', (req, res) => {
  const { wp_draft_link } = req.body;
  if (!wp_draft_link) return res.status(400).json({ error: 'wp_draft_link required' });
  db.run('UPDATE submissions SET wp_draft_link = ? WHERE id = ?', [wp_draft_link, req.params.id]);
  saveDb();
  console.log(`🔗 WP draft saved for #${req.params.id}: ${wp_draft_link}`);
  res.json({ success: true });
});

// ── POST /submissions/:id/rerun — re-trigger n8n for a failed submission ─────
app.post('/submissions/:id/rerun', async (req, res) => {
  const r = db.exec('SELECT * FROM submissions WHERE id = ?', [req.params.id]);
  if (!r.length || !r[0].values.length) return res.status(404).json({ error: 'Submission not found' });

  const o = {};
  r[0].columns.forEach((c, i) => { o[c] = r[0].values[0][i]; });
  o.tags = JSON.parse(o.tags || '[]');

  const payload = {
    submission_id:         o.id,
    content_id:            o.content_id,
    title:                 o.title,
    primary_keyword:       o.primary_keyword,
    intent:                o.intent,
    angle:                 o.angle,
    finsery_pro_tip:       o.finsery_pro_tip,
    content_specification: o.content_specification,
    key_takeaway:          o.key_takeaway,
    story_hook:            o.story_hook,
    accordion:             o.accordion,
    reference_links:       o.reference_links,
    avoid:                 o.avoid,
    brand_mention:         o.brand_mention,
    tone:                  o.tone,
    target_audience:       o.target_audience,
    word_count:            o.word_count,
    category:              o.category,
    tags:                  o.tags,
    submitted_at:          o.submitted_at
  };

  let n8nStatus = 'triggered';
  try {
    const n8nRes = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    n8nStatus = n8nRes.ok ? 'triggered' : 'n8n_error';
    console.log(`🔁 Re-run n8n: ${n8nStatus} for #${o.id}`);
  } catch (e) {
    n8nStatus = 'n8n_unreachable';
    console.warn('⚠️  n8n unreachable on rerun:', e.message);
  }

  db.run('UPDATE submissions SET n8n_status = ? WHERE id = ?', [n8nStatus, o.id]);
  saveDb();

  return res.json({ success: true, submission_id: o.id, n8n_status: n8nStatus });
});

// ── GET /submissions ─────────────────────────────────────────────────────────
app.get('/submissions', (req, res) => {
  const result = db.exec('SELECT * FROM submissions ORDER BY created_at DESC LIMIT 200');
  if (!result.length) return res.json([]);
  const { columns, values } = result[0];
  res.json(values.map(row => {
    const o = {};
    columns.forEach((c, i) => { o[c] = row[i]; });
    o.tags = JSON.parse(o.tags || '[]');
    o.automate = !!o.automate;
    return o;
  }));
});

// ── GET /submissions/:id ──────────────────────────────────────────────────────
app.get('/submissions/:id', (req, res) => {
  const r = db.exec('SELECT * FROM submissions WHERE id = ?', [req.params.id]);
  if (!r.length || !r[0].values.length) return res.status(404).json({ error: 'Not found' });
  const o = {};
  r[0].columns.forEach((c, i) => { o[c] = r[0].values[0][i]; });
  o.tags = JSON.parse(o.tags || '[]');
  o.automate = !!o.automate;
  res.json(o);
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🟢 Finsery backend → http://localhost:${PORT}`);
    console.log(`   Form:           http://localhost:${PORT}/`);
    console.log(`   All submissions: http://localhost:${PORT}/submissions\n`);
  });
}).catch(e => { console.error(e); process.exit(1); });