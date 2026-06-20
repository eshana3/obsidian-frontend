/**
 * startup.js — Obsidian production startup layer
 * Handles: exponential backoff, backend wake-up detection,
 *          keep-alive pings, request queuing, and structured logging.
 * Loaded before auth.js and dashboard.js on every page.
 */
'use strict';

const ObsidianStartup = (() => {

  /* ── Constants ──────────────────────────────────────────────────── */
  // Determine API base at runtime so the same JS file works in all environments:
  //   • Local dev  → http://localhost:3001/api  (chatbot server running separately)
  //   • Production → https://your-app.onrender.com/api  (same origin, server serves static files)
  //   • Override   → window.OBSIDIAN_CONFIG.apiBase  (set in config.js for Vercel deployments)
  const CHATBOT_API = (() => {
    if (typeof window === 'undefined') return 'http://localhost:3001/api';
    if (window.OBSIDIAN_CONFIG && window.OBSIDIAN_CONFIG.apiBase) {
      return window.OBSIDIAN_CONFIG.apiBase.replace(/\/$/, '');
    }
    const h = window.location.hostname;
    if (h === 'localhost' || h === '127.0.0.1') {
      return 'http://localhost:3001/api';
    }
    return window.location.origin + '/api';
  })();

  const SPRING_API     = CHATBOT_API + '/spring';           // proxy prefix → Render Spring Boot
  const HEALTH_URL     = CHATBOT_API + '/health';           // chatbot server health (fast, no CORS)
  const HEALTH_SPRING  = SPRING_API  + '/health';           // Spring Boot via proxy
  const HEALTH_CHATBOT = CHATBOT_API + '/chat/health';      // Ollama/AI health
  const KEEP_ALIVE_MS  = 8 * 60 * 1000;  // 8 minutes — prevents Render sleep
  const LOG_LIMIT      = 300;

  /* ── Structured log ring-buffer ─────────────────────────────────── */
  const _logs = [];

  function log(level, msg, data) {
    const entry = {
      ts:    new Date().toISOString(),
      level: level,
      msg:   msg,
      data:  data !== undefined ? data : null,
    };
    _logs.push(entry);
    if (_logs.length > LOG_LIMIT) _logs.shift();

    const fn = level === 'error' ? console.error
             : level === 'warn'  ? console.warn
             : console.log;
    fn(`[Obsidian:${level.toUpperCase()}] ${msg}`, data !== undefined ? data : '');

    // Dispatch so diagnostics panel can listen live
    try {
      window.dispatchEvent(new CustomEvent('obsidian:log', { detail: entry }));
    } catch (_) {}
  }

  function getLogs() { return [..._logs]; }

  /* ── Sleep helper ────────────────────────────────────────────────── */
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /* ── Fetch with timeout ─────────────────────────────────────────── */
  async function fetchWithTimeout(url, opts, timeoutMs) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...opts, signal: controller.signal });
    } finally {
      clearTimeout(tid);
    }
  }

  /* ── Exponential backoff retry ──────────────────────────────────── */
  /**
   * Retries `fn` with exponential backoff.
   * @param {Function} fn         async function (attemptNumber) → result
   * @param {Object}   opts
   *   maxAttempts  {number}  default 5
   *   baseDelay    {number}  ms, default 2000
   *   maxDelay     {number}  ms, default 30000
   *   onRetry      {Function} (attempt, delayMs, error) callback
   */
  async function retryWithBackoff(fn, opts) {
    const {
      maxAttempts = 5,
      baseDelay   = 2000,
      maxDelay    = 30000,
      onRetry     = null,
    } = opts || {};

    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        log('info', `Attempt ${attempt}/${maxAttempts}`);
        return await fn(attempt);
      } catch (err) {
        lastErr = err;
        if (attempt === maxAttempts) break;

        const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
        log('warn', `Attempt ${attempt} failed — retrying in ${delay / 1000}s`, err.message);

        if (onRetry) {
          try { onRetry(attempt, delay, err); } catch (_) {}
        }
        await sleep(delay);
      }
    }
    log('error', `All ${maxAttempts} attempts failed`, lastErr?.message);
    throw lastErr;
  }

  /* ── Backend readiness poll ─────────────────────────────────────── */
  /**
   * Polls `healthUrl` until it returns 2xx or `maxWaitMs` elapses.
   * Returns true if ready, false if timed out.
   */
  async function waitForBackend(healthUrl, opts) {
    const {
      maxWaitMs    = 90000,
      pollMs       = 3000,
      reqTimeoutMs = 5000,
      onProgress   = null,   // (attemptNumber, elapsedMs) callback
    } = opts || {};

    const started = Date.now();
    let attempt   = 0;

    log('info', 'Waiting for backend', { healthUrl });

    while (true) {
      attempt++;
      const elapsed = Date.now() - started;

      if (elapsed >= maxWaitMs) {
        log('warn', `Backend not ready after ${maxWaitMs}ms`);
        return false;
      }

      try {
        const res = await fetchWithTimeout(healthUrl, {}, reqTimeoutMs);
        if (res.ok || res.status < 500) {
          log('info', `Backend ready (attempt ${attempt}, ${elapsed}ms)`);
          return true;
        }
        log('warn', `Health check returned ${res.status}`);
      } catch (err) {
        log('warn', `Health check ${attempt} failed`, err.message);
      }

      if (onProgress) {
        try { onProgress(attempt, elapsed); } catch (_) {}
      }

      const remaining = maxWaitMs - (Date.now() - started);
      if (remaining <= 0) { log('warn', 'Timeout reached'); return false; }
      await sleep(Math.min(pollMs, remaining));
    }
  }

  /* ── Keep-alive ─────────────────────────────────────────────────── */
  const PING_KEY = 'obs_last_ping';
  let _keepAliveInterval = null;

  function startKeepAlive() {
    if (_keepAliveInterval) return; // already running

    async function ping() {
      try {
        const res = await fetchWithTimeout(HEALTH_URL, {}, 8000);
        if (res.ok) {
          localStorage.setItem(PING_KEY, String(Date.now()));
          log('info', 'Keep-alive ping OK');
        }
      } catch (err) {
        log('warn', 'Keep-alive ping failed', err.message);
      }
    }

    // Ping immediately if last ping was too long ago
    const lastPing = parseInt(localStorage.getItem(PING_KEY) || '0', 10);
    if (Date.now() - lastPing > KEEP_ALIVE_MS) ping();

    _keepAliveInterval = setInterval(ping, KEEP_ALIVE_MS);
    log('info', `Keep-alive started (interval: ${KEEP_ALIVE_MS / 60000}min)`);
  }

  function stopKeepAlive() {
    if (_keepAliveInterval) {
      clearInterval(_keepAliveInterval);
      _keepAliveInterval = null;
    }
  }

  /* ── Request queue ───────────────────────────────────────────────── */
  // Lets callers enqueue requests that fire once the backend is awake.
  const _queue   = [];
  let   _draining = false;

  function enqueue(fn) {
    return new Promise((resolve, reject) => {
      _queue.push({ fn, resolve, reject });
      if (!_draining) _drain();
    });
  }

  async function _drain() {
    _draining = true;
    while (_queue.length) {
      const { fn, resolve, reject } = _queue.shift();
      try { resolve(await fn()); } catch (e) { reject(e); }
    }
    _draining = false;
  }

  /* ── Check if error looks like a cold-start / server-down ─────────── */
  function isColdStart(err) {
    if (!err) return false;
    const msg = (err.message || '').toLowerCase();
    return (
      err.name === 'TypeError' ||
      err.name === 'AbortError' ||
      msg.includes('failed to fetch') ||
      msg.includes('network') ||
      msg.includes('load failed') ||
      msg.includes('networkerror') ||
      msg.includes('fetch')
    );
  }

  /* ── Diagnostics snapshot ────────────────────────────────────────── */
  async function getDiagnostics() {
    const results = { ts: new Date().toISOString(), services: {} };

    async function probe(name, url, timeoutMs) {
      const t0 = Date.now();
      try {
        const res = await fetchWithTimeout(url, {}, timeoutMs);
        const latency = Date.now() - t0;
        let body = null;
        try { body = await res.json(); } catch (_) {}
        results.services[name] = {
          status:  res.ok ? 'online' : 'degraded',
          http:    res.status,
          latency: latency,
          body:    body,
        };
      } catch (err) {
        results.services[name] = {
          status:  'offline',
          latency: Date.now() - t0,
          error:   err.message,
        };
      }
    }

    await Promise.all([
      probe('chatbot_server', HEALTH_URL,     5000),
      probe('spring_boot',    HEALTH_SPRING,  15000),
      probe('ollama',         HEALTH_CHATBOT, 5000),
    ]);

    results.auth = {
      hasToken:  !!(localStorage.getItem('jwt_token') &&
                    localStorage.getItem('jwt_token') !== 'undefined'),
      userName:  localStorage.getItem('user_name') || null,
      lastPing:  localStorage.getItem(PING_KEY)    || null,
    };

    return results;
  }

  /* ── JWT helpers ────────────────────────────────────────────────── */
  function isJwtExpired(token) {
    if (!token || token === 'undefined' || token === 'null') return true;
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return Date.now() >= payload.exp * 1000;
    } catch (_) { return true; }
  }

  async function tryRefreshToken() {
    const refreshToken = localStorage.getItem('refresh_token')
                      || sessionStorage.getItem('refresh_token');
    if (!refreshToken) return false;
    try {
      const res = await fetchWithTimeout(
        SPRING_API + '/auth/refresh',
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ refreshToken }),
        },
        15000
      );
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const newToken = data.access_token || data.token;
        if (newToken) {
          localStorage.setItem('jwt_token', newToken);
          if (data.refresh_token) {
            if (localStorage.getItem('refresh_token')) {
              localStorage.setItem('refresh_token', data.refresh_token);
            } else {
              sessionStorage.setItem('refresh_token', data.refresh_token);
            }
          }
          log('info', 'Token refreshed successfully');
          return true;
        }
      } else {
        localStorage.removeItem('refresh_token');
        sessionStorage.removeItem('refresh_token');
        log('warn', 'Token refresh failed, clearing session');
      }
    } catch (err) {
      log('warn', 'Token refresh network error', err.message);
    }
    return false;
  }

  /* ── Public API ─────────────────────────────────────────────────── */
  return {
    log,
    getLogs,
    sleep,
    fetchWithTimeout,
    retryWithBackoff,
    waitForBackend,
    startKeepAlive,
    stopKeepAlive,
    enqueue,
    isColdStart,
    getDiagnostics,
    isJwtExpired,
    tryRefreshToken,
    SPRING_API,
    CHATBOT_API,
    HEALTH_URL,
    HEALTH_SPRING,
    HEALTH_CHATBOT,
  };

})();
