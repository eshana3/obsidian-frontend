// routes/account.js — User profile management and account deletion
'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { db, ensureUser } = require('../database/db');
const logger  = require('../utils/logger');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads');

function getUserId(req) {
  return req.headers['x-user-id'] || req.body?.userId || req.query?.userId || 'anonymous';
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/account/profile
 * Returns the user's profile and preferences.
 */
router.get('/profile', (req, res) => {
  const userId = getUserId(req);
  ensureUser(userId, req.headers['x-user-name'] || 'User', '');

  const user = db.prepare('SELECT id, name, email, preferences, created_at FROM users WHERE id = ?')
                 .get(userId);

  if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM chats    WHERE user_id = ?) AS total_chats,
      (SELECT COUNT(*) FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE user_id = ?)) AS total_messages,
      (SELECT COUNT(*) FROM documents WHERE user_id = ?) AS total_documents
  `).get(userId, userId, userId);

  res.json({
    success: true,
    user: {
      ...user,
      preferences: user.preferences ? JSON.parse(user.preferences) : {}
    },
    stats
  });
});

/**
 * PUT /api/account/profile
 * Update display name, email, or preferences.
 * Body: { name?, email?, preferences? }
 */
router.put('/profile', (req, res) => {
  const userId = getUserId(req);
  ensureUser(userId, '', '');

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

  const name        = req.body?.name        ? String(req.body.name).slice(0, 80)       : user.name;
  const email       = req.body?.email       ? String(req.body.email).slice(0, 120)     : user.email;
  const preferences = req.body?.preferences ? JSON.stringify(req.body.preferences)     : user.preferences;

  db.prepare(`
    UPDATE users SET name = ?, email = ?, preferences = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(name, email, preferences, userId);

  res.json({ success: true, user: { id: userId, name, email, preferences: JSON.parse(preferences) } });
});

/**
 * DELETE /api/account
 * Permanently deletes the user, all chats, all documents, and all PDF files on disk.
 * Body must include { confirm: 'DELETE' }
 */
router.delete('/', (req, res) => {
  const userId = getUserId(req);

  if (req.body?.confirm !== 'DELETE') {
    return res.status(400).json({
      success: false,
      error: 'Confirmation required. Send { confirm: "DELETE" } in the request body.'
    });
  }

  // Collect all document filenames before deletion
  const docs = db.prepare('SELECT filename FROM documents WHERE user_id = ?').all(userId);

  // Delete from DB — cascades to chats → messages, documents → chunks
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(userId);

  if (result.changes === 0) {
    return res.status(404).json({ success: false, error: 'User not found.' });
  }

  // Remove PDF files from disk
  let filesDeleted = 0;
  for (const doc of docs) {
    const filePath = path.join(UPLOAD_DIR, doc.filename);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); filesDeleted++; } catch (_) {}
    }
  }

  logger.info('Account deleted', { userId, filesDeleted });
  res.json({ success: true, message: 'Account and all associated data permanently deleted.' });
});

/**
 * GET /api/account/stats
 * Quick stats for the settings page.
 */
router.get('/stats', (req, res) => {
  const userId = getUserId(req);
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM chats    WHERE user_id = ?)                                           AS chats,
      (SELECT COUNT(*) FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE user_id = ?))   AS messages,
      (SELECT COUNT(*) FROM documents WHERE user_id = ?)                                          AS documents,
      (SELECT COALESCE(SUM(size),0) FROM documents WHERE user_id = ?)                            AS storage_bytes
  `).get(userId, userId, userId, userId);
  res.json({ success: true, stats });
});

module.exports = router;
