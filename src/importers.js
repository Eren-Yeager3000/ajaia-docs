'use strict';
// Convert uploaded files (.txt, .md, .docx) into sanitized document HTML.
// Everything here is dependency-free; .docx is read with a tiny ZIP reader + zlib.

const zlib = require('node:zlib');
const { sanitizeHtml, escapeHtml } = require('./sanitize');

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_UNZIPPED_BYTES = 20 * 1024 * 1024; // zip-bomb guard for .docx
const SUPPORTED = ['.txt', '.md', '.markdown', '.docx'];

class ImportError extends Error {}

function extensionOf(filename) {
  const m = /\.[a-z0-9]+$/i.exec(String(filename || ''));
  return m ? m[0].toLowerCase() : '';
}

function titleFromFilename(filename) {
  const base = String(filename || 'Untitled').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  return base.trim().slice(0, 200) || 'Untitled';
}

/** @returns {{ title: string, html: string }} */
function importFile(filename, buffer) {
  const ext = extensionOf(filename);
  if (!SUPPORTED.includes(ext)) {
    throw new ImportError(`Unsupported file type "${ext || 'none'}". Supported: .txt, .md, .docx`);
  }
  if (buffer.length === 0) throw new ImportError('The file is empty.');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new ImportError('File is larger than the 2 MB limit.');

  let html;
  if (ext === '.docx') {
    html = docxToHtml(buffer);
  } else {
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (text.includes('\u0000')) throw new ImportError('This does not look like a text file.');
    html = ext === '.txt' ? textToHtml(text) : markdownToHtml(text);
  }
  return { title: titleFromFilename(filename), html: sanitizeHtml(html) || '<p></p>' };
}

// ---------- .txt ----------
function textToHtml(text) {
  return text
    .split(/\n{2,}/)
    .filter((block) => block.trim() !== '')
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

// ---------- .md (pragmatic subset: headings, lists, emphasis, quotes, paragraphs) ----------
function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|\W)_(?!\s)(.+?)_(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
}

function markdownToHtml(md) {
  const out = [];
  let para = [];
  let list = null; // { tag: 'ul'|'ol', items: [] }

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inlineMarkdown).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inlineMarkdown(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };

  let inFence = false;
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/^```/.test(line)) { flushPara(); flushList(); inFence = !inFence; continue; }
    if (inFence) { out.push(`<p>${escapeHtml(line) || '<br>'}</p>`); continue; }

    let m;
    if (line.trim() === '') { flushPara(); flushList(); continue; }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      flushPara(); flushList();
      const level = Math.min(m[1].length, 3);
      out.push(`<h${level}>${inlineMarkdown(m[2].replace(/\s#+$/, ''))}</h${level}>`);
      continue;
    }
    if (/^(\*\s*){3,}$|^(-\s*){3,}$/.test(line)) { flushPara(); flushList(); continue; } // hr
    if ((m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
      flushPara();
      const tag = /\d/.test(m[1]) ? 'ol' : 'ul';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push(m[2]);
      continue;
    }
    if ((m = /^>\s?(.*)$/.exec(line))) {
      flushPara(); flushList();
      out.push(`<blockquote>${inlineMarkdown(m[1])}</blockquote>`);
      continue;
    }
    if (list) flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return out.join('');
}

// ---------- .docx ----------
function readZipEntries(buf) {
  // Locate End Of Central Directory record (signature 0x06054b50), scanning back over a comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ImportError('This .docx file appears to be corrupted (not a ZIP archive).');

  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) {
      throw new ImportError('This .docx file appears to be corrupted.');
    }
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const size = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    entries.set(name, { method, compSize, size, localOffset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }

  return {
    has: (name) => entries.has(name),
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.size > MAX_UNZIPPED_BYTES) throw new ImportError('This .docx file is too large to import.');
      const lh = e.localOffset;
      if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) {
        throw new ImportError('This .docx file appears to be corrupted.');
      }
      const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
      const data = buf.subarray(start, start + e.compSize);
      if (e.method === 0) return data.toString('utf8');
      if (e.method === 8) {
        return zlib.inflateRawSync(data, { maxOutputLength: MAX_UNZIPPED_BYTES }).toString('utf8');
      }
      throw new ImportError('This .docx file uses an unsupported compression method.');
    },
  };
}

