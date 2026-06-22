// server.js — Obsidian Research Assistant backend v2
'use strict';

// Must be registered before ANY require() so a native-module load failure
// (e.g. better-sqlite3 not compiled for this Node version) appears in Render logs.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err.message);
  console.error(err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason);
  process.exit(1);
});

require('dotenv').config();

const express   = require('express');
const rateLimit = require('express-rate-limit');
const path      = require('path');
const fs        = require('fs');
const logger    = require('./utils/logger');

// Root of the repo — one level up from chatbot-server/
const STATIC_ROOT = path.join(__dirname, '..');

const chatRoutes     = require('./routes/chat');
const documentRoutes = require('./routes/documents');
const historyRoutes  = require('./routes/history');
const accountRoutes  = require('./routes/account');

const app  = express();
const PORT = parseInt(process.env.PORT, 10) || 3001;

// ── CORS ──────────────────────────────────────────────────────────────────────
// Manual handler instead of the cors package.
// When a page is opened from file:// the browser sends Origin: null (the literal
// string "null").  Returning Access-Control-Allow-Origin: * does NOT satisfy a
// preflight whose Origin is "null" in Chrome/Edge ≥ 110.
// Solution: echo back whatever Origin value the browser sent — this always works
// because the browser then sees its own origin reflected, not a wildcard.
app.use((req, res, next) => {
  const origin = req.headers.origin; // "null" for file://, a URL for http pages, undefined for curl
  res.setHeader('Access-Control-Allow-Origin',  origin !== undefined ? origin : '*');
  res.setHeader('Vary',                         'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-user-id,x-user-name,x-user-email');
  res.setHeader('Access-Control-Max-Age',       '86400');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Request logging ───────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  logger.info(`→ ${req.method} ${req.path}`, { ip: req.ip });
  next();
});

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use('/api/', rateLimit({
  windowMs: 60_000, max: 120,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, error: 'Too many requests — please slow down.' }
}));

// ── Block sensitive server-side paths ─────────────────────────────────────────
// Prevents the browser from reading server source code or env files served
// from the static root (parent directory).
const BLOCKED_PATHS = ['/chatbot-server', '/serve.js', '/start-server.bat', '/.env', '/upload-test.html'];
app.use((req, res, next) => {
  if (BLOCKED_PATHS.some(b => req.path === b || req.path.startsWith(b + '/'))) {
    return res.status(403).end();
  }
  next();
});

// ── GitHub OAuth redirect (must be before static middleware) ─────────────────
// Register this BEFORE express.static so /auth/oauth2/github is never
// intercepted by the static file handler.
const _springBaseForOAuthEarly = (process.env.SPRING_BASE_URL || 'https://obsidian-backend-n8zo.onrender.com').replace(/\/$/, '');
app.get('/auth/oauth2/github', (_req, res) => {
  res.redirect(302, _springBaseForOAuthEarly + '/oauth2/authorization/github');
});

// ── Static files — serve the whole frontend from repo root ────────────────────
// In production (Render): __dirname = /opt/render/project/src/chatbot-server
// STATIC_ROOT = /opt/render/project/src/   → serves index.html, login.html, css/, js/ …
// HTML files get no-cache so a hard refresh always fetches the newest version.
// CSS/JS are served with ETags (browser revalidates but no stale content).
app.use(express.static(STATIC_ROOT, {
  index: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma',        'no-cache');
      res.setHeader('Expires',       '0');
    }
  },
}));

// ── Static — serve uploaded PDFs (for optional preview) ───────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── Health endpoints ───────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ready', service: 'obsidian-chatbot', version: '2.0.0' });
});

