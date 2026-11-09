'use strict';
// Ajaia Docs frontend: a tiny hash-routed SPA (login → document list → editor) in plain JS.

const $ = (sel) => document.querySelector(sel);
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const SUPPORTED_EXT = ['.txt', '.md', '.markdown', '.docx'];
const AUTOSAVE_DELAY_MS = 800;

const state = {
  user: null,
  doc: null,            // currently open document
  contentDirty: false,
  titleDirty: false,
  saving: null,         // in-flight save promise
  saveTimer: null,
  blocked: false,       // editing blocked after a conflict / revoked access
};

// ---------------------------------------------------------------- API
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    const err = new Error('Network error. Check your connection.');
    err.status = 0;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    if (res.status === 401 && url !== '/api/login') { state.user = null; showLogin(); }
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------- UI helpers
function showView(id) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== id;
  $('#topbar').hidden = id === 'view-login';
}

function setText(el, text) { el.textContent = text; }

function showError(el, message) {
  el.textContent = message || '';
  el.hidden = !message;
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function timeAgo(iso) {
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs > 1 ? 's' : ''} ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

const ROLE_LABEL = { owner: 'Owner', editor: 'Can edit', viewer: 'View only' };

// ---------------------------------------------------------------- Auth
function showLogin() {
  showView('view-login');
  $('#login-email').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#login-email').value.trim();
  const password = $('#login-password').value;
  if (!email || !password) return showError($('#login-error'), 'Enter your email and password.');
  const btn = e.submitter || $('#login-form button[type=submit]');
  btn.disabled = true;
  try {
    const { user } = await api('POST', '/api/login', { email, password });
    state.user = user;
    showError($('#login-error'), '');
    $('#login-password').value = '';
    afterLogin();
  } catch (err) {
    showError($('#login-error'), err.message);
  } finally {
    btn.disabled = false;
  }
});

for (const chip of document.querySelectorAll('.demo-list .chip')) {
  chip.addEventListener('click', () => {
    $('#login-email').value = chip.dataset.email;
    $('#login-password').value = 'demo1234';
    $('#login-password').focus();
  });
}

$('#logout-btn').addEventListener('click', async () => {
  await flushSave();
  await api('POST', '/api/logout').catch(() => {});
  state.user = null;
  location.hash = '#/';
  showLogin();
});

function afterLogin() {
  setText($('#current-user'), `${state.user.name} · ${state.user.email}`);
  route();
}

// ---------------------------------------------------------------- Router
async function route() {
  if (!state.user) return showLogin();
  const m = /^#\/doc\/([^/]+)$/.exec(location.hash);
  if (m) return openDocument(decodeURIComponent(m[1]));
  await flushSave();
  state.doc = null;
  return showList();
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- Document list
async function showList() {
  showView('view-list');
  showError($('#list-error'), '');
  try {
    const { owned, shared } = await api('GET', '/api/documents');
    renderDocList($('#owned-list'), owned, 'You have no documents yet. Create one or import a file.');
    renderDocList($('#shared-list'), shared, 'Nothing has been shared with you yet.');
  } catch (err) {
    if (err.status !== 401) showError($('#list-error'), err.message);
  }
}

function renderDocList(container, docs, emptyText) {
  container.replaceChildren();
  if (!docs.length) {
    container.append(el('li', { class: 'empty' }, emptyText));
    return;
  }
  for (const d of docs) {
    const isOwner = d.role === 'owner';
    const meta = el('div', { class: 'doc-meta' },
      el('span', { class: `badge badge-${d.role}` }, isOwner ? 'Owner' : ROLE_LABEL[d.role]),
      isOwner ? null : el('span', {}, `from ${d.owner.name}`),
      el('span', {}, `· ${timeAgo(d.updatedAt)}`),
    );
    container.append(el('li', {},
      el('a', { class: 'doc-card', href: `#/doc/${encodeURIComponent(d.id)}` },
        el('h3', {}, d.title),
        el('p', { class: 'preview' }, d.preview || 'Empty document'),
        meta,
      ),
    ));
  }
}

$('#new-doc-btn').addEventListener('click', async () => {
  try {
    const { document: doc } = await api('POST', '/api/documents', { title: 'Untitled document' });
    location.hash = `#/doc/${encodeURIComponent(doc.id)}`;
    setTimeout(() => { $('#doc-title').select(); }, 50);
  } catch (err) {
    showError($('#list-error'), err.message);
  }
});

$('#import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const ext = (/\.[^.]+$/.exec(file.name) || [''])[0].toLowerCase();
  if (!SUPPORTED_EXT.includes(ext)) {
    return showError($('#list-error'), `“${file.name}” isn’t supported. Please choose a .txt, .md or .docx file.`);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return showError($('#list-error'), `“${file.name}” is larger than the 2 MB limit.`);
  }
  showError($('#list-error'), '');
  toast(`Importing ${file.name}…`);
  try {
    const dataBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('Could not read the file.'));
      reader.readAsDataURL(file);
    });
    const { document: doc } = await api('POST', '/api/documents/import', { filename: file.name, dataBase64 });
    toast(`Imported “${file.name}” as a new document`);
    location.hash = `#/doc/${encodeURIComponent(doc.id)}`;
  } catch (err) {
    showError($('#list-error'), err.message);
  }
});

