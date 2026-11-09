'use strict';
// Persistence layer: SQLite via Node's built-in node:sqlite (no native deps to install).

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { hashPassword } = require('./auth');

const SCHEMA = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS documents (
    id           TEXT PRIMARY KEY,
    owner_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    content_html TEXT NOT NULL DEFAULT '',
    version      INTEGER NOT NULL DEFAULT 1,
    source       TEXT,                -- e.g. "upload:notes.md" when created from a file
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS document_shares (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
    created_at  TEXT NOT NULL,
    PRIMARY KEY (document_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id);
  CREATE INDEX IF NOT EXISTS idx_shares_user ON document_shares(user_id);
`;

const SEED_PASSWORD = 'demo1234';
const SEED_USERS = [
  { email: 'alice@ajaia.test', name: 'Alice Chen' },
  { email: 'bob@ajaia.test', name: 'Bob Rivera' },
  { email: 'carol@ajaia.test', name: 'Carol Singh' },
];

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  seed(db);
  return db;
}

function seed(db) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n > 0) return;

  const insertUser = db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)');
  const ids = {};
  for (const u of SEED_USERS) {
    ids[u.email] = Number(insertUser.run(u.email, u.name, hashPassword(SEED_PASSWORD)).lastInsertRowid);
  }

  const now = new Date().toISOString();
  const insertDoc = db.prepare(
    `INSERT INTO documents (id, owner_id, title, content_html, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertShare = db.prepare(
    'INSERT INTO document_shares (document_id, user_id, role, created_at) VALUES (?, ?, ?, ?)'
  );

  insertDoc.run(
    'welcome-q3-planning', ids['alice@ajaia.test'], 'Q3 Planning Notes',
    '<h1>Q3 Planning Notes</h1><p>This document is owned by <strong>Alice</strong>, shared with ' +
      '<em>Bob as an editor</em> and <u>Carol as a viewer</u>.</p><h2>Goals</h2><ul><li>Ship the editor MVP</li>' +
      '<li>Collect feedback from two pilot teams</li></ul><h2>Next steps</h2><ol><li>Finalize scope</li>' +
      '<li>Assign owners</li></ol>',
    now, now
  );
  insertShare.run('welcome-q3-planning', ids['bob@ajaia.test'], 'editor', now);
  insertShare.run('welcome-q3-planning', ids['carol@ajaia.test'], 'viewer', now);

  insertDoc.run(
    'bob-draft', ids['bob@ajaia.test'], "Bob's private draft",
    '<p>Only Bob can see this until he shares it.</p>', now, now
  );
}

module.exports = { openDb, SEED_USERS, SEED_PASSWORD };
