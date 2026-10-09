// TV Mount OK backend: lead intake, admin panel API, Signal alerts. No dependencies (node:sqlite).
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncCalendar, haEnabled } from './ha.mjs';
import { sendMail, ackEmail, confirmEmail, mailEnabled } from './mail.mjs';

const env = process.env;
const PORT = Number(env.PORT || 8083);
const DATA_DIR = env.DATA_DIR || './data';
const ADMIN_PASSWORD = env.ADMIN_PASSWORD || '';
const SESSION_SECRET = env.SESSION_SECRET || '';
const ORIGINS = (env.ALLOWED_ORIGINS || 'https://tvmountok.com,https://www.tvmountok.com').split(',').map((s) => s.trim());
const SIGNAL_URL = env.SIGNAL_URL || '';
const SIGNAL_NUMBER = env.SIGNAL_NUMBER || '';
const SIGNAL_RECIPIENTS = (env.SIGNAL_RECIPIENTS || '').split(',').map((s) => s.trim()).filter(Boolean);
const TURNSTILE_SECRET = env.TURNSTILE_SECRET || '';
const PANEL_URL = env.PANEL_URL || 'https://admin.tvmountok.com';
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12 || SESSION_SECRET.length < 32) {
  console.error('ADMIN_PASSWORD (12+ chars) and SESSION_SECRET (32+ chars) are required');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(path.join(DATA_DIR, 'tvmountok.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT DEFAULT '',
  town TEXT NOT NULL, service TEXT DEFAULT '', size TEXT DEFAULT '', message TEXT DEFAULT '',
  address TEXT DEFAULT '', price INTEGER, status TEXT NOT NULL DEFAULT 'new',
  scheduled_start TEXT, scheduled_end TEXT, calendar_uid TEXT,
  source TEXT DEFAULT '', ip TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS lead_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind TEXT NOT NULL, body TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status, created_at);
CREATE INDEX IF NOT EXISTS idx_events_lead ON lead_events(lead_id);
`);

export const STATUSES = ['new', 'quoted', 'confirmed', 'done', 'cancelled'];
const q = {
  insert: db.prepare('INSERT INTO leads (name,phone,email,town,service,size,message,source,ip) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id'),
  event: db.prepare('INSERT INTO lead_events (lead_id,kind,body) VALUES (?,?,?)'),
  get: db.prepare('SELECT * FROM leads WHERE id = ?'),
  events: db.prepare('SELECT at,kind,body FROM lead_events WHERE lead_id = ? ORDER BY id'),
  counts: db.prepare('SELECT status, COUNT(*) AS n FROM leads GROUP BY status'),
};

// ---- helpers ----
const clip = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const hmac = (s) => crypto.createHmac('sha256', SESSION_SECRET).update(s).digest('base64url');
const safeEq = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
const clientIp = (req) => clip(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress, 64);

const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

const SESSION_MS = 14 * 24 * 3600e3;
const makeSession = () => { const exp = String(Date.now() + SESSION_MS); return `${exp}.${hmac('s' + exp)}`; };
function validSession(req) {
  const m = /(?:^|;\s*)tvm_session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  return !!sig && Number(exp) > Date.now() && safeEq(sig, hmac('s' + exp));
}

function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, {
    'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readJson(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

// ---- Signal ----
export async function signal(text) {
  if (!SIGNAL_URL || !SIGNAL_NUMBER || !SIGNAL_RECIPIENTS.length) return false;
  try {
    const r = await fetch(`${SIGNAL_URL}/v2/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, number: SIGNAL_NUMBER, recipients: SIGNAL_RECIPIENTS }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) console.error('signal send failed', r.status, await r.text());
    return r.ok;
  } catch (e) { console.error('signal error', e.message); return false; }
}

// ---- Cloudflare Turnstile ----
async function humanOk(token, ip) {
  if (!TURNSTILE_SECRET) return true; // not configured: skip
  if (!token || typeof token !== 'string') return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: token.slice(0, 2048), remoteip: ip }),
      signal: AbortSignal.timeout(8000),
    });
    return !!(await r.json()).success;
  } catch (e) { console.error('turnstile error', e.message); return false; }
}