// ---------------------------------------------------------------- Editor
const editor = $('#editor');
const titleInput = $('#doc-title');

async function openDocument(id) {
  if (state.doc && state.doc.id === id) return;
  await flushSave();
  showView('view-editor');
  hideBanner();
  editor.innerHTML = '';
  titleInput.value = 'Loading…';
  setSaveStatus('');
  try {
    const { document: doc } = await api('GET', `/api/documents/${encodeURIComponent(id)}`);
    loadIntoEditor(doc);
  } catch (err) {
    if (err.status === 401) return;
    state.doc = null;
    titleInput.value = '';
    editor.contentEditable = 'false';
    showBanner(err.status === 404
      ? 'This document doesn’t exist, or you don’t have access to it.'
      : err.message, 'danger', [{ label: 'Back to documents', onclick: () => { location.hash = '#/'; } }]);
  }
}

function canEdit(doc) { return doc && (doc.role === 'owner' || doc.role === 'editor'); }

function loadIntoEditor(doc) {
  state.doc = doc;
  state.contentDirty = false;
  state.titleDirty = false;
  state.blocked = false;
  editor.innerHTML = doc.contentHtml || '';
  titleInput.value = doc.title;
  document.title = `${doc.title} – Ajaia Docs`;

  const editable = canEdit(doc);
  editor.contentEditable = editable ? 'true' : 'false';
  titleInput.disabled = doc.role !== 'owner' && doc.role !== 'editor';
  for (const c of $('#toolbar').querySelectorAll('button, select')) c.disabled = !editable;
  $('#share-btn').hidden = doc.role !== 'owner';
  $('#delete-btn').hidden = doc.role !== 'owner';

  const badge = $('#role-badge');
  badge.className = `badge badge-${doc.role}`;
  badge.textContent = ROLE_LABEL[doc.role];

  hideBanner();
  if (doc.role === 'viewer') {
    showBanner(`View only. ${doc.owner.name} shared this document with you. Ask them for edit access to make changes.`, 'info');
  } else if (doc.role === 'editor') {
    showBanner(`Shared with you by ${doc.owner.name}. You can edit, and changes save automatically.`, 'info');
  }
  setSaveStatus(editable ? `Saved ${timeAgo(doc.updatedAt)}` : '');
}

function setSaveStatus(text, isError = false) {
  const s = $('#save-status');
  s.textContent = text;
  s.classList.toggle('error', isError);
}

function showBanner(message, kind = '', actions = []) {
  const b = $('#banner');
  b.className = `banner ${kind}`;
  b.replaceChildren(el('span', {}, message), ...actions.map((a) =>
    el('button', { class: 'btn btn-secondary', onclick: a.onclick }, a.label)));
  b.hidden = false;
}
function hideBanner() { $('#banner').hidden = true; }

function scheduleSave() {
  if (!canEdit(state.doc) || state.blocked) return;
  setSaveStatus('Unsaved changes…');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(save, AUTOSAVE_DELAY_MS);
}

