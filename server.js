'use strict';
// Household Tracker — a tiny, dependency-free server for a shared household app.
// Data is stored in a single JSON file; both partners log in with a shared password.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const PASSWORD = process.env.APP_PASSWORD || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('household:' + PASSWORD).digest('hex');
const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE = 'ht_session';
const SESSION_DAYS = 180;

// ---------- Schema ----------
// Each field: [type, required]. Types: str, text, date, month, time, num, bool, enum:<a|b>, img
const SCHEMA = {
  cats: {
    name: ['str', true], breed: ['str'], sex: ['enum:|Female|Male'], birthday: ['date'],
    color: ['str'], microchip: ['str'], notes: ['text'], photo: ['img'],
  },
  weights: { catId: ['ref:cats', true], date: ['date', true], kg: ['num', true], notes: ['text'] },
  feedings: { catId: ['ref:cats', true], time: ['time', true], food: ['str'], amount: ['str'], notes: ['text'] },
  events: {
    catId: ['ref:cats', true], type: ['str', true], date: ['date', true], nextDue: ['date'], notes: ['text'],
  },
  transactions: {
    type: ['enum:income|expense', true], amount: ['num', true], month: ['month', true],
    date: ['date'], category: ['str'], description: ['str'],
  },
  groceries: {
    name: ['str', true], quantity: ['str'], note: ['str'], addedDate: ['date', true],
    bought: ['bool'], boughtDate: ['date'],
  },
};
const CAT_CHILDREN = ['weights', 'feedings', 'events'];
const DEFAULT_SETTINGS = { currency: '$' };

// ---------- Storage ----------
function emptyDb() {
  const db = { rev: 0, settings: { ...DEFAULT_SETTINGS } };
  for (const c of Object.keys(SCHEMA)) db[c] = [];
  return db;
}

function loadDb() {
  try {
    const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const base = emptyDb();
    for (const k of Object.keys(base)) if (db[k] === undefined) db[k] = base[k];
    db.settings = { ...DEFAULT_SETTINGS, ...db.settings };
    return db;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error('Could not read data file, refusing to start to avoid data loss:', e.message);
      process.exit(1);
    }
    return emptyDb();
  }
}

let db = loadDb();

function save() {
  db.rev++;
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------- Validation ----------
class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

const RE = {
  date: /^\d{4}-\d{2}-\d{2}$/,
  month: /^\d{4}-(0[1-9]|1[0-2])$/,
  time: /^([01]\d|2[0-3]):[0-5]\d$/,
};

function clean(collection, input, partial) {
  const schema = SCHEMA[collection];
  const out = {};
  for (const [field, [type, required]] of Object.entries(schema)) {
    let v = input[field];
    const missing = v === undefined || v === null || v === '';
    if (missing) {
      if (required && !partial) throw new HttpError(400, `"${field}" is required`);
      if (v !== undefined) out[field] = type === 'bool' ? false : type === 'num' ? null : '';
      continue;
    }
    if (type === 'str' || type === 'text') {
      v = String(v).trim().slice(0, type === 'text' ? 2000 : 200);
      if (required && !v) throw new HttpError(400, `"${field}" is required`);
    } else if (type === 'num') {
      v = Number(v);
      if (!Number.isFinite(v)) throw new HttpError(400, `"${field}" must be a number`);
      v = Math.round(v * 1000) / 1000;
    } else if (type === 'bool') {
      v = v === true || v === 'true' || v === 'on';
    } else if (type === 'img') {
      v = String(v);
      if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v) || v.length > 400_000) {
        throw new HttpError(400, 'Photo must be a small PNG/JPEG/WebP image');
      }
    } else if (type.startsWith('enum:')) {
      v = String(v);
      if (!type.slice(5).split('|').includes(v)) throw new HttpError(400, `"${field}" is invalid`);
    } else if (type.startsWith('ref:')) {
      v = String(v);
      if (!db[type.slice(4)].some((x) => x.id === v)) throw new HttpError(400, `"${field}" not found`);
    } else if (RE[type]) {
      v = String(v);
      if (!RE[type].test(v)) throw new HttpError(400, `"${field}" is not a valid ${type}`);
    }
    out[field] = v;
  }
  return out;
}

