// services/llm.js — Ollama LLM service layer
// Handles all communication with the local Ollama instance.
// Supports: llama3, mistral, gemma, codellama, phi3, and any Ollama-compatible model.
'use strict';

const axios = require('axios');
const logger = require('../utils/logger');

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL    = process.env.OLLAMA_MODEL    || 'llama3';
const OLLAMA_TIMEOUT  = parseInt(process.env.OLLAMA_TIMEOUT,  10) || 60_000;
const MAX_RETRIES     = parseInt(process.env.MAX_RETRIES,     10) || 3;
const RETRY_DELAY_MS  = parseInt(process.env.RETRY_DELAY_MS,  10) || 1_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Classify the axios error so callers can give the user a helpful message.
 * Returns one of: 'ollama_down' | 'timeout' | 'model_not_found' | 'unknown'
 */
function classifyError(err) {
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') return 'ollama_down';
  if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) return 'timeout';
  if (err.response?.status === 404) return 'model_not_found';
  return 'unknown';
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check whether the Ollama server is reachable and whether the configured
 * model is available.  Never throws — always resolves.
 *
 * @returns {{ online: boolean, modelAvailable: boolean, currentModel: string, models: string[] }}
 */
async function checkOllamaHealth() {
  try {
    const { data } = await axios.get(`${OLLAMA_BASE_URL}/api/tags`, { timeout: 5_000 });
    const models = (data.models || []).map(m => m.name);
    const modelAvailable = models.some(name => name === OLLAMA_MODEL || name.startsWith(`${OLLAMA_MODEL}:`));
    return { online: true, modelAvailable, currentModel: OLLAMA_MODEL, models };
  } catch (err) {
    logger.error('Ollama health check failed', { error: err.message, code: err.code });
    return { online: false, modelAvailable: false, currentModel: OLLAMA_MODEL, models: [] };
  }
}

/**
 * Generate an LLM response for the given conversation context.
 *
 * @param {Array<{role: 'user'|'assistant', content: string}>} messages
 *   The conversation history to send as context (last N messages).
 * @param {string} [systemPrompt]
 *   Optional system instruction prepended to the conversation.
 * @returns {Promise<string>} The assistant's reply text.
 * @throws {Error} After MAX_RETRIES failed attempts.
 */
async function generateResponse(messages, systemPrompt) {
  // Build the Ollama message array, optionally with a system message first
  const ollamaMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : [...messages];

  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info('LLM request', { attempt, model: OLLAMA_MODEL, contextLen: messages.length });

      const { data } = await axios.post(
        `${OLLAMA_BASE_URL}/api/chat`,
        {
          model: OLLAMA_MODEL,
          messages: ollamaMessages,
          stream: false,
          options: {
            temperature: 0.7,
            top_p: 0.9,
            num_predict: 2048
          }
        },
        {
          timeout: OLLAMA_TIMEOUT,
          headers: { 'Content-Type': 'application/json' }
        }
      );

      const content = data?.message?.content;
      if (!content) throw new Error('Ollama returned an empty response body.');

      logger.info('LLM response received', {
        attempt,
        model: OLLAMA_MODEL,
        chars: content.length
      });

      return content;

    } catch (err) {
      lastError = err;
      const kind = classifyError(err);

      logger.warn(`LLM attempt ${attempt}/${MAX_RETRIES} failed`, {
        kind,
        error: err.message,
        status: err.response?.status
      });

      // Don't retry if the model simply doesn't exist — it won't help.
      if (kind === 'model_not_found') break;

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * attempt; // exponential-ish back-off
        logger.info(`Retrying in ${delay} ms…`);
        await sleep(delay);
      }
    }
  }

  logger.error('All LLM attempts exhausted', { error: lastError?.message });
  // Annotate with a classification so the route can pick the right HTTP status
  lastError._kind = classifyError(lastError);
  throw lastError;
}

module.exports = { generateResponse, checkOllamaHealth };
