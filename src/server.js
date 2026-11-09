'use strict';
// HTTP server: JSON API + static frontend. Built on node:http with a tiny router (no framework).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { openDb } = require('./db');
const auth = require('./auth');
const { sanitizeHtml, htmlToText } = require('./sanitize');
const { importFile, ImportError } = require('./importers');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY_BYTES = 4 * 1024 * 1024; // fits a 2 MB file as base64 + JSON overhead
const MAX_TITLE_LEN = 200;
const MAX_CONTENT_LEN = 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.png': 'image/png',
};

// ---------- helpers ----------
function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

async function readJson(req) {
  const type = req.headers['content-type'] || '';
  // Requiring JSON on writes also blocks simple cross-site form posts (CSRF) alongside SameSite cookies.
  if (!type.includes('application/json')) throw new HttpError(415, 'Expected a JSON request body.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'Malformed JSON body.');
  }
}

function cleanTitle(raw) {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new HttpError(400, 'Title must be a string.');
  const title = raw.replace(/\s+/g, ' ').trim();
  if (!title) throw new HttpError(400, 'Title cannot be empty.');
  if (title.length > MAX_TITLE_LEN) throw new HttpError(400, `Title must be at most ${MAX_TITLE_LEN} characters.`);
  return title;
}

function cleanContent(raw) {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new HttpError(400, 'Content must be an HTML string.');
  if (raw.length > MAX_CONTENT_LEN) throw new HttpError(413, 'Document is too large (1 MB limit).');
  return sanitizeHtml(raw);
}

// ---------- access control ----------
/** Returns 'owner' | 'editor' | 'viewer' | null for a user on a document. */
function roleFor(db, docId, userId) {
  const row = db.prepare(
    `SELECT CASE WHEN d.owner_id = ? THEN 'owner' ELSE s.role END AS role
     FROM documents d LEFT JOIN document_shares s ON s.document_id = d.id AND s.user_id = ?
     WHERE d.id = ?`
  ).get(userId, userId, docId);
  return row ? row.role : null;
}

function requireRole(db, docId, user, allowed) {
  const role = roleFor(db, docId, user.id);
  // Unknown and inaccessible documents look identical, so IDs can't be probed.
  if (!role) throw new HttpError(404, 'Document not found.');
  if (!allowed.includes(role)) {
    throw new HttpError(403, role === 'viewer'
      ? 'You have view-only access to this document.'
      : 'Only the owner can do that.');
  }
  return role;
}

function docSummary(row) {
  return {
    id: row.id, title: row.title, updatedAt: row.updated_at, createdAt: row.created_at,
    owner: { id: row.owner_id, name: row.owner_name, email: row.owner_email },
    role: row.role, preview: htmlToText(row.content_html).slice(0, 140),
  };
}

function loadDoc(db, docId, user) {
  const row = db.prepare(
    `SELECT d.*, u.name AS owner_name, u.email AS owner_email FROM documents d
     JOIN users u ON u.id = d.owner_id WHERE d.id = ?`
  ).get(docId);
  const role = roleFor(db, docId, user.id);
  const doc = {
    id: row.id, title: row.title, contentHtml: row.content_html, version: row.version,
    source: row.source, createdAt: row.created_at, updatedAt: row.updated_at,
    owner: { id: row.owner_id, name: row.owner_name, email: row.owner_email }, role,
  };
  if (role === 'owner') doc.shares = listShares(db, docId);
  return doc;
}

function listShares(db, docId) {
  return db.prepare(
    `SELECT u.id, u.email, u.name, s.role FROM document_shares s JOIN users u ON u.id = s.user_id
     WHERE s.document_id = ? ORDER BY u.name`
  ).all(docId).map((r) => ({ userId: r.id, email: r.email, name: r.name, role: r.role }));
}

function createDocument(db, ownerId, { title, html, source = null }) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO documents (id, owner_id, title, content_html, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, ownerId, title, html, source, now, now);
  return id;
}

