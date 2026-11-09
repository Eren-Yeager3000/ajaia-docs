'use strict';
// End-to-end API tests: boots the real server on a random port with a fresh SQLite file.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/server');

let server;
let baseUrl;
let tmpDir;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ajaia-docs-'));
  ({ server } = createApp({ dbPath: path.join(tmpDir, 'test.db') }));
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Minimal cookie-aware client, one per simulated user. */
function client() {
  let cookie = '';
  return async function call(method, url, body) {
    const res = await fetch(baseUrl + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}

async function login(email) {
  const c = client();
  const res = await c('POST', '/api/login', { email, password: 'demo1234' });
  assert.equal(res.status, 200, `login failed for ${email}`);
  return c;
}

test('rejects unauthenticated access and bad credentials', async () => {
  const anon = client();
  assert.equal((await anon('GET', '/api/documents')).status, 401);
  const bad = await anon('POST', '/api/login', { email: 'alice@ajaia.test', password: 'wrong' });
  assert.equal(bad.status, 401);
  assert.match(bad.body.error, /incorrect/i);
});

test('owner can create, rename, edit and reopen a document with formatting preserved', async () => {
  const alice = await login('alice@ajaia.test');
  const created = await alice('POST', '/api/documents', { title: 'Roadmap' });
  assert.equal(created.status, 201);
  const { id, version } = created.body.document;

  const html = '<h1>Plan</h1><p><strong>Bold</strong> <em>it</em> <u>under</u></p><ul><li>one</li></ul><ol><li>two</li></ol>';
  const saved = await alice('PATCH', `/api/documents/${id}`, { title: 'Roadmap v2', contentHtml: html, baseVersion: version });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.document.version, version + 1);

  const reopened = await alice('GET', `/api/documents/${id}`);
  assert.equal(reopened.body.document.title, 'Roadmap v2');
  assert.equal(reopened.body.document.contentHtml, html);
});

test('sharing: editor can edit, viewer cannot, strangers cannot see it at all', async () => {
  const alice = await login('alice@ajaia.test');
  const bob = await login('bob@ajaia.test');
  const carol = await login('carol@ajaia.test');

  const { id, version } = (await alice('POST', '/api/documents', { title: 'Shared spec' })).body.document;

  // Before sharing, Bob gets a 404 (no existence leak) and it's not in his list.
  assert.equal((await bob('GET', `/api/documents/${id}`)).status, 404);

  assert.equal((await alice('POST', `/api/documents/${id}/shares`, { email: 'bob@ajaia.test', role: 'editor' })).status, 200);
  assert.equal((await alice('POST', `/api/documents/${id}/shares`, { email: 'carol@ajaia.test', role: 'viewer' })).status, 200);

  // Bob sees it under "shared", not "owned".
  const bobList = (await bob('GET', '/api/documents')).body;
  assert.ok(bobList.shared.some((d) => d.id === id && d.role === 'editor'));
  assert.ok(!bobList.owned.some((d) => d.id === id));

  // Editor can save.
  const edit = await bob('PATCH', `/api/documents/${id}`, { contentHtml: '<p>Bob was here</p>', baseVersion: version });
  assert.equal(edit.status, 200);

  // Viewer can read but not write, and cannot reshare.
  const carolView = await carol('GET', `/api/documents/${id}`);
  assert.equal(carolView.body.document.role, 'viewer');
  assert.equal(carolView.body.document.contentHtml, '<p>Bob was here</p>');
  assert.equal((await carol('PATCH', `/api/documents/${id}`, { contentHtml: '<p>x</p>', baseVersion: 2 })).status, 403);
  assert.equal((await carol('POST', `/api/documents/${id}/shares`, { email: 'bob@ajaia.test', role: 'editor' })).status, 403);

  // Only the owner sees the share list; editors can't delete.
  assert.equal(carolView.body.document.shares, undefined);
  assert.equal((await bob('DELETE', `/api/documents/${id}`)).status, 403);

  // Revoking access takes effect immediately.
  const { shares } = (await alice('GET', `/api/documents/${id}`)).body.document;
  const bobId = shares.find((s) => s.email === 'bob@ajaia.test').userId;
  await alice('DELETE', `/api/documents/${id}/shares/${bobId}`);
  assert.equal((await bob('GET', `/api/documents/${id}`)).status, 404);
});

test('share validation: unknown user, self-share and bad role are rejected', async () => {
  const alice = await login('alice@ajaia.test');
  const { id } = (await alice('POST', '/api/documents', {})).body.document;
  assert.equal((await alice('POST', `/api/documents/${id}/shares`, { email: 'nobody@x.test', role: 'viewer' })).status, 404);
  assert.equal((await alice('POST', `/api/documents/${id}/shares`, { email: 'alice@ajaia.test', role: 'viewer' })).status, 400);
  assert.equal((await alice('POST', `/api/documents/${id}/shares`, { email: 'bob@ajaia.test', role: 'admin' })).status, 400);
});

test('stale saves are rejected with 409 instead of silently overwriting', async () => {
  const alice = await login('alice@ajaia.test');
  const bob = await login('bob@ajaia.test');
  const { id, version } = (await alice('POST', '/api/documents', { title: 'Race' })).body.document;
  await alice('POST', `/api/documents/${id}/shares`, { email: 'bob@ajaia.test', role: 'editor' });

  assert.equal((await alice('PATCH', `/api/documents/${id}`, { contentHtml: '<p>A</p>', baseVersion: version })).status, 200);
  const stale = await bob('PATCH', `/api/documents/${id}`, { contentHtml: '<p>B</p>', baseVersion: version });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.document.contentHtml, '<p>A</p>', '409 returns the latest version so the client can recover');
});

