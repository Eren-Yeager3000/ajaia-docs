'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { importFile, markdownToHtml, ImportError } = require('../src/importers');
const { sanitizeHtml } = require('../src/sanitize');

test('.docx import keeps headings, inline formatting and both list kinds', () => {
  // Fixture generated with the `docx` npm package (a real Word-compatible file).
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures', 'launch-brief.docx'));
  const { title, html } = importFile('launch-brief.docx', buf);
  assert.equal(title, 'launch-brief');
  assert.equal(html,
    '<h1>Launch Brief</h1>' +
    '<p><strong>Bold</strong> and <em>italic</em> and <u>underlined</u> &amp; &lt;escaped&gt;</p>' +
    '<h2>Checklist</h2><ul><li>First bullet</li><li>Second bullet</li></ul>' +
    '<ol><li>Step one</li><li>Step two</li></ol>');
});

test('corrupt .docx gives a friendly ImportError', () => {
  assert.throws(() => importFile('broken.docx', Buffer.from('not a zip at all')), ImportError);
});

test('.txt import turns blank-line blocks into paragraphs and escapes HTML', () => {
  const { html } = importFile('notes.txt', Buffer.from('Hello <b>world</b>\nline two\n\nSecond para'));
  assert.equal(html, '<p>Hello &lt;b&gt;world&lt;/b&gt;<br>line two</p><p>Second para</p>');
});

test('markdown subset: headings, emphasis, ordered lists, quotes', () => {
  assert.equal(
    markdownToHtml('## Title\n*it* and __bold__\n\n1. a\n2. b\n\n> quoted'),
    '<h2>Title</h2><p><em>it</em> and <strong>bold</strong></p><ol><li>a</li><li>b</li></ol><blockquote>quoted</blockquote>');
});

test('rejects unsupported, empty and oversized files', () => {
  assert.throws(() => importFile('a.pdf', Buffer.from('x')), /Unsupported file type/);
  assert.throws(() => importFile('a.txt', Buffer.alloc(0)), /empty/);
  assert.throws(() => importFile('a.txt', Buffer.alloc(2 * 1024 * 1024 + 1, 97)), /2 MB/);
});

test('sanitizer strips attributes and dangerous elements but keeps formatting', () => {
  assert.equal(sanitizeHtml('<div style="color:red">x</div><b>y</b><i>z</i>'), '<p>x</p><strong>y</strong><em>z</em>');
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)">link</a>'), 'link');
  assert.equal(sanitizeHtml('<style>p{}</style><svg><script>x</script></svg>ok'), 'ok');
  assert.equal(sanitizeHtml('a < b && c'), 'a &lt; b &amp;&amp; c');
  assert.equal(sanitizeHtml('<p>unterminated <script'), '<p>unterminated ');
});