/** Saves pending title/content changes. Serialized: only one request in flight at a time. */
async function save() {
  clearTimeout(state.saveTimer);
  if (state.saving) { await state.saving; }
  const doc = state.doc;
  if (!doc || state.blocked || (!state.contentDirty && !state.titleDirty)) return;

  const body = { baseVersion: doc.version };
  if (state.contentDirty) body.contentHtml = editor.innerHTML;
  if (state.titleDirty) {
    const title = titleInput.value.trim();
    if (!title) { setSaveStatus('Title can’t be empty', true); return; }
    body.title = title;
  }
  state.contentDirty = false;
  state.titleDirty = false;
  setSaveStatus('Saving…');

  state.saving = (async () => {
    try {
      const { document: saved } = await api('PATCH', `/api/documents/${encodeURIComponent(doc.id)}`, body);
      if (state.doc !== doc) return;
      doc.version = saved.version;
      doc.title = saved.title;
      doc.updatedAt = saved.updatedAt;
      document.title = `${saved.title} – Ajaia Docs`;
      if (!state.contentDirty && !state.titleDirty) setSaveStatus('All changes saved');
    } catch (err) {
      if (state.doc !== doc) return;
      if (err.status === 409) {
        state.blocked = true;
        editor.contentEditable = 'false';
        setSaveStatus('Not saved', true);
        showBanner('Someone else saved a newer version while you were editing. Your latest change was not saved.', 'danger', [
          { label: 'Copy my version', onclick: () => navigator.clipboard?.writeText(editor.innerText).then(() => toast('Your text was copied to the clipboard')) },
          { label: 'Load latest version', onclick: () => loadIntoEditor(err.data.document) },
        ]);
      } else if (err.status === 403 || err.status === 404) {
        state.blocked = true;
        editor.contentEditable = 'false';
        setSaveStatus('Not saved', true);
        showBanner('Your access to this document changed, so edits can’t be saved.', 'danger',
          [{ label: 'Back to documents', onclick: () => { location.hash = '#/'; } }]);
      } else {
        // Transient failure (network / validation): keep the changes and retry.
        if (body.contentHtml !== undefined) state.contentDirty = true;
        if (body.title !== undefined) state.titleDirty = true;
        setSaveStatus(err.status === 0 ? 'Offline, retrying…' : err.message, true);
        if (err.status === 0 || err.status >= 500) state.saveTimer = setTimeout(save, 3000);
      }
    }
  })();
  await state.saving;
  state.saving = null;
  if (state.contentDirty || state.titleDirty) scheduleSave();
}

async function flushSave() {
  if (state.doc && (state.contentDirty || state.titleDirty) && !state.blocked) await save();
  else if (state.saving) await state.saving;
}

editor.addEventListener('input', () => {
  state.contentDirty = true;
  scheduleSave();
});

// Paste as plain text so foreign styles/markup don't leak into documents.
editor.addEventListener('paste', (e) => {
  e.preventDefault();
  const text = e.clipboardData.getData('text/plain');
  document.execCommand('insertText', false, text);
});

// Keep the doc structured as paragraphs rather than bare text/divs.
editor.addEventListener('focus', () => {
  document.execCommand('defaultParagraphSeparator', false, 'p');
  if (canEdit(state.doc) && editor.innerHTML.trim() === '') editor.innerHTML = '<p><br></p>';
});

editor.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && state.doc) { e.preventDefault(); save(); }
});

titleInput.addEventListener('input', () => { state.titleDirty = true; scheduleSave(); });
titleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); editor.focus(); }
});
titleInput.addEventListener('blur', () => {
  if (!titleInput.value.trim() && state.doc) { titleInput.value = state.doc.title; state.titleDirty = false; }
});

// Toolbar
const toolbar = $('#toolbar');
toolbar.addEventListener('mousedown', (e) => {
  if (e.target.closest('button')) e.preventDefault(); // keep the text selection in the editor
});
toolbar.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-cmd]');
  if (!btn || btn.disabled) return;
  editor.focus();
  document.execCommand(btn.dataset.cmd, false, null);
  if (btn.dataset.cmd === 'removeFormat') document.execCommand('formatBlock', false, '<p>');
  updateToolbarState();
  state.contentDirty = true;
  scheduleSave();
});
$('#block-select').addEventListener('change', (e) => {
  editor.focus();
  document.execCommand('formatBlock', false, `<${e.target.value}>`);
  state.contentDirty = true;
  scheduleSave();
});