// Database health — verifies SQLite is up and returns table row counts
app.get('/api/health/database', (_req, res) => {
  try {
    const { db } = require('./database/db');
    const docs  = db.prepare('SELECT COUNT(*) AS c FROM documents').get()?.c ?? 0;
    const chunks = db.prepare('SELECT COUNT(*) AS c FROM chunks').get()?.c ?? 0;
    const chats  = db.prepare('SELECT COUNT(*) AS c FROM chats').get()?.c ?? 0;
    const withEmb = db.prepare('SELECT COUNT(*) AS c FROM chunks WHERE embedding IS NOT NULL').get()?.c ?? 0;
    res.json({ status: 'ready', documents: docs, chunks, chatsStored: chats, chunksWithEmbeddings: withEmb });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// LLM health — check which provider is configured and reachable
app.get('/api/health/llm', async (_req, res) => {
  try {
    const { checkOllamaHealth, PROVIDER } = require('./services/llm');
    const h = await checkOllamaHealth();
    res.json({ status: h.online ? 'ready' : 'offline', provider: PROVIDER, model: h.currentModel, modelAvailable: h.modelAvailable });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// Retrieval health — checks embedding provider + BM25 fallback availability
app.get('/api/health/retrieval', (_req, res) => {
  const openaiKey   = !!process.env.OPENAI_API_KEY;
  const ollamaUrl   = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const embedModel  = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
  res.json({
    status:         'ready',
    bm25:           'always-available',
    semanticSearch: openaiKey ? 'openai' : 'ollama-local',
    embeddingModel: openaiKey ? (process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small') : embedModel,
    ollamaUrl:      openaiKey ? null : ollamaUrl,
    note:           openaiKey
      ? 'Semantic embeddings via OpenAI + BM25 keyword search'
      : 'BM25 keyword search active. Semantic search requires OPENAI_API_KEY or local Ollama.',
  });
});

// Chat health — alias to the chat router's own health check
app.get('/api/health/chat', async (_req, res) => {
  try {
    const { checkOllamaHealth, PROVIDER } = require('./services/llm');
    const h = await checkOllamaHealth();
    res.json({ status: 'ready', chatbot: 'online', provider: h.provider || PROVIDER, model: h.currentModel });
  } catch (err) {
    res.status(500).json({ status: 'error', chatbot: 'online', error: err.message });
  }
});

// ── Spring Boot proxy ─────────────────────────────────────────────────────────
// Routes /api/spring/* → ${SPRING_BASE_URL}/api/*
// Bypasses CORS: the browser talks to this server (which allows it),
// and this server calls Spring Boot server-to-server (no CORS restriction).
const https = require('https');

// Read from env var so no code change is needed if the Render service URL changes.
// Falls back to the known Render URL for local dev without an .env file.
const _springBase = (process.env.SPRING_BASE_URL || 'https://obsidian-backend-n8zo.onrender.com').replace(/\/$/, '');
let SPRING_HOST = 'obsidian-backend-n8zo.onrender.com';
try { SPRING_HOST = new URL(_springBase).hostname; } catch (_) {}

app.use('/api/spring', (req, res) => {
  const targetPath = '/api' + (req.path === '/' ? '' : req.path);
  const queryStr   = Object.keys(req.query).length
    ? '?' + new URLSearchParams(req.query).toString() : '';

  let bodyStr = '';
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    bodyStr = JSON.stringify(req.body);
  }

  const options = {
    hostname: SPRING_HOST,
    port:     443,
    path:     targetPath + queryStr,
    method:   req.method,
    headers: {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      'User-Agent':   'Obsidian-Proxy/2.0',
    },
  };

  // Forward Authorization token if present
  if (req.headers.authorization) {
    options.headers['Authorization'] = req.headers.authorization;
  }
  if (bodyStr) {
    options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
  }

  logger.info(`→ PROXY ${req.method} ${targetPath}`, { host: SPRING_HOST });

  const proxyReq = https.request(options, (proxyRes) => {
    const status = proxyRes.statusCode;
    res.status(status);

    // Forward all upstream headers except hop-by-hop ones.
    const HOP_BY_HOP = new Set(['transfer-encoding', 'connection', 'keep-alive', 'proxy-connection', 'upgrade', 'te', 'trailer']);
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (!HOP_BY_HOP.has(key.toLowerCase())) res.setHeader(key, value);
    }

    // For redirects: rewrite any Location header that points to the raw Spring Boot URL
    // so the browser follows through our proxy instead of hitting Spring Boot directly (→ 403).
    if (status >= 300 && status < 400) {
      let location = proxyRes.headers.location || '';
      if (location) {
        // Absolute Spring Boot URL → rewrite to our /api/spring proxy path
        const springApiPrefix = _springBase + '/api';
        if (location.startsWith(springApiPrefix)) {
          location = '/api/spring' + location.slice(springApiPrefix.length);
        } else if (location.startsWith(_springBase)) {
          location = '/api/spring' + location.slice(_springBase.length);
        }
        res.setHeader('location', location);
      }
      logger.info(`← PROXY ${status} ${targetPath} → ${location || '?'}`);
      return res.end();
    }

    let data = '';
    proxyRes.on('data', chunk => { data += chunk; });
    proxyRes.on('end', () => {
      logger.info(`← PROXY ${status} ${targetPath} (${data.length}b)`);
      res.send(data);
    });
  });

  proxyReq.on('error', (err) => {
    logger.error('Spring proxy error', { path: targetPath, error: err.message });
    res.status(502).json({
      success: false,
      error:   'Spring Boot service is unreachable',
      details: err.message,
    });
  });

  proxyReq.setTimeout(70000, () => {
    proxyReq.destroy();
    res.status(504).json({ success: false, error: 'Spring Boot gateway timeout (70s)' });
  });

  if (bodyStr) proxyReq.write(bodyStr);
  proxyReq.end();
});

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/chat',      chatRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/history',   historyRoutes);
app.use('/api/account',   accountRoutes);

// ── Clean URL routes (no .html extension needed) ──────────────────────────────
// '/' serves index.html which contains a synchronous <head> script that
// redirects to /login (unauthenticated) or /chatbot (authenticated) before
// any page content is painted — effectively making '/' a routing shell.
// '/home' preserves the marketing landing page for direct access.
const PAGE_MAP = {
  '/':            'index.html',
  '/home':        'index.html',
  '/login':       'login.html',
  '/register':    'register.html',
  '/dashboard':   'dashboard.html',
  '/diagnostics': 'diagnostics.html',
  '/chatbot':     'chatbot.html',
  '/documents':   'documents.html',
};
Object.entries(PAGE_MAP).forEach(([route, file]) => {
  app.get(route, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma',        'no-cache');
    res.setHeader('Expires',       '0');
    res.sendFile(path.join(STATIC_ROOT, file));
  });
});

// ── SPA catch-all ─────────────────────────────────────────────────────────────
// Any route not matched above and not an /api/* route falls back to index.html.
// index.html redirects authenticated users to /dashboard and others to /login.
// This also fixes browser refresh returning 404 on deep links.
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, error: `${req.path} not found.` });
  }
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma',        'no-cache');
  res.setHeader('Expires',       '0');
  // Check if a matching .html file exists (e.g. /login.html → serve it directly)
  const htmlFile = path.join(STATIC_ROOT, req.path.endsWith('.html') ? req.path : req.path + '.html');
  if (fs.existsSync(htmlFile)) {
    return res.sendFile(htmlFile);
  }
  res.sendFile(path.join(STATIC_ROOT, 'index.html'));
});

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', { error: err.message });
  res.status(500).json({ success: false, error: 'Internal server error.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const provider = process.env.GROQ_API_KEY ? 'groq'
    : process.env.OPENAI_API_KEY           ? 'openai'
    :                                         'ollama';
  const model = provider === 'groq'   ? (process.env.GROQ_MODEL   || 'llama3-8b-8192')
              : provider === 'openai' ? (process.env.OPENAI_MODEL  || 'gpt-3.5-turbo')
              :                          (process.env.OLLAMA_MODEL  || 'llama3.2');
  const embeds = process.env.OPENAI_API_KEY
    ? `openai/${process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small'}`
    : `ollama/${process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text'} + BM25 fallback`;

  logger.info('═══════════════════════════════════════════');
  logger.info(` Obsidian Research Server  •  port ${PORT} `);
  logger.info(`  LLM provider:  ${provider} / ${model}`);
  logger.info(`  Embeddings:    ${embeds}`);
  logger.info(`  RAG retrieval: BM25 keyword (always) + semantic (when embeddings stored)`);
  logger.info('═══════════════════════════════════════════');
});
