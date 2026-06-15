// routes/chat.js — Chat endpoint with RAG integration + persistent history
'use strict';

const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const { generateResponse, checkOllamaHealth } = require('../services/llm');
const { buildRAGContext }  = require('../services/rag');
const { db, ensureUser }   = require('../database/db');
const { chatRules, handleValidationErrors } = require('../middleware/validate');
const logger = require('../utils/logger');

const router = express.Router();

const MAX_CTX = parseInt(process.env.MAX_CONTEXT_MESSAGES, 10) || 10;

// ── System prompt ─────────────────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are Obsidian AI, an intelligent research assistant built for academics, engineers, and curious minds.

Your capabilities:
- Answer research and technical questions with depth and accuracy
- Explain complex concepts clearly, from beginner to expert level
- Write, review, and debug code in any programming language
- Summarize documents, papers, and articles
- Help with writing, editing, and structuring ideas
- Assist with data analysis and mathematical reasoning

Formatting guidelines:
- Use Markdown: headers (##, ###), bullet lists, numbered lists, **bold**, *italic*
- Wrap code in fenced code blocks with the language tag: \`\`\`python ... \`\`\`
- Use tables for comparisons
- Keep responses focused and well-structured
- If unsure, say so clearly rather than guessing

Tone: Professional, helpful, and concise.`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function getUserId(req) {
  return req.headers['x-user-id'] || req.body?.userId || 'anonymous';
}

function httpStatusForError(err) {
  const k = err._kind;
  if (k === 'ollama_down')     return 503;
  if (k === 'model_not_found') return 422;
  if (k === 'timeout')         return 504;
  return 500;
}

function userMessageForError(err) {
  const model = process.env.OLLAMA_MODEL || 'llama3.2';
  const k = err._kind;
  if (k === 'ollama_down')     return 'Ollama is not running. Start it with: ollama serve';
  if (k === 'model_not_found') return `Model "${model}" is not pulled. Run: ollama pull ${model}`;
  if (k === 'timeout')         return 'The LLM took too long. Try a shorter message or restart Ollama.';
  return 'Failed to generate a response. Please try again.';
}

/**
 * Auto-generate a title for a chat from its first user message.
 */
function generateTitle(message) {
  const clean = message.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > 60 ? clean.slice(0, 57) + '…' : clean;
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/chat/health
 */
router.get('/health', async (_req, res) => {
  try {
    const h = await checkOllamaHealth();
    res.json({
      success: true, chatbot: 'online',
      ollama: h.online ? 'online' : 'offline',
      model: h.currentModel, modelAvailable: h.modelAvailable,
      availableModels: h.models
    });
  } catch (err) {
    res.status(500).json({ success: false, chatbot: 'online', ollama: 'error' });
  }
});

/**
 * GET /api/chat/models
 */
router.get('/models', async (_req, res) => {
  try {
    const h = await checkOllamaHealth();
    res.json({ success: true, models: h.models, current: h.currentModel });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/chat
 * Body: { message, chatId?, userId?, docIds?, userName?, userEmail? }
 *
 * chatId is optional — if absent a new chat is created.
 * docIds is an array of document IDs to scope the RAG search.
 */
router.post('/', chatRules, handleValidationErrors, async (req, res) => {
  const {
    message,
    chatId: incomingChatId,
    docIds = [],
    userName = 'User',
    userEmail = ''
  } = req.body;

  const userId = getUserId(req);
  ensureUser(userId, userName, userEmail);

  // ── Resolve / create chat ─────────────────────────────────────────────────
  let chatId = incomingChatId;
  let isNewChat = false;

  if (!chatId) {
    chatId = uuidv4();
    isNewChat = true;
    db.prepare('INSERT INTO chats (id, user_id, title) VALUES (?, ?, ?)')
      .run(chatId, userId, generateTitle(message));
  } else {
    const exists = db.prepare('SELECT id FROM chats WHERE id = ? AND user_id = ?')
                     .get(chatId, userId);
    if (!exists) {
      chatId = uuidv4();
      isNewChat = true;
      db.prepare('INSERT INTO chats (id, user_id, title) VALUES (?, ?, ?)')
        .run(chatId, userId, generateTitle(message));
    }
  }

  // ── Build conversation context from DB ────────────────────────────────────
  const history = db.prepare(`
    SELECT role, content FROM messages
    WHERE chat_id = ? ORDER BY created_at ASC LIMIT ?
  `).all(chatId, MAX_CTX);

  const contextMessages = [...history, { role: 'user', content: message }];

  // ── RAG: retrieve relevant document chunks ────────────────────────────────
  let systemPrompt = BASE_SYSTEM_PROMPT;
  let sources = [];
  let isRAG = false;

  if (docIds.length > 0 || db.prepare('SELECT COUNT(*) as c FROM documents WHERE user_id = ? AND status = ?').get(userId, 'ready')?.c > 0) {
    try {
      const rag = await buildRAGContext(db, message, userId, docIds);
      if (rag.isRAG) {
        systemPrompt += rag.contextSystemAddition;
        sources = rag.sources;
        isRAG = true;
      }
    } catch (err) {
      logger.warn('RAG failed, falling back to plain LLM', { error: err.message });
    }
  }

  // ── Save user message to DB ───────────────────────────────────────────────
  const userMsgId = uuidv4();
  db.prepare('INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, ?, ?)')
    .run(userMsgId, chatId, 'user', message);

  logger.info('Chat request', { chatId, userId, isRAG, msgLen: message.length });

  // ── LLM call ──────────────────────────────────────────────────────────────
  try {
    const aiText = await generateResponse(contextMessages, systemPrompt);

    // Save assistant message to DB
    const aiMsgId = uuidv4();
    db.prepare('INSERT INTO messages (id, chat_id, role, content, sources) VALUES (?, ?, ?, ?, ?)')
      .run(aiMsgId, chatId, 'assistant', aiText, sources.length ? JSON.stringify(sources) : null);

    // Bump chat updated_at
    db.prepare('UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(chatId);

    logger.info('Chat response sent', { chatId, responseLen: aiText.length, isRAG });

    res.json({
      success: true,
      chatId,
      isNewChat,
      response: aiText,
      sources,
      isRAG,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    // Roll back user message on failure
    db.prepare('DELETE FROM messages WHERE id = ?').run(userMsgId);
    logger.error('LLM failed', { chatId, error: err.message, kind: err._kind });

    res.status(httpStatusForError(err)).json({
      success: false,
      chatId,
      error: userMessageForError(err),
      hint: `ollama serve && ollama pull ${process.env.OLLAMA_MODEL || 'llama3.2'}`,
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = router;