/** Map numId -> 'ol' | 'ul' using word/numbering.xml (first level's numFmt). */
function readListKinds(numberingXml) {
  const kinds = new Map();
  if (!numberingXml) return kinds;
  const abstractFmt = new Map();
  for (const [, id, body] of numberingXml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    const fmt = /<w:numFmt\b[^>]*w:val="([^"]+)"/.exec(body);
    abstractFmt.set(id, fmt ? fmt[1] : 'bullet');
  }
  for (const [, numId, body] of numberingXml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
    const abs = /<w:abstractNumId\b[^>]*w:val="(\d+)"/.exec(body);
    const fmt = abs ? abstractFmt.get(abs[1]) : 'bullet';
    kinds.set(numId, fmt && fmt !== 'bullet' && fmt !== 'none' ? 'ol' : 'ul');
  }
  return kinds;
}

function propOn(rPr, tag) {
  const m = new RegExp(`<w:${tag}\\b([^>]*)/?>`).exec(rPr);
  if (!m) return false;
  const val = /w:val="([^"]*)"/.exec(m[1]);
  return !val || !['0', 'false', 'none', 'off'].includes(val[1].toLowerCase());
}

function docxToHtml(buffer) {
  const zip = readZipEntries(buffer);
  const xml = zip.read('word/document.xml');
  if (!xml) throw new ImportError('This .docx file has no document body.');
  const listKinds = readListKinds(zip.read('word/numbering.xml'));

  const blocks = [];
  for (const [para] of xml.matchAll(/<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
    const pPr = (/<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(para) || [])[1] || '';
    const style = ((/<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(pPr) || [])[1] || '').toLowerCase();
    const numId = (/<w:numId\b[^>]*w:val="(\d+)"/.exec(pPr) || [])[1];

    let inner = '';
    for (const [run] of para.matchAll(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g)) {
      const rPr = (/<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(run) || [])[1] || '';
      let text = '';
      for (const [, tag, body] of run.matchAll(/<w:(t|tab|br)\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:\1>)/g)) {
        if (tag === 't') text += body || ''; // already XML-escaped, which is valid HTML text
        else if (tag === 'tab') text += ' ';
        else text += '<br>';
      }
      if (!text) continue;
      if (propOn(rPr, 'u')) text = `<u>${text}</u>`;
      if (propOn(rPr, 'i')) text = `<em>${text}</em>`;
      if (propOn(rPr, 'b')) text = `<strong>${text}</strong>`;
      inner += text;
    }

    const heading = /^heading\s*([1-9])$/.exec(style)
      || (style === 'title' ? [null, '1'] : null);
    if (heading) {
      if (inner) blocks.push({ tag: `h${Math.min(Number(heading[1]), 3)}`, inner });
    } else if (numId && numId !== '0') {
      blocks.push({ tag: 'li', list: listKinds.get(numId) || 'ul', inner });
    } else {
      blocks.push({ tag: 'p', inner });
    }
  }

  // Group consecutive list items; collapse runs of empty paragraphs.
  let html = '';
  let openList = null;
  let lastEmpty = false;
  for (const b of blocks) {
    if (b.tag === 'li') {
      if (openList && openList !== b.list) { html += `</${openList}>`; openList = null; }
      if (!openList) { html += `<${b.list}>`; openList = b.list; }
      html += `<li>${b.inner}</li>`;
      lastEmpty = false;
      continue;
    }
    if (openList) { html += `</${openList}>`; openList = null; }
    const empty = !b.inner.replace(/<[^>]+>/g, '').trim();
    if (empty && (lastEmpty || html === '')) continue;
    html += `<${b.tag}>${empty ? '<br>' : b.inner}</${b.tag}>`;
    lastEmpty = empty;
  }
  if (openList) html += `</${openList}>`;
  return html;
}

module.exports = {
  importFile, markdownToHtml, textToHtml, docxToHtml, ImportError,
  MAX_UPLOAD_BYTES, SUPPORTED,
};