// ---- public: lead intake ----
const corsFor = (req) => {
  const o = req.headers.origin;
  return o && ORIGINS.includes(o)
    ? { 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' }
    : { 'Vary': 'Origin' };
};

async function handleLead(req, res) {
  const cors = corsFor(req);
  const ip = clientIp(req);
  if (limited('lead:' + ip, 5, 3600e3)) return send(res, 429, { error: 'Too many requests' }, cors);
  let d;
  try { d = await readJson(req); } catch { return send(res, 400, { error: 'Bad request' }, cors); }
  if (d.website) return send(res, 200, { ok: true }, cors); // honeypot: pretend success
  if (!(await humanOk(d['cf-turnstile-response'], ip))) return send(res, 400, { error: 'Please complete the verification and try again.' }, cors);
  const lead = {
    name: clip(d.name, 100), phone: clip(d.phone, 40), email: clip(d.email, 120),
    town: clip(d.city || d.town, 80), service: clip(d.service, 100), size: clip(d.size, 40), message: clip(d.message, 2000),
  };
  if (!lead.name || !lead.town || lead.phone.replace(/\D/g, '').length < 7) return send(res, 400, { error: 'Name, phone and town are required' }, cors);
  if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) lead.email = '';
  const { id } = q.insert.get(lead.name, lead.phone, lead.email, lead.town, lead.service, lead.size, lead.message, clip(req.headers.referer, 200), ip);
  q.event.run(id, 'created', 'Lead received from website');
  send(res, 200, { ok: true, id }, cors);
  const lines = [`New TV Mount OK lead #${id}`, `${lead.name}  ${lead.phone}`, `${lead.town}${lead.service ? ' | ' + lead.service : ''}${lead.size ? ' | ' + lead.size : ''}`];
  if (lead.message) lines.push(lead.message.slice(0, 300));
  lines.push(`${PANEL_URL}/#${id}`);
  signal(lines.join('\n'));
  if (lead.email && mailEnabled) {
    const r = await sendMail(lead.email, ackEmail(lead));
    q.event.run(id, 'email', r.ok ? `Acknowledgement emailed to ${lead.email}` : `Acknowledgement email FAILED: ${r.error}`);
  }
}

// ---- admin API ----
const EDITABLE = {
  status: (v) => (STATUSES.includes(v) ? v : null),
  address: (v) => clip(v, 200), price: (v) => (v === '' || v == null ? null : Math.max(0, Math.min(100000, parseInt(v, 10) || 0))),
  scheduled_start: (v) => (v ? (Number.isNaN(Date.parse(v)) ? null : clip(v, 32)) : ''),
  scheduled_end: (v) => (v ? (Number.isNaN(Date.parse(v)) ? null : clip(v, 32)) : ''),
  name: (v) => clip(v, 100), phone: (v) => clip(v, 40), email: (v) => clip(v, 120), town: (v) => clip(v, 80),
  service: (v) => clip(v, 100), size: (v) => clip(v, 40),
};

