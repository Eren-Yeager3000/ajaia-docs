// Browser smoke test of the main flows (login, edit, format, share, viewer, conflict, import).
// Optional: needs Playwright (npm i -D playwright && npx playwright install chromium).
// Usage: npm start (fresh DB), then: node scripts/e2e-smoke.js [screenshotDir]
const { chromium } = require('playwright');
const B = process.env.BASE_URL || 'http://localhost:3000';
const shots = process.argv[2] || 'docs/screenshots';
const path = require('path');
const FIXTURE = path.join(__dirname, '..', 'test', 'fixtures', 'launch-brief.docx');
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const mk = async () => { const c = await browser.newContext({ viewport: { width: 1280, height: 860 } }); const p = await c.newPage(); p.on('console', m => m.type()==='error' && errors.push(m.text())); p.on('pageerror', e => errors.push(String(e))); return p; };
  const login = async (p, who) => { await p.goto(B); await p.click(`.chip[data-email="${who}@ajaia.test"]`); await p.click('#login-form button[type=submit]'); await p.waitForSelector('#view-list:not([hidden])'); };

  const a = await mk();
  await a.goto(B); await a.screenshot({ path: `${shots}/01-login.png` });
  await login(a, 'alice');
  await a.waitForSelector('.doc-card'); await a.screenshot({ path: `${shots}/02-document-list-alice.png` });

  // Create + rename + format
  await a.click('#new-doc-btn'); await a.waitForSelector('#view-editor:not([hidden])');
  await a.waitForTimeout(200);
  await a.fill('#doc-title', 'Team Offsite Plan');
  await a.click('#editor');
  await a.selectOption('#block-select', 'h1'); await a.keyboard.type('Offsite Plan');
  await a.keyboard.press('Enter');
  await a.selectOption('#block-select', 'p');
  await a.keyboard.type('This is ');
  await a.click('button[data-cmd=bold]'); await a.keyboard.type('important'); await a.click('button[data-cmd=bold]');
  await a.keyboard.type(' and ');
  await a.click('button[data-cmd=italic]'); await a.keyboard.type('fun'); await a.click('button[data-cmd=italic]');
  await a.keyboard.type(' and ');
  await a.click('button[data-cmd=underline]'); await a.keyboard.type('on time'); await a.click('button[data-cmd=underline]');
  await a.keyboard.press('Enter');
  await a.click('button[data-cmd=insertUnorderedList]'); await a.keyboard.type('Book venue'); await a.keyboard.press('Enter'); await a.keyboard.type('Send invites');
  await a.keyboard.press('Enter'); await a.keyboard.press('Enter');
  await a.click('button[data-cmd=insertOrderedList]'); await a.keyboard.type('Day one'); await a.keyboard.press('Enter'); await a.keyboard.type('Day two');
  await a.waitForFunction(() => document.querySelector('#save-status').textContent === 'All changes saved', null, { timeout: 5000 });
  await a.evaluate(() => window.scrollTo(0, 0)); await a.screenshot({ path: `${shots}/03-editor-formatting.png` });
  const url = a.url();
  await a.reload(); await a.waitForSelector('#editor h1');
  const html = await a.$eval('#editor', e => e.innerHTML);
  const title = await a.$eval('#doc-title', e => e.value);
  console.log('AFTER RELOAD title=', title, '\nhtml=', html);

  // Share with bob (viewer) and carol (editor)
  await a.click('#share-btn'); await a.fill('#share-email', 'bob@ajaia.test'); await a.selectOption('#share-role', 'viewer'); await a.click('#share-submit');
  await a.waitForSelector('#share-list li:nth-child(2)');
  await a.fill('#share-email', 'carol@ajaia.test'); await a.selectOption('#share-role', 'editor'); await a.click('#share-submit');
  await a.waitForSelector('#share-list li:nth-child(3)');
  await a.fill('#share-email', 'nobody@ajaia.test'); await a.click('#share-submit'); await a.waitForSelector('#share-error:not([hidden])');
  console.log('share error shown:', await a.$eval('#share-error', e => e.textContent));
  await a.screenshot({ path: `${shots}/04-share-dialog.png` });
  await a.click('#share-close');

  // Bob: shared list + read-only
  const b = await mk(); await login(b, 'bob'); await b.waitForSelector('#shared-list .doc-card');
  await b.screenshot({ path: `${shots}/05-document-list-bob-shared.png` });
  await b.goto(url); await b.waitForSelector('#editor h1');
  console.log('bob editable=', await b.$eval('#editor', e => e.contentEditable), 'badge=', await b.$eval('#role-badge', e => e.textContent));
  await b.screenshot({ path: `${shots}/06-viewer-readonly.png` });

  // Carol edits; Alice (stale) then gets conflict
  const c = await mk(); await login(c, 'carol'); await c.goto(url); await c.waitForSelector('#editor h1');
  await c.click('#editor h1'); await c.keyboard.press('End'); await c.keyboard.type(' (Carol edit)');
  await c.waitForFunction(() => document.querySelector('#save-status').textContent === 'All changes saved');
  await a.click('#editor h1'); await a.keyboard.press('End'); await a.keyboard.type('!');
  await a.waitForSelector('#banner.danger', { timeout: 5000 });
  console.log('conflict banner:', await a.$eval('#banner', e => e.textContent));
  await a.screenshot({ path: `${shots}/07-edit-conflict.png` });
  await a.click('#banner button:last-child'); await a.waitForTimeout(200);
  console.log('after load latest h1:', await a.$eval('#editor h1', e => e.textContent));

  // Import docx
  await a.goto(B + '/#/'); await a.waitForSelector('#owned-list .doc-card');
  await a.setInputFiles('#import-input', FIXTURE);
  await a.waitForSelector('#editor h2'); await a.waitForTimeout(300);
  console.log('imported title:', await a.$eval('#doc-title', e => e.value));
  await a.evaluate(() => window.scrollTo(0, 0)); await a.screenshot({ path: `${shots}/08-imported-docx.png` });
  // unsupported file
  await a.goto(B + '/#/'); await a.waitForSelector('#owned-list .doc-card');
  await a.setInputFiles('#import-input', { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('x') });
  console.log('unsupported msg:', await a.$eval('#list-error', e => e.textContent));
  await a.screenshot({ path: `${shots}/09-list-after-import.png` });

  // stranger: bob can't open carol-less private doc
  await b.goto(B + '/#/doc/does-not-exist'); await b.waitForSelector('#banner:not([hidden])');
  console.log('404 banner:', await b.$eval('#banner', e => e.textContent));
  console.log('JS errors:', errors);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
