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

  // Filter to chunks with a meaningful similarity score
  const relevant = chunks.filter(c => c.score > 0.3);
  if (relevant.length === 0) {
    return { contextSystemAddition: '', sources: [], isRAG: false };
  }

  const contextBlocks = relevant.map((c, i) =>
    `[Excerpt ${i + 1} — ${c.original_name}, Page ${c.page_number ?? '?'}]\n${c.chunk_text}`
  ).join('\n\n---\n\n');

  const command = detectCommand(message);
  const cmdAddition = commandSystemAddition(command);

  const contextSystemAddition = `
You have access to the following excerpts from the user's uploaded research documents.
Use them as the primary source for your answer. Cite sources by referencing the excerpt number and document name.
${cmdAddition}

=== DOCUMENT EXCERPTS ===
${contextBlocks}
=== END EXCERPTS ===

After your answer, include a "**Sources:**" section listing each document + page number cited.`;

  const sources = relevant.map(c => ({
    docName:  c.original_name,
    docId:    c.doc_id,
    page:     c.page_number ?? null,
    score:    Math.round(c.score * 100),
    snippet:  c.chunk_text.slice(0, 180) + (c.chunk_text.length > 180 ? '…' : '')
  }));

  logger.info('RAG context built', {
    userId,
    relevantChunks: relevant.length,
    topScore: relevant[0]?.score?.toFixed(3)
  });

  return { contextSystemAddition, sources, isRAG: true };
}

module.exports = { buildRAGContext, detectCommand };