test('stored HTML is sanitized (no script, no event handlers)', async () => {
  const alice = await login('alice@ajaia.test');
  const { id, version } = (await alice('POST', '/api/documents', {})).body.document;
  const evil = '<p onclick="steal()">Hi<script>alert(1)</script><img src=x onerror=alert(2)></p><iframe src="//evil"></iframe>';
  const res = await alice('PATCH', `/api/documents/${id}`, { contentHtml: evil, baseVersion: version });
  assert.equal(res.body.document.contentHtml, '<p>Hi</p>');
});

test('validation errors return clear 4xx responses', async () => {
  const alice = await login('alice@ajaia.test');
  const { id, version } = (await alice('POST', '/api/documents', {})).body.document;
  assert.equal((await alice('PATCH', `/api/documents/${id}`, { title: '   ', baseVersion: version })).status, 400);
  assert.equal((await alice('PATCH', `/api/documents/${id}`, { title: 'x'.repeat(201), baseVersion: version })).status, 400);
  assert.equal((await alice('PATCH', `/api/documents/${id}`, { title: 'ok' })).status, 400); // missing baseVersion
});

test('importing a markdown file creates a new owned, formatted document', async () => {
  const alice = await login('alice@ajaia.test');
  const md = '# Meeting notes\n\nWe agreed on **three** things:\n\n- scope\n- owners\n- dates\n';
  const res = await alice('POST', '/api/documents/import', {
    filename: 'meeting-notes.md', dataBase64: Buffer.from(md).toString('base64'),
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.document.title, 'meeting-notes');
  assert.equal(res.body.document.role, 'owner');
  assert.equal(res.body.document.contentHtml,
    '<h1>Meeting notes</h1><p>We agreed on <strong>three</strong> things:</p><ul><li>scope</li><li>owners</li><li>dates</li></ul>');

  const bad = await alice('POST', '/api/documents/import', { filename: 'virus.exe', dataBase64: 'AAAA' });
  assert.equal(bad.status, 422);
  assert.match(bad.body.error, /Supported: \.txt, \.md, \.docx/);
});
