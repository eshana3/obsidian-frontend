// services/rag.js — RAG pipeline: retrieve relevant chunks → build context → LLM
'use strict';

const { searchSimilarChunks } = require('./embeddings');
const logger = require('../utils/logger');

const TOP_K = parseInt(process.env.RAG_TOP_K, 10) || 5;

/**
 * Detect whether the user's message is a special research command.
 * Returns the detected command name or null for a normal question.
 */
function detectCommand(message) {
  const msg = message.toLowerCase().trim();
  if (/^summarize|summarize (this|the) (pdf|document|paper)/i.test(msg)) return 'summarize';
  if (/generate (notes|key (points|takeaways))/i.test(msg)) return 'notes';
  if (/generate.*\d*.*questions|make.*quiz|create.*quiz/i.test(msg)) return 'quiz';
  if (/compare (document|pdf|paper)/i.test(msg)) return 'compare';
  if (/explain page\s*\d+/i.test(msg)) return 'explain_page';
  return null;
}

/**
 * Build a specialized system-prompt section for research commands.
 */
function commandSystemAddition(command) {
  switch (command) {
    case 'summarize':
      return '\nThe user wants a comprehensive summary. Structure it with: Executive Summary, Key Findings, Methodology (if present), Conclusions, and Important Quotes.';
    case 'notes':
      return '\nThe user wants study notes. Format as: numbered key points, important definitions, and a "Remember" section at the end.';
    case 'quiz':
      return '\nThe user wants quiz questions. Generate questions with 4 multiple-choice options each. Label answers at the bottom as "Answer Key:".';
    case 'compare':
      return '\nThe user wants a comparison. Use a structured table format comparing themes, methodology, findings, and conclusions across the documents.';
    case 'explain_page':
      return '\nThe user wants a page explained. Give a detailed plain-language explanation of the content on that page.';
    default:
      return '';
  }
}

/**
 * Run the full RAG pipeline for a user message.
 *
 * @param {object}   db
 * @param {string}   message       User's question / command
 * @param {string}   userId
 * @param {string[]} [docIds=[]]   Specific doc IDs to search (empty = all user docs)
 * @returns {{ contextSystemAddition: string, sources: object[], isRAG: boolean }}
 */
async function buildRAGContext(db, message, userId, docIds = []) {
  const chunks = await searchSimilarChunks(db, message, userId, docIds, TOP_K);

  if (chunks.length === 0) {
    return { contextSystemAddition: '', sources: [], isRAG: false };
  }

  // Accept all chunks returned by searchSimilarChunks (they already have BM25 > 0)
  // but drop the very lowest tail (< 5% of top score) to avoid fringe noise.
  const relevant = chunks.filter(c => c.score > 0.05);
  if (relevant.length === 0) {
    return { contextSystemAddition: '', sources: [], isRAG: false };
  }

  const contextBlocks = relevant.map((c, i) =>
    `[Excerpt ${i + 1} — ${c.original_name}, Page ${c.page_number ?? '?'}]\n${c.chunk_text}`
  ).join('\n\n---\n\n');

  const command = detectCommand(message);
  const cmdAddition = commandSystemAddition(command);

  const contextSystemAddition = `

IMPORTANT INSTRUCTION: You MUST answer ONLY using the document excerpts provided below. Do NOT use any outside knowledge. If the answer cannot be found in these excerpts, respond with exactly: "I could not find that information in the uploaded documents."
${cmdAddition}

=== DOCUMENT EXCERPTS (from user's uploaded files) ===
${contextBlocks}
=== END EXCERPTS ===

Rules:
- Ground every claim in the excerpts above. Cite using the excerpt number, e.g. [Excerpt 2].
- After your answer include a "**Sources:**" section listing: document name, page number, and relevance score (${relevant.map(c => `${c.original_name} p.${c.page_number ?? '?'} — ${Math.round(c.score * 100)}%`).join(', ')}).
- If the excerpts do not contain enough information to answer, say so clearly.`;

  const sources = relevant.map(c => ({
    docName:  c.original_name,
    docId:    c.doc_id,
    page:     c.page_number ?? null,
    score:    Math.round(c.score * 100),
    text:     c.chunk_text.slice(0, 200) + (c.chunk_text.length > 200 ? '…' : '')
  }));

  logger.info('RAG context built', {
    userId,
    relevantChunks: relevant.length,
    topScore: relevant[0]?.score?.toFixed(3)
  });

  return { contextSystemAddition, sources, isRAG: true };
}

module.exports = { buildRAGContext, detectCommand };