// ---------- Auth ----------
function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}

function makeToken(name) {
  const payload = Buffer.from(JSON.stringify({ name, exp: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  return payload + '.' + sign(payload);
}

function readToken(token) {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data.name : null;
  } catch { return null; }
}

function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function currentUser(req) {
  if (!PASSWORD) return readToken(getCookie(req, COOKIE)) || 'Guest';
  return readToken(getCookie(req, COOKIE));
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const failedLogins = new Map(); // ip -> { count, until }
function loginBlocked(ip) {
  const f = failedLogins.get(ip);
  return f && f.count >= 10 && f.until > Date.now();
}
function noteFailedLogin(ip) {
  const f = failedLogins.get(ip);
  if (!f || f.until < Date.now()) failedLogins.set(ip, { count: 1, until: Date.now() + 15 * 60e3 });
  else f.count++;
}

// ---------- HTTP helpers ----------
function send(res, status, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString());
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function newId() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

// ---------- API ----------
async function handleApi(req, res, pathname) {
  const method = req.method;
  const parts = pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const secure = req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === '1';
  const cookieAttrs = `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

  if (parts[0] === 'login' && method === 'POST') {
    const ip = req.socket.remoteAddress;
    if (loginBlocked(ip)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) throw new HttpError(400, 'Please enter your name');
    if (PASSWORD && !safeEqual(body.password || '', PASSWORD)) {
      noteFailedLogin(ip);
      throw new HttpError(401, 'Wrong password');
    }
    failedLogins.delete(ip);
    return send(res, 200, { name }, {
      'Set-Cookie': `${COOKIE}=${makeToken(name)}; ${cookieAttrs}; Max-Age=${SESSION_DAYS * 86400}`,
    });
  }
  if (parts[0] === 'logout' && method === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; ${cookieAttrs}; Max-Age=0` });
  }

  const user = currentUser(req);
  if (!user) throw new HttpError(401, 'Not logged in');

  // CSRF guard: state-changing requests must be JSON (browsers can't send that cross-site without CORS).
  if (method !== 'GET' && !(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new HttpError(415, 'Expected JSON');
  }

  if (parts[0] === 'me' && method === 'GET') return send(res, 200, { name: user, passwordProtected: !!PASSWORD });
  if (parts[0] === 'rev' && method === 'GET') return send(res, 200, { rev: db.rev });
  if (parts[0] === 'data' && method === 'GET') return send(res, 200, { db });

  if (parts[0] === 'settings' && method === 'PUT') {
    const body = await readBody(req);
    if (body.currency !== undefined) db.settings.currency = String(body.currency).trim().slice(0, 6) || '$';
    save();
    return send(res, 200, db.settings);
  }

  const [collection, id] = parts;
  if (!SCHEMA[collection]) throw new HttpError(404, 'Unknown endpoint');
  const list = db[collection];

  if (!id && method === 'POST') {
    const item = clean(collection, await readBody(req), false);
    const now = new Date().toISOString();
    const doc = { id: newId(), ...item, createdBy: user, createdAt: now, updatedAt: now };
    list.push(doc);
    save();
    return send(res, 201, doc);
  }

  const idx = id ? list.findIndex((x) => x.id === id) : -1;
  if (idx === -1) throw new HttpError(404, 'Not found');

  if (method === 'PUT') {
    const changes = clean(collection, await readBody(req), true);
    list[idx] = { ...list[idx], ...changes, updatedBy: user, updatedAt: new Date().toISOString() };
    save();
    return send(res, 200, list[idx]);
  }
  if (method === 'DELETE') {
    list.splice(idx, 1);
    if (collection === 'cats') for (const c of CAT_CHILDREN) db[c] = db[c].filter((x) => x.catId !== id);
    save();
    return send(res, 200, { ok: true });
  }
  throw new HttpError(405, 'Method not allowed');
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    serveStatic(req, res, pathname);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Household Tracker running on http://localhost:${PORT}`);
    if (!PASSWORD) console.warn('WARNING: APP_PASSWORD is not set — anyone who can reach this server can use it.');
  });
}

module.exports = { server };
