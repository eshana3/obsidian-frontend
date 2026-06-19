// services/embeddings.js — Hybrid retrieval: BM25 keyword + optional semantic search
//
// Retrieval strategy (auto-selected):
//   Always:   BM25 keyword search — works with zero API keys, no Ollama required.
//   Optional: Cosine similarity   — activated when stored chunk embeddings exist
//             AND an embedding provider is available (OpenAI or Ollama).
//
// Embedding generation (for indexing at upload time):
//   1. OpenAI  — if OPENAI_API_KEY is set (text-embedding-3-small, cheap)
//   2. Ollama  — if running locally (nomic-embed-text)
//   3. None    — chunks stored without vectors; BM25 covers retrieval
'use strict';

const axios  = require('axios');
const logger = require('../utils/logger');

// ── Configuration ─────────────────────────────────────────────────────────────

const OLLAMA_BASE_URL    = process.env.OLLAMA_BASE_URL    || 'http://localhost:11434';
const EMBED_MODEL        = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
const OLLAMA_CHAT_MODEL  = process.env.OLLAMA_MODEL       || 'llama3.2';
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY;
const OPENAI_EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small';

// ── BM25 Keyword Search ───────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'from','is','it','its','be','are','was','were','been','has','have','had',
  'do','did','does','will','would','can','could','should','may','might',
  'this','that','these','those','i','we','you','he','she','they',
  'what','which','who','how','when','where','why','not','no','if','then',
  'than','so','as','into','about','also','just','more','some','any',
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .map(t => t.replace(/^['-]+|['-]+$/g, ''))
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

function computeBm25(docTerms, docLen, avgDocLen, queryTerms, docFreqs, N) {
  const k1 = 1.5, b = 0.75;
  const tfMap = {};
  for (const t of docTerms) tfMap[t] = (tfMap[t] || 0) + 1;

  let score = 0;
  for (const term of queryTerms) {
    const tf = tfMap[term] || 0;
    if (tf === 0) continue;
    const df  = docFreqs[term] || 0;
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
    const tfn = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgDocLen));
    score += idf * tfn;
  }
  return score;
}

// ── Cosine Similarity ─────────────────────────────────────────────────────────

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

// ── Embedding Generation ──────────────────────────────────────────────────────

/**
 * Generate a float-array embedding for text.
 * Tries: OpenAI → Ollama embed → Ollama chat model.
 * Throws if all providers are unavailable (caller stores null).
 */
async function generateEmbedding(text) {
  const input = String(text || '').slice(0, 8000);

  // 1. OpenAI (if key is set)
  if (OPENAI_API_KEY) {
    try {
      const { data } = await axios.post(
        'https://api.openai.com/v1/embeddings',
        { model: OPENAI_EMBED_MODEL, input },
        {
          timeout: 15_000,
          headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }
        }
      );
      const vec = data?.data?.[0]?.embedding;
      if (vec?.length) return vec;
    } catch (err) {
      logger.warn('OpenAI embedding failed', { error: err.message });
    }
  }

  // 2. Ollama (local dev)
  for (const model of [EMBED_MODEL, OLLAMA_CHAT_MODEL]) {
    try {
      const { data } = await axios.post(
        `${OLLAMA_BASE_URL}/api/embeddings`,
        { model, prompt: input.slice(0, 4096) },
        { timeout: 30_000 }
      );
      if (data.embedding?.length) return data.embedding;
    } catch (err) {
      logger.warn(`Ollama embedding failed (${model})`, { error: err.message });
    }
  }

  throw new Error('No embedding provider available. Using BM25-only retrieval.');
}

/**
 * Generate embeddings for an array of texts.
 * Failures return null — the chunk is still stored and searched via BM25.
 */
async function generateEmbeddings(texts) {
  const results = [];
  for (const text of texts) {
    try {
      results.push(await generateEmbedding(text));
    } catch (_) {
      results.push(null);
    }
  }
  return results;
}

