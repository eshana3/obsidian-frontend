// database/db.js — SQLite schema + singleton connection
'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const logger   = require('../utils/logger');

// DB_PATH env var lets production deployments use a writable path (e.g. /tmp on Render).
// Falls back to chatbot-server/data/obsidian.db for local dev.
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'obsidian.db');

const DATA_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT 'User',
    email       TEXT DEFAULT '',
    preferences TEXT DEFAULT '{}',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS chats (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    title      TEXT NOT NULL DEFAULT 'New Chat',
    pinned     INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    chat_id    TEXT NOT NULL,
    role       TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content    TEXT NOT NULL,
    sources    TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS documents (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    filename      TEXT NOT NULL,
    original_name TEXT NOT NULL,
    size          INTEGER NOT NULL,
    pages         INTEGER DEFAULT 0,
    chunk_count   INTEGER DEFAULT 0,
    status        TEXT DEFAULT 'processing' CHECK(status IN ('processing','ready','error')),
    upload_date   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS chunks (
    id           TEXT PRIMARY KEY,
    document_id  TEXT NOT NULL,
    chunk_text   TEXT NOT NULL,
    chunk_index  INTEGER NOT NULL,
    page_number  INTEGER DEFAULT 1,
    embedding    TEXT DEFAULT NULL,
    FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_chats_user       ON chats(user_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_chat    ON messages(chat_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_documents_user   ON documents(user_id, upload_date DESC);
  CREATE INDEX IF NOT EXISTS idx_chunks_document  ON chunks(document_id, chunk_index);

  -- Module 5: extended document repository (page-wise storage + metadata)
  CREATE TABLE IF NOT EXISTS document_pages (
    id           TEXT PRIMARY KEY,
    document_id  TEXT NOT NULL,
    page_number  INTEGER NOT NULL,
    heading      TEXT DEFAULT '',
    text         TEXT NOT NULL DEFAULT '',
    word_count   INTEGER DEFAULT 0,
    char_count   INTEGER DEFAULT 0,
    status       TEXT DEFAULT 'OK' CHECK(status IN ('OK','BLANK','SCANNED','ERROR')),
    ocr_required INTEGER DEFAULT 0,
    FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS validation_reports (
    id              TEXT PRIMARY KEY,
    document_id     TEXT NOT NULL UNIQUE,
    total_pages     INTEGER DEFAULT 0,
    processed_pages INTEGER DEFAULT 0,
    blank_pages     INTEGER DEFAULT 0,
    scanned_pages   INTEGER DEFAULT 0,
    failed_pages    INTEGER DEFAULT 0,
    overall_status  TEXT DEFAULT 'PENDING',
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_doc_pages_doc ON document_pages(document_id, page_number);

  -- Track 2.3: Text Cleaning Reports
  CREATE TABLE IF NOT EXISTS text_cleaning_reports (
    id                    TEXT PRIMARY KEY,
    document_id           TEXT NOT NULL UNIQUE,
    chars_before          INTEGER DEFAULT 0,
    chars_after           INTEGER DEFAULT 0,
    reduction_percent     REAL    DEFAULT 0,
    removed_page_numbers  INTEGER DEFAULT 0,
    removed_headers       INTEGER DEFAULT 0,
    detected_header_lines INTEGER DEFAULT 0,
    removed_urls          INTEGER DEFAULT 0,
    removed_emails        INTEGER DEFAULT 0,
    removed_boilerplate   INTEGER DEFAULT 0,
    created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
  );
`);

// ── Safe column migrations (ALTER TABLE ADD COLUMN IF NOT EXISTS) ─────────────
// SQLite doesn't support IF NOT EXISTS on ALTER TABLE, so we check pragma first.
const _docCols = db.pragma('table_info(documents)').map(c => c.name);
if (!_docCols.includes('chunk_count')) {
  db.exec('ALTER TABLE documents ADD COLUMN chunk_count INTEGER DEFAULT 0');
  logger.info('Migrated: added documents.chunk_count');
}
// Module 4 & 5: metadata + file-type columns
const _newDocCols = { file_type: 'TEXT', title: 'TEXT', authors: 'TEXT', year: 'INTEGER', keywords: 'TEXT', doi: 'TEXT' };
for (const [col, type] of Object.entries(_newDocCols)) {
  if (!_docCols.includes(col)) {
    db.exec(`ALTER TABLE documents ADD COLUMN ${col} ${type}`);
    logger.info(`Migrated: added documents.${col}`);
  }
}

// Track 2.3: cleaned text column on document_pages
const _pageCols = db.pragma('table_info(document_pages)').map(c => c.name);
if (!_pageCols.includes('cleaned_text')) {
  db.exec('ALTER TABLE document_pages ADD COLUMN cleaned_text TEXT DEFAULT NULL');
  logger.info('Migrated: added document_pages.cleaned_text');
}
if (!_pageCols.includes('cleaned_word_count')) {
  db.exec('ALTER TABLE document_pages ADD COLUMN cleaned_word_count INTEGER DEFAULT 0');
  logger.info('Migrated: added document_pages.cleaned_word_count');
}

logger.info('Database ready', { path: DB_PATH });

function ensureUser(userId, name, email) {
  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!existing) {
    db.prepare('INSERT INTO users (id, name, email) VALUES (?, ?, ?)')
      .run(userId, name || 'User', email || '');
    logger.info('New user created', { userId });
  } else if (name || email) {
    db.prepare(`
      UPDATE users
      SET name = COALESCE(?, name), email = COALESCE(?, email), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(name || null, email || null, userId);
  }
}

module.exports = { db, ensureUser };
