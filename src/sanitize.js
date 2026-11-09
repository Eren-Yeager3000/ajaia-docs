'use strict';
// Allowlist HTML sanitizer for document bodies.
//
// Documents are rendered into other users' browsers when shared, so stored HTML must never be able
// to run script. Strategy: keep only a small set of formatting tags, strip ALL attributes, drop
// dangerous elements together with their content, and escape any stray text characters.

const ALLOWED = new Set(['p', 'br', 'h1', 'h2', 'h3', 'strong', 'em', 'u', 's', 'ul', 'ol', 'li', 'blockquote']);
const RENAME = { b: 'strong', i: 'em', strike: 's', del: 's', div: 'p', h4: 'h3', h5: 'h3', h6: 'h3' };
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'svg', 'math',
  'head', 'title', 'textarea', 'select', 'button',
]);
const VOID = new Set(['br']);

const TOKEN_RE = /<!--[\s\S]*?(?:-->|$)|<\/?[a-zA-Z][^>]*>?|[^<]+|</g;
const TAG_RE = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/;

function escapeText(text) {
  return text
    .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sanitizeHtml(input) {
  const html = String(input ?? '');
  let out = '';
  let dropping = null; // name of the element whose content we're skipping
  let dropDepth = 0;

  for (const [token] of html.matchAll(TOKEN_RE)) {
    if (token.startsWith('<!--')) continue;

    const m = token.length > 1 ? TAG_RE.exec(token) : null;
    if (!m) {
      if (!dropping) out += escapeText(token);
      continue;
    }

    const closing = m[1] === '/';
    let name = m[2].toLowerCase();

    if (dropping) {
      if (name === dropping) dropDepth += closing ? -1 : 1;
      if (dropDepth === 0) dropping = null;
      continue;
    }
    if (DROP_WITH_CONTENT.has(name)) {
      if (!closing && !token.endsWith('/>')) { dropping = name; dropDepth = 1; }
      continue;
    }

    name = RENAME[name] || name;
    if (!ALLOWED.has(name)) continue; // unknown tag: drop the tag, keep its text
    if (VOID.has(name)) { if (!closing) out += `<${name}>`; continue; }
    out += closing ? `</${name}>` : `<${name}>`;
  }
  // Empty blocks collapse to zero height in the browser; keep them as visible blank lines.
  return out.replace(/<(p|h1|h2|h3|li)><\/\1>/g, '<$1><br></$1>');
}

/** Plain-text view of sanitized HTML (used for previews / emptiness checks). */
function htmlToText(html) {
  return String(html)
    .replace(/<(br|\/p|\/h[1-3]|\/li|\/blockquote)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = { sanitizeHtml, htmlToText, escapeHtml };