// ── Hybrid Search ─────────────────────────────────────────────────────────────

/**
 * Search for the topK most relevant chunks for a query.
 *
 * Algorithm:
 *   1. BM25 keyword search (always runs — no embedding required).
 *   2. Cosine similarity   (runs when stored embeddings exist and an
 *      embedding provider can embed the query).
 *   3. Scores normalized to [0,1] and combined (50/50 when both run).
 *
 * Only chunks with BM25 > 0 are returned — guarantees no off-topic noise
 * when the query has no keyword overlap with any document.
 *
 * @param {object}   db
 * @param {string}   queryText
 * @param {string}   userId
 * @param {string[]} [docIds=[]]  restrict to specific docs (empty = all)
 * @param {number}   [topK=5]
 * @returns {Promise<Array>}      scored chunk objects
 */
async function searchSimilarChunks(db, queryText, userId, docIds = [], topK = 5) {
  // Fetch ALL ready chunks — no embedding IS NOT NULL filter so BM25 covers them all
  let sql = `
    SELECT c.id, c.chunk_text, c.chunk_index, c.page_number, c.embedding,
           d.original_name, d.id AS doc_id
    FROM   chunks c
    JOIN   documents d ON c.document_id = d.id
    WHERE  d.user_id = ? AND d.status = 'ready'
  `;
  const params = [userId];

  if (docIds.length > 0) {
    sql += ` AND d.id IN (${docIds.map(() => '?').join(',')})`;
    params.push(...docIds);
  }

  const rows = db.prepare(sql).all(...params);
  if (rows.length === 0) return [];

  // ── BM25 ──────────────────────────────────────────────────────────────────
  const queryTerms = [...new Set(tokenize(queryText))];
  if (queryTerms.length === 0) {
    logger.info('BM25: query has no indexable terms — skipping RAG');
    return [];
  }

  const N          = rows.length;
  const tokenized  = rows.map(r => tokenize(r.chunk_text));
  const avgDocLen  = tokenized.reduce((s, t) => s + t.length, 0) / N || 1;

  const docFreqs = {};
  for (const term of queryTerms) {
    docFreqs[term] = tokenized.filter(t => t.includes(term)).length;
  }

  const scored = rows.map((row, i) => ({
    ...row,
    _bm25:  computeBm25(tokenized[i], tokenized[i].length, avgDocLen, queryTerms, docFreqs, N),
    _cos:   0,
    score:  0,
  }));

  // ── Semantic (optional) ───────────────────────────────────────────────────
  const hasStoredEmb = rows.some(r => r.embedding);
  let queryEmb = null;

  if (hasStoredEmb) {
    try { queryEmb = await generateEmbedding(queryText); } catch (_) {}
  }

  if (queryEmb) {
    for (const row of scored) {
      if (row.embedding) {
        try {
          const emb = JSON.parse(row.embedding);
          row._cos = cosineSimilarity(queryEmb, emb);
        } catch (_) {}
      }
    }
  }

  // ── Normalize and combine ─────────────────────────────────────────────────
  const maxBm25 = Math.max(...scored.map(r => r._bm25), 0.001);
  const maxCos  = Math.max(...scored.map(r => r._cos),  0.001);
  const hybrid  = queryEmb && hasStoredEmb;

  for (const row of scored) {
    const b = row._bm25 / maxBm25;
    const c = row._cos  / maxCos;
    row.score = hybrid ? 0.5 * b + 0.5 * c : b;
  }

  // Only return chunks with real BM25 signal (score > 0 means at least one keyword matched)
  const results = scored
    .filter(r => r._bm25 > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  logger.info('Hybrid search complete', {
    userId,
    totalChunks: N,
    queryTerms,
    mode: hybrid ? 'hybrid' : 'bm25-only',
    results: results.length,
    topScore: results[0]?.score?.toFixed(3),
  });

  return results;
}

module.exports = { generateEmbedding, generateEmbeddings, searchSimilarChunks };
