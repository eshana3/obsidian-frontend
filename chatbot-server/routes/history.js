// routes/history.js — Persistent chat history CRUD
'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, ensureUser } = require('../database/db');
const logger = require('../utils/logger');

const router = express.Router();

function getUserId(req) {
  return req.headers['x-user-id'] || req.body?.userId || req.query?.userId || 'anonymous';
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/history
 * Returns all chats for the user, grouped-ready (sorted by pinned + date).
 */
router.get('/', (req, res) => {
  const userId = getUserId(req);

  const chats = db.prepare(`
    SELECT c.id, c.title, c.pinned, c.created_at, c.updated_at,
           COUNT(m.id) AS message_count,
           MAX(m.content) FILTER (WHERE m.role = 'user') AS last_user_message
    FROM chats c
    LEFT JOIN messages m ON m.chat_id = c.id
    WHERE c.user_id = ?
    GROUP BY c.id
    ORDER BY c.pinned DESC, c.updated_at DESC
    LIMIT 200
  `).all(userId);

  res.json({ success: true, chats });
});

/**
 * POST /api/history
 * Create a new chat. Returns the new chat object.
 */
router.post('/', (req, res) => {
  const userId = getUserId(req);
  const name   = req.headers['x-user-name'] || req.body?.userName || 'User';
  ensureUser(userId, name, req.body?.userEmail || '');

  const chatId = uuidv4();
  const title  = (req.body?.title || 'New Chat').slice(0, 120);

  db.prepare(`
    INSERT INTO chats (id, user_id, title) VALUES (?, ?, ?)
  `).run(chatId, userId, title);

  logger.info('Chat created', { chatId, userId });
  res.status(201).json({
    success: true,
    chat: { id: chatId, title, pinned: 0, message_count: 0 }
  });
});

/**
 * GET /api/history/:id
 * Returns a single chat with all its messages.
 */
router.get('/:id', (req, res) => {
  const userId = getUserId(req);
  const chat   = db.prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?')
                   .get(req.params.id, userId);

  if (!chat) return res.status(404).json({ success: false, error: 'Chat not found.' });

  const messages = db.prepare(`
    SELECT id, role, content, sources, created_at
    FROM messages WHERE chat_id = ? ORDER BY created_at ASC
  `).all(req.params.id);

  // Parse sources JSON
  const parsed = messages.map(m => ({
    ...m,
    sources: m.sources ? JSON.parse(m.sources) : null
  }));

  res.json({ success: true, chat, messages: parsed });
});

/**
 * PUT /api/history/:id
 * Rename or pin/unpin a chat.
 * Body: { title?, pinned? }
 */
router.put('/:id', (req, res) => {
  const userId = getUserId(req);
  const chat   = db.prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?')
                   .get(req.params.id, userId);

  if (!chat) return res.status(404).json({ success: false, error: 'Chat not found.' });

  const newTitle  = req.body?.title  !== undefined ? String(req.body.title).slice(0, 120) : chat.title;
  const newPinned = req.body?.pinned !== undefined ? (req.body.pinned ? 1 : 0) : chat.pinned;

  db.prepare(`
    UPDATE chats SET title = ?, pinned = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(newTitle, newPinned, req.params.id);

  res.json({ success: true, chat: { ...chat, title: newTitle, pinned: newPinned } });
});

/**
 * DELETE /api/history/:id
 * Deletes a chat and all its messages.
 */
router.delete('/:id', (req, res) => {
  const userId = getUserId(req);
  const chat   = db.prepare('SELECT id FROM chats WHERE id = ? AND user_id = ?')
                   .get(req.params.id, userId);

  if (!chat) return res.status(404).json({ success: false, error: 'Chat not found.' });

  db.prepare('DELETE FROM chats WHERE id = ?').run(req.params.id);
  logger.info('Chat deleted', { chatId: req.params.id, userId });
  res.json({ success: true });
});

/**
 * DELETE /api/history
 * Deletes ALL chats for the user.
 */
router.delete('/', (req, res) => {
  const userId = getUserId(req);
  const { changes } = db.prepare('DELETE FROM chats WHERE user_id = ?').run(userId);
  res.json({ success: true, deleted: changes });
});

module.exports = router;