// ---------- routes ----------
function buildRoutes(db) {
  const routes = [];
  const add = (method, pattern, handler, { public: isPublic = false } = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, isPublic });
  };

  add('GET', '/api/health', () => ({ ok: true }), { public: true });

  add('POST', '/api/login', async ({ req, res }) => {
    const { email, password } = await readJson(req);
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      throw new HttpError(400, 'Email and password are required.');
    }
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
    if (!user || !auth.verifyPassword(password, user.password_hash)) {
      throw new HttpError(401, 'Incorrect email or password.');
    }
    const token = auth.createSession(db, user.id);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie',
      `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${auth.SESSION_TTL_MS / 1000}${secure}`);
    return { user: { id: user.id, email: user.email, name: user.name } };
  }, { public: true });

  add('POST', '/api/logout', ({ req, res, token }) => {
    auth.destroySession(db, token);
    res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return { ok: true };
  }, { public: true });

  add('GET', '/api/me', ({ user }) => ({ user }));

  add('GET', '/api/users', ({ user }) => ({
    users: db.prepare('SELECT id, email, name FROM users WHERE id != ? ORDER BY name').all(user.id),
  }));

  add('GET', '/api/documents', ({ user }) => {
    const owned = db.prepare(
      `SELECT d.*, u.name AS owner_name, u.email AS owner_email, 'owner' AS role FROM documents d
       JOIN users u ON u.id = d.owner_id WHERE d.owner_id = ? ORDER BY d.updated_at DESC`
    ).all(user.id);
    const shared = db.prepare(
      `SELECT d.*, u.name AS owner_name, u.email AS owner_email, s.role AS role FROM document_shares s
       JOIN documents d ON d.id = s.document_id JOIN users u ON u.id = d.owner_id
       WHERE s.user_id = ? ORDER BY d.updated_at DESC`
    ).all(user.id);
    return { owned: owned.map(docSummary), shared: shared.map(docSummary) };
  });

  add('POST', '/api/documents', async ({ req, res, user }) => {
    const body = await readJson(req);
    const title = cleanTitle(body.title ?? 'Untitled document');
    const html = cleanContent(body.contentHtml ?? '') || '';
    const id = createDocument(db, user.id, { title, html });
    res.statusCode = 201;
    return { document: loadDoc(db, id, user) };
  });

  add('POST', '/api/documents/import', async ({ req, res, user }) => {
    const { filename, dataBase64 } = await readJson(req);
    if (typeof filename !== 'string' || typeof dataBase64 !== 'string') {
      throw new HttpError(400, 'filename and dataBase64 are required.');
    }
    let result;
    try {
      result = importFile(filename, Buffer.from(dataBase64, 'base64'));
    } catch (err) {
      if (err instanceof ImportError) throw new HttpError(422, err.message);
      throw new HttpError(422, 'Could not read that file. Is it a valid .txt, .md or .docx?');
    }
    const source = `upload:${filename.replace(/^.*[\\/]/, '').slice(0, 200)}`;
    const id = createDocument(db, user.id, { title: result.title, html: result.html, source });
    res.statusCode = 201;
    return { document: loadDoc(db, id, user) };
  });

  add('GET', '/api/documents/:id', ({ params, user }) => {
    requireRole(db, params.id, user, ['owner', 'editor', 'viewer']);
    return { document: loadDoc(db, params.id, user) };
  });

  add('PATCH', '/api/documents/:id', async ({ req, params, user }) => {
    requireRole(db, params.id, user, ['owner', 'editor']);
    const body = await readJson(req);
    const title = cleanTitle(body.title);
    const html = cleanContent(body.contentHtml);
    if (title === undefined && html === undefined) throw new HttpError(400, 'Nothing to update.');
    if (!Number.isInteger(body.baseVersion)) throw new HttpError(400, 'baseVersion (integer) is required.');

    // Optimistic concurrency: only apply if nobody saved since this client loaded the doc.
    const result = db.prepare(
      `UPDATE documents SET
         title = COALESCE(?, title), content_html = COALESCE(?, content_html),
         version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?`
    ).run(title ?? null, html ?? null, new Date().toISOString(), params.id, body.baseVersion);
    if (result.changes === 0) {
      const current = loadDoc(db, params.id, user);
      const err = new HttpError(409, 'This document was changed by someone else since you opened it.');
      err.extra = { document: current };
      throw err;
    }
    return { document: loadDoc(db, params.id, user) };
  });

  add('DELETE', '/api/documents/:id', ({ params, user }) => {
    requireRole(db, params.id, user, ['owner']);
    db.prepare('DELETE FROM documents WHERE id = ?').run(params.id);
    return { ok: true };
  });

  add('POST', '/api/documents/:id/shares', async ({ req, params, user }) => {
    requireRole(db, params.id, user, ['owner']);
    const { email, role } = await readJson(req);
    if (typeof email !== 'string' || !email.trim()) throw new HttpError(400, 'Email is required.');
    if (!['viewer', 'editor'].includes(role)) throw new HttpError(400, 'Role must be "viewer" or "editor".');
    const target = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase());
    if (!target) throw new HttpError(404, `No user with email ${email.trim()}.`);
    if (target.id === user.id) throw new HttpError(400, 'You already own this document.');
    db.prepare(
      `INSERT INTO document_shares (document_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (document_id, user_id) DO UPDATE SET role = excluded.role`
    ).run(params.id, target.id, role, new Date().toISOString());
    return { shares: listShares(db, params.id) };
  });

  add('DELETE', '/api/documents/:id/shares/:userId', ({ params, user }) => {
    requireRole(db, params.id, user, ['owner']);
    db.prepare('DELETE FROM document_shares WHERE document_id = ? AND user_id = ?')
      .run(params.id, Number(params.userId));
    return { shares: listShares(db, params.id) };
  });

  return routes;
}

// ---------- static files ----------
function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403).end(); return; }
  if (urlPath === '/' || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, 'index.html'); // SPA fallback
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    // Defence in depth: even if sanitizing missed something, inline script would not run.
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
  });
  fs.createReadStream(filePath).pipe(res);
}

// ---------- app ----------
function createApp({ dbPath } = {}) {
  const db = openDb(dbPath || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db'));
  const routes = buildRoutes(db);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed.' });
      return serveStatic(req, res);
    }

    try {
      let match = null;
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method === req.method) { match = { route: r, m }; break; }
      }
      if (!match) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed.' : 'Not found.');

      const { route, m } = match;
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const token = auth.parseCookies(req.headers.cookie).session;
      const user = auth.getSessionUser(db, token);
      if (!route.isPublic && !user) throw new HttpError(401, 'Please sign in.');

      const result = await route.handler({ req, res, params, user, token });
      sendJson(res, res.statusCode && res.statusCode !== 200 ? res.statusCode : 200, result);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message, ...(err.extra || {}) });
      } else {
        console.error(err);
        sendJson(res, 500, { error: 'Something went wrong on the server.' });
      }
    }
  });

  server.on('close', () => db.close());
  return { server, db };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { server } = createApp();
  server.listen(port, () => console.log(`Ajaia Docs running at http://localhost:${port}`));
}

module.exports = { createApp };