function updateToolbarState() {
  const sel = document.getSelection();
  if (!sel.rangeCount || !editor.contains(sel.anchorNode)) return;
  for (const btn of toolbar.querySelectorAll('button[data-cmd]')) {
    const cmd = btn.dataset.cmd;
    if (['undo', 'redo', 'removeFormat'].includes(cmd)) continue;
    let on = false;
    try { on = document.queryCommandState(cmd); } catch { /* unsupported */ }
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  const block = String(document.queryCommandValue('formatBlock') || 'p').toLowerCase().replace(/[<>]/g, '');
  $('#block-select').value = ['h1', 'h2', 'h3'].includes(block) ? block : 'p';
}
document.addEventListener('selectionchange', updateToolbarState);

// Delete
$('#delete-btn').addEventListener('click', async () => {
  const doc = state.doc;
  if (!doc || !confirm(`Delete “${doc.title}”? This can’t be undone.`)) return;
  try {
    await api('DELETE', `/api/documents/${encodeURIComponent(doc.id)}`);
    state.doc = null;
    state.contentDirty = state.titleDirty = false;
    toast('Document deleted');
    location.hash = '#/';
  } catch (err) {
    toast(err.message);
  }
});

window.addEventListener('beforeunload', (e) => {
  if (state.contentDirty || state.titleDirty || state.saving) { e.preventDefault(); e.returnValue = ''; }
});

// ---------------------------------------------------------------- Sharing
const shareDialog = $('#share-dialog');

$('#share-btn').addEventListener('click', async () => {
  const doc = state.doc;
  if (!doc) return;
  setText($('#share-doc-title'), doc.title);
  showError($('#share-error'), '');
  $('#share-email').value = '';
  renderShares(doc.shares || []);
  shareDialog.showModal();
  $('#share-email').focus();
  try {
    const { users } = await api('GET', '/api/users');
    $('#user-options').replaceChildren(...users.map((u) => el('option', { value: u.email }, u.name)));
  } catch { /* suggestions are optional */ }
});

$('#share-close').addEventListener('click', () => shareDialog.close());

$('#share-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#share-email').value.trim();
  if (!email) return showError($('#share-error'), 'Enter the email of the person to share with.');
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return showError($('#share-error'), 'That doesn’t look like an email address.');
  await updateShare(email, $('#share-role').value);
  if ($('#share-error').hidden) $('#share-email').value = '';
});

async function updateShare(email, role) {
  const doc = state.doc;
  try {
    const { shares } = await api('POST', `/api/documents/${encodeURIComponent(doc.id)}/shares`, { email, role });
    doc.shares = shares;
    renderShares(shares);
    showError($('#share-error'), '');
    toast(`${email} ${role === 'editor' ? 'can now edit' : 'can now view'} this document`);
  } catch (err) {
    showError($('#share-error'), err.message);
  }
}

async function removeShare(share) {
  const doc = state.doc;
  try {
    const { shares } = await api('DELETE', `/api/documents/${encodeURIComponent(doc.id)}/shares/${share.userId}`);
    doc.shares = shares;
    renderShares(shares);
    toast(`Removed access for ${share.name}`);
  } catch (err) {
    showError($('#share-error'), err.message);
  }
}

function renderShares(shares) {
  const list = $('#share-list');
  const owner = state.doc.owner;
  list.replaceChildren(el('li', {},
    el('span', { class: 'who' }, `${owner.name} (you)`, el('small', {}, owner.email)),
    el('span', { class: 'badge badge-owner' }, 'Owner'),
  ));
  for (const s of shares) {
    const select = el('select', { 'aria-label': `Access for ${s.name}` },
      el('option', { value: 'editor' }, 'Can edit'),
      el('option', { value: 'viewer' }, 'Can view'));
    select.value = s.role;
    select.addEventListener('change', () => updateShare(s.email, select.value));
    list.append(el('li', {},
      el('span', { class: 'who' }, s.name, el('small', {}, s.email)),
      select,
      el('button', { type: 'button', class: 'btn btn-ghost danger', onclick: () => removeShare(s) }, 'Remove'),
    ));
  }
}

// ---------------------------------------------------------------- Boot
(async function boot() {
  try {
    const { user } = await api('GET', '/api/me');
    state.user = user;
    afterLogin();
  } catch {
    showLogin();
  }
})();