async function handleAdmin(req, res, url) {
  if (!validSession(req)) return send(res, 401, { error: 'Not signed in' });
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'panel') return send(res, 403, { error: 'Forbidden' });
  const m = /^\/api\/admin\/leads(?:\/(\d+))?(?:\/(notes|confirm-email))?$/.exec(url.pathname);
  if (url.pathname === '/api/admin/stats') {
    const out = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const r of q.counts.all()) out[r.status] = r.n;
    return send(res, 200, out);
  }
  if (!m) return send(res, 404, { error: 'Not found' });
  const id = m[1] ? Number(m[1]) : null;
  if (!id && req.method === 'GET') {
    const status = url.searchParams.get('status');
    const term = clip(url.searchParams.get('q'), 60);
    let sql = 'SELECT id,created_at,name,phone,town,service,size,status,price,scheduled_start FROM leads WHERE 1=1';
    const args = [];
    if (STATUSES.includes(status)) { sql += ' AND status = ?'; args.push(status); }
    if (term) { sql += ' AND (name LIKE ? OR phone LIKE ? OR town LIKE ? OR email LIKE ?)'; args.push(...Array(4).fill(`%${term}%`)); }
    return send(res, 200, db.prepare(sql + ' ORDER BY id DESC LIMIT 300').all(...args));
  }
  if (!id) return send(res, 405, { error: 'Method not allowed' });
  const lead = q.get.get(id);
  if (!lead) return send(res, 404, { error: 'No such lead' });
  if (req.method === 'GET') return send(res, 200, { ...lead, events: q.events.all(id) });
  let d;
  try { d = await readJson(req); } catch { return send(res, 400, { error: 'Bad request' }); }
  if (req.method === 'POST' && m[2] === 'notes') {
    const body = clip(d.body, 2000);
    if (!body) return send(res, 400, { error: 'Empty note' });
    q.event.run(id, 'note', body);
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && m[2] === 'confirm-email') {
    if (!lead.email || !lead.scheduled_start) return send(res, 400, { error: 'Needs an email and a start time' });
    const r = await sendMail(lead.email, confirmEmail(lead));
    q.event.run(id, 'email', r.ok ? `Confirmation emailed to ${lead.email}` : `Confirmation email FAILED: ${r.error}`);
    return send(res, r.ok ? 200 : 502, r.ok ? { ok: true } : { error: r.error });
  }
  if (req.method === 'PATCH') {
    const sets = []; const args = []; const changes = [];
    for (const [k, fn] of Object.entries(EDITABLE)) {
      if (!(k in d)) continue;
      const v = fn(d[k]);
      if (v === null && k !== 'price') return send(res, 400, { error: `Invalid ${k}` });
      if (String(v ?? '') === String(lead[k] ?? '')) continue;
      sets.push(`${k} = ?`); args.push(v === '' ? null : v);
      changes.push(k === 'status' ? `status: ${lead.status} -> ${v}` : `${k} updated`);
    }
    if (sets.length) {
      db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
      q.event.run(id, 'update', changes.join('; '));
    }
    const after = q.get.get(id);
    const becameConfirmed = after.status === 'confirmed' && (lead.status !== 'confirmed' || lead.scheduled_start !== after.scheduled_start);
    let mailNote = '';
    if (becameConfirmed && after.scheduled_start && after.email && mailEnabled && d.send_email !== false) {
      const r = await sendMail(after.email, confirmEmail(after));
      mailNote = r.ok ? `Confirmation emailed to ${after.email}` : `Confirmation email FAILED: ${r.error}`;
      q.event.run(id, 'email', mailNote);
    }
    let calNote = '';
    if (haEnabled && sets.length && (lead.status === 'confirmed' || after.status === 'confirmed')) {
      const r = await syncCalendar(after);
      if (!r.ok) calNote = `Calendar sync FAILED: ${r.error}`;
      else if (r.action !== 'none' && r.action !== 'kept') calNote = `Calendar event ${r.action}`;
      if (calNote) q.event.run(id, 'calendar', calNote);
    }
    return send(res, 200, { ...after, events: q.events.all(id), mail: [mailNote, calNote].filter(Boolean).join('. ') });
  }
  return send(res, 405, { error: 'Method not allowed' });
}

// ---- static panel ----
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const CSP = "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
function serveStatic(res, pathname) {
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return send(res, 404, 'Not found');
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex, nofollow' });
  res.end(fs.readFileSync(full));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (url.pathname === '/api/lead') {
      if (req.method === 'OPTIONS') return send(res, 204, '', corsFor(req));
      if (req.method === 'POST') return await handleLead(req, res);
      return send(res, 405, { error: 'Method not allowed' });
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req);
      if (limited('login:' + ip, 8, 900e3)) return send(res, 429, { error: 'Too many attempts. Try again later.' });
      let d; try { d = await readJson(req, 2000); } catch { return send(res, 400, { error: 'Bad request' }); }
      if (!safeEq(d.password ?? '', ADMIN_PASSWORD)) return send(res, 401, { error: 'Wrong password' });
      return send(res, 200, { ok: true }, { 'Set-Cookie': `tvm_session=${makeSession()}; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Strict` });
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') return send(res, 200, { ok: true }, { 'Set-Cookie': 'tvm_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict' });
    if (url.pathname === '/api/session') return send(res, validSession(req) ? 200 : 401, { ok: validSession(req) });
    if (url.pathname.startsWith('/api/admin/')) return await handleAdmin(req, res, url);
    if (req.method === 'GET') return serveStatic(res, url.pathname);
    send(res, 404, 'Not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Server error' });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, '0.0.0.0', () => console.log(`tvmountok-api listening on ${PORT}`));
}
export { server };
