// services/llm.js — Multi-provider LLM service
// Provider priority (auto-detected from env vars):
//   1. Groq  — set GROQ_API_KEY   (free tier, fast, no credit card needed)
//   2. OpenAI — set OPENAI_API_KEY
//   3. Ollama — default for local development (http://localhost:11434)
'use strict';

const axios  = require('axios');
const logger = require('../utils/logger');

// ── Configuration ─────────────────────────────────────────────────────────────

const GROQ_API_KEY   = process.env.GROQ_API_KEY;
const GROQ_MODEL     = process.env.GROQ_MODEL    || 'llama3-8b-8192';
const GROQ_BASE_URL  = 'https://api.groq.com/openai/v1';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL  || 'gpt-3.5-turbo';
const OPENAI_BASE_URL = 'https://api.openai.com/v1';

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL    = process.env.OLLAMA_MODEL    || 'llama3.2';

const LLM_TIMEOUT  = parseInt(process.env.OLLAMA_TIMEOUT, 10) || 60_000;
const MAX_RETRIES  = parseInt(process.env.MAX_RETRIES,    10) || 2;

// Resolve provider once at startup
const PROVIDER = GROQ_API_KEY ? 'groq' : OPENAI_API_KEY ? 'openai' : 'ollama';

// ── Startup warning if no cloud API key set ───────────────────────────────────
if (!GROQ_API_KEY && !OPENAI_API_KEY) {
  logger.warn('═══════════════════════════════════════════════════════════════');
  logger.warn('  WARNING: No GROQ_API_KEY or OPENAI_API_KEY found in environment.');
  logger.warn('  Chat will fail unless Ollama is running at ' + OLLAMA_BASE_URL);
  logger.warn('  FIX: Get a free key at console.groq.com and set GROQ_API_KEY');
  logger.warn('═══════════════════════════════════════════════════════════════');
}

logger.info(`LLM provider: ${PROVIDER}`, {
  model: PROVIDER === 'groq' ? GROQ_MODEL : PROVIDER === 'openai' ? OPENAI_MODEL : OLLAMA_MODEL,
  ollamaUrl: PROVIDER === 'ollama' ? OLLAMA_BASE_URL : undefined
});

// ── Provider implementations ──────────────────────────────────────────────────

async function callGroq(messages, systemPrompt) {
  const body = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : [...messages];

  const { data } = await axios.post(
    `${GROQ_BASE_URL}/chat/completions`,
    { model: GROQ_MODEL, messages: body, temperature: 0.7, max_tokens: 2048 },
    {
      timeout: LLM_TIMEOUT,
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' }
    }
  );

  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Groq returned an empty response.');
  return content;
}

async function callOpenAI(messages, systemPrompt) {
  const body = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : [...messages];

  const { data } = await axios.post(
    `${OPENAI_BASE_URL}/chat/completions`,
    { model: OPENAI_MODEL, messages: body, temperature: 0.7, max_tokens: 2048 },
    {
      timeout: LLM_TIMEOUT,
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }
    }
  );

  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned an empty response.');
  return content;
}

async function callOllama(messages, systemPrompt) {
  const body = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : [...messages];

  const { data } = await axios.post(
    `${OLLAMA_BASE_URL}/api/chat`,
    {
      model: OLLAMA_MODEL,
      messages: body,
      stream: false,
      options: { temperature: 0.7, top_p: 0.9, num_predict: 2048 }
    },
    { timeout: LLM_TIMEOUT, headers: { 'Content-Type': 'application/json' } }
  );

  const content = data?.message?.content;
  if (!content) throw new Error('Ollama returned an empty response.');
  return content;
}

// ── Error classification ──────────────────────────────────────────────────────

function classifyError(err) {
  const status = err.response?.status;
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    // Special case: if provider is ollama and no API key set, give a clear message
    if (PROVIDER === 'ollama') return 'no_api_key';
    return 'provider_down';
  }
  if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) return 'timeout';
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 404) return 'model_not_found';
  if (status === 429) return 'rate_limited';
  if (status === 400) return 'bad_request';
  return 'unknown';
}

// ── Public API ────────────────────────────────────────────────────────────────

async function checkOllamaHealth() {
  if (PROVIDER === 'groq') {
    return {
      online: true,
      modelAvailable: true,
      currentModel: GROQ_MODEL,
      provider: 'groq',
      models: [{ name: GROQ_MODEL }]
    };
  }

  if (PROVIDER === 'openai') {
    return {
      online: true,
      modelAvailable: true,
      currentModel: OPENAI_MODEL,
      provider: 'openai',
      models: [{ name: OPENAI_MODEL }]
    };
  }

  // Ollama — ping the local daemon
  try {
    const { data } = await axios.get(`${OLLAMA_BASE_URL}/api/tags`, { timeout: 5_000 });
    const models = (data.models || []).map(m => ({ name: m.name }));
    const modelAvailable = models.some(m => m.name === OLLAMA_MODEL || m.name.startsWith(`${OLLAMA_MODEL}:`));
    return { online: true, modelAvailable, currentModel: OLLAMA_MODEL, provider: 'ollama', models };
  } catch (err) {
    logger.warn('Ollama health check failed — no API key set and Ollama unreachable', { error: err.message });
    return { online: false, modelAvailable: false, currentModel: OLLAMA_MODEL, provider: 'ollama', models: [] };
  }
}

async function generateResponse(messages, systemPrompt) {
  // Guard: if no API key and Ollama clearly won't work on this host, fail fast with helpful message
  if (PROVIDER === 'ollama') {
    // Try once and fail fast rather than waiting for timeout
    try {
      const content = await callOllama(messages, systemPrompt);
      return content;
    } catch (err) {
      const kind = classifyError(err);
      if (kind === 'no_api_key' || err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        const helpErr = new Error('No AI provider configured.');
        helpErr._kind = 'no_api_key';
        throw helpErr;
      }
      err._kind = kind;
      throw err;
    }
  }

  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info('LLM request', { attempt, provider: PROVIDER });

      let content;
      if (PROVIDER === 'groq')        content = await callGroq(messages, systemPrompt);
      else if (PROVIDER === 'openai') content = await callOpenAI(messages, systemPrompt);
      else                            content = await callOllama(messages, systemPrompt);

      logger.info('LLM response', { provider: PROVIDER, chars: content.length });
      return content;

    } catch (err) {
      lastError = err;
      const kind = classifyError(err);

      logger.warn(`LLM attempt ${attempt}/${MAX_RETRIES} failed`, {
        kind, provider: PROVIDER, error: err.message, status: err.response?.status
      });

      if (kind === 'auth_failed' || kind === 'model_not_found' || kind === 'bad_request') break;

      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }

  lastError._kind = classifyError(lastError);
  throw lastError;
}

module.exports = { generateResponse, checkOllamaHealth, PROVIDER };
