// services/embeddings.js — Ollama embedding generation + cosine similarity search
'use strict';

const axios  = require('axios');
const logger = require('../utils/logger');

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL  || 'http://localhost:11434';
const EMBED_MODEL     = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
const CHAT_MODEL      = process.env.OLLAMA_MODEL       || 'llama3.2';

// ── Embedding generation ──────────────────────────────────────────────────────

/**
 * Generate an embedding vector for a single text string.
 * Falls back to the chat model if the dedicated embedding model fails.
 */
async function generateEmbedding(text) {
  for (const model of [EMBED_MODEL, CHAT_MODEL]) {
    try {
      const { data } = await axios.post(
        `${OLLAMA_BASE_URL}/api/embeddings`,
        { model, prompt: text.slice(0, 4096) },   // cap input length
        { timeout: 30_000 }
      );
      if (data.embedding?.length) return data.embedding;
    } catch (err) {
      logger.warn(`Embedding failed with model ${model}`, { error: err.message });
    }
  }
  throw new Error('All embedding models failed.');
}

// ── Similarity ────────────────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Bulk embedding (for document ingestion) ───────────────────────────────────

/**
 * Generate embeddings for an array of text strings.
 * Returns an array of float arrays, same length as input.
 */
async function generateEmbeddings(texts) {
  const results = [];
  for (const text of texts) {
    try {
      results.push(await generateEmbedding(text));
    } catch (_) {
      results.push(null);   // placeholder; handled downstream
    }
  }
  return results;
}

// ── Vector search ─────────────────────────────────────────────────────────────

/**
 * Search the chunks table for the topK most semantically similar chunks
 * belonging to the given user (optionally filtered to specific document IDs).
 *
 * @param {object} db          better-sqlite3 instance
 * @param {string} queryText   User question / search phrase
 * @param {string} userId
 * @param {string[]} [docIds]  Limit search to these document IDs (empty = all docs)
 * @param {number} [topK=5]
 * @returns {Promise<Array>}   Scored chunk objects sorted by relevance
 */
async function searchSimilarChunks(db, queryText, userId, docIds = [], topK = 5) {
  // Build query — optionally filter by specific document IDs
  let sql = `
    SELECT c.id, c.chunk_text, c.chunk_index, c.page_number, c.embedding,
           d.original_name, d.id AS doc_id
    FROM   chunks c
    JOIN   documents d ON c.document_id = d.id
    WHERE  d.user_id = ? AND c.embedding IS NOT NULL AND d.status = 'ready'
  `;
  const params = [userId];

  if (docIds.length > 0) {
    sql += ` AND d.id IN (${docIds.map(() => '?').join(',')})`;
    params.push(...docIds);
  }

  const rows = db.prepare(sql).all(...params);
  if (rows.length === 0) return [];

  let queryEmbedding;
  try {
    queryEmbedding = await generateEmbedding(queryText);
  } catch (err) {
    logger.error('Query embedding failed', { error: err.message });
    return [];
  }

  const scored = rows.map(row => {
    let emb;
    try { emb = JSON.parse(row.embedding); } catch (_) { emb = null; }
    return { ...row, score: cosineSimilarity(queryEmbedding, emb) };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

module.exports = { generateEmbedding, generateEmbeddings, searchSimilarChunks };
