'use strict';
// startup.js must be loaded first — it provides ObsidianStartup

const API_BASE = ObsidianStartup.SPRING_API;

/* ════════════════════════════════════════════════════════════════
   BOOTSTRAP
════════════════════════════════════════════════════════════════ */
function initAuthPage(type) {
  const token = localStorage.getItem('jwt_token');
  if (token && token !== 'undefined' && token !== 'null') {
    window.location.href = 'chatbot.html';
    return;
  }
  if (type === 'login')    initLoginPage();
  else if (type === 'register') initRegisterPage();

  // Passive keep-alive so the backend stays warm while user fills the form
  ObsidianStartup.startKeepAlive();
}

/* ── Login page ──────────────────────────────────────────────── */
function initLoginPage() {
  const togglePass    = document.getElementById('togglePass');
  const passwordInput = document.getElementById('password');
  if (togglePass && passwordInput) {
    togglePass.addEventListener('click', () => {
      const isPass = passwordInput.type === 'password';
      passwordInput.type     = isPass ? 'text' : 'password';
      togglePass.textContent = isPass ? '🙈' : '👁️';
    });
  }
  const form = document.getElementById('loginForm');
  if (form) form.addEventListener('submit', handleLogin);
}

/* ── Register page ───────────────────────────────────────────── */
function initRegisterPage() {
  const togglePass    = document.getElementById('togglePass');
  const toggleConfirm = document.getElementById('toggleConfirmPass');
  const passwordInput = document.getElementById('password');
  const confirmInput  = document.getElementById('confirmPassword');
  const strengthFill  = document.getElementById('strengthFill');
  const strengthLabel = document.getElementById('strengthLabel');

  if (togglePass && passwordInput) {
    togglePass.addEventListener('click', () => {
      const isPass = passwordInput.type === 'password';
      passwordInput.type     = isPass ? 'text' : 'password';
      togglePass.textContent = isPass ? '🙈' : '👁️';
    });
  }
  if (toggleConfirm && confirmInput) {
    toggleConfirm.addEventListener('click', () => {
      const isPass = confirmInput.type === 'password';
      confirmInput.type      = isPass ? 'text' : 'password';
      toggleConfirm.textContent = isPass ? '🙈' : '👁️';
    });
  }
  if (passwordInput && strengthFill && strengthLabel) {
    passwordInput.addEventListener('input', () => {
      const s = getPasswordStrength(passwordInput.value);
      strengthFill.style.width      = s.percent + '%';
      strengthFill.style.background = s.color;
      strengthLabel.textContent     = s.label;
      strengthLabel.style.color     = s.color;
    });
  }
  const form = document.getElementById('registerForm');
  if (form) form.addEventListener('submit', handleRegister);
}

/* ════════════════════════════════════════════════════════════════
   WAKE-UP UI  —  3-step checklist
════════════════════════════════════════════════════════════════ */
function showWakeup() {
  const box = document.getElementById('wakeupBox');
  if (box) box.style.display = '';
  hideAlert();
  setStep('local',  'pending');
  setStep('spring', 'idle');
  setStep('login',  'idle');
  setProgress(0);
}

function hideWakeup() {
  const box = document.getElementById('wakeupBox');
  if (box) box.style.display = 'none';
}

// state: 'pending' | 'active' | 'done' | 'failed' | 'idle'
function setStep(name, state, detail) {
  const li     = document.getElementById('step-' + name);
  const icon   = document.getElementById('step-' + name + '-icon');
  const detEl  = document.getElementById('step-' + name + '-detail');
  if (!li) return;

  li.className = 'wakeup-step ' + (state === 'idle' ? '' : state);
  const icons  = { pending: '⏳', active: '⏳', done: '✓', failed: '✗', idle: '—' };
  if (icon)  icon.textContent  = icons[state] || '—';
  if (detEl) detEl.textContent = detail || '';
}

function setProgress(pct, label) {
  const fill = document.getElementById('wakeupFill');
  const att  = document.getElementById('wakeupAttempts');
  if (fill) fill.style.width = Math.min(pct, 97) + '%';
  if (att && label) att.textContent = label;
}

/* ════════════════════════════════════════════════════════════════
   LOGIN HANDLER
════════════════════════════════════════════════════════════════ */
async function handleLogin(e) {
  e.preventDefault();
  clearErrors();
  hideWakeup();

  const email    = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const btn      = document.getElementById('loginBtn');

  // Client-side validation
  let hasError = false;
  if (!email) {
    showFieldError('emailError', 'Email is required'); hasError = true;
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showFieldError('emailError', 'Enter a valid email'); hasError = true;
  }
  if (!password) {
    showFieldError('passwordError', 'Password is required'); hasError = true;
  }
  if (hasError) return;

  setLoading(btn, true);

  const t0 = Date.now();
  ObsidianStartup.log('info', 'Login flow started', { email });

  try {
    showWakeup();

    /* ══ STEP 1: Local server ════════════════════════════════════
       Check localhost:3001 — our chatbot server must be running
       to proxy Spring Boot requests (eliminates CORS).
    ══════════════════════════════════════════════════════════════ */
    setStep('local', 'active', '');
    setProgress(10);

    try {
      const res = await ObsidianStartup.fetchWithTimeout(
        ObsidianStartup.HEALTH_URL, {}, 4000
      );
      if (res.ok) {
        setStep('local', 'done', 'localhost:3001 ready');
        setProgress(33);
        ObsidianStartup.log('info', 'Local server OK');
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      setStep('local', 'failed', 'start-server.bat not running');
      setProgress(10);
      ObsidianStartup.log('error', 'Local server unreachable', err.message);
      hideWakeup();
      showAlert('error',
        '⚠️ Local server is not running. Double-click start-server.bat and try again.'
      );
      return;
    }

    /* ══ STEP 2: Spring Boot backend (via proxy) ══════════════════
       The proxy calls Render server-to-server — no CORS restriction.
       Render may take 30–60 s to wake from sleep.
    ══════════════════════════════════════════════════════════════ */
    setStep('spring', 'active', 'connecting…');

    // Show Render wake-up hint after 5 s
    const wakeHint = setTimeout(() => {
      setStep('spring', 'active', 'Render waking up (~30 s)…');
      setProgress(45);
    }, 5000);

    let springOk = false;
    try {
      await ObsidianStartup.retryWithBackoff(
        async (attempt) => {
          const elapsed = Math.round((Date.now() - t0) / 1000);
          setProgress(33 + Math.min(attempt * 8, 30), `Attempt ${attempt} • ${elapsed}s`);
          ObsidianStartup.log('info', `Spring health probe attempt ${attempt}`);

          const res = await ObsidianStartup.fetchWithTimeout(
            ObsidianStartup.HEALTH_SPRING, {}, 65000  // 65 s — Render may hold connection for 60 s
          );
          if (!res.ok && res.status >= 500) throw new Error(`HTTP ${res.status}`);
          return res;
        },
        { maxAttempts: 3, baseDelay: 2000, maxDelay: 4000 }
      );
      springOk = true;
    } catch (_) {
      // Health endpoint may 404 — that still means Spring Boot is awake
      // so try a known endpoint as a fallback
      try {
        const res = await ObsidianStartup.fetchWithTimeout(
          `${ObsidianStartup.SPRING_API}/auth/login`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
          65000
        );
        // 400 (validation) means app is up; 401/403 also mean app is up
        springOk = res.status < 500;
      } catch (_2) {
        springOk = false;
      }
    }

    clearTimeout(wakeHint);

    if (!springOk) {
      setStep('spring', 'failed', 'Render backend unreachable');
      hideWakeup();
      showAlert('error',
        '⚠️ Backend service is unavailable after multiple attempts. ' +
        'It may be down — please try again in 1 minute.'
      );
      ObsidianStartup.log('error', 'Spring Boot did not respond within timeout');
      return;
    }

    const wakeMs = Date.now() - t0;
    setStep('spring', 'done', `connected in ${(wakeMs / 1000).toFixed(1)}s`);
    setProgress(66);
    ObsidianStartup.log('info', `Spring Boot ready after ${wakeMs}ms`);

    /* ══ STEP 3: Authenticate ════════════════════════════════════ */
    setStep('login', 'active', 'sending credentials…');
    setProgress(80);

    const response = await ObsidianStartup.fetchWithTimeout(
      `${API_BASE}/auth/login`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, password }),
      },
      15000
    );

    const data = await response.json().catch(() => ({}));
    ObsidianStartup.log('info', 'Login response', { status: response.status });

    if (response.ok) {
      const token = data.token || data.access_token || data.accessToken || data.jwt || '';
      if (!token) {
        setStep('login', 'failed', 'no token in response');
        showAlert('error', '⚠️ Login succeeded but no session token was returned.');
        return;
      }

      localStorage.setItem('jwt_token',  token);
      localStorage.setItem('user_name',  data.name  || data.username || 'User');
      localStorage.setItem('user_email', data.email || email);

      setStep('login', 'done', 'authenticated');
      setProgress(100);
      ObsidianStartup.log('info', 'Login OK, navigating to dashboard',
        { ms: Date.now() - t0 });

      ObsidianStartup.startKeepAlive();
      setTimeout(() => { window.location.href = 'chatbot.html'; }, 600);

    } else {
      const errMsg = data.message || data.error || 'Invalid email or password.';
      setStep('login', 'failed', errMsg);
      hideWakeup();
      showAlert('error', errMsg);
      ObsidianStartup.log('warn', 'Login rejected', { status: response.status });
    }

  } catch (err) {
    ObsidianStartup.log('error', 'Login flow error', err.message);
    hideWakeup();
    showAlert('error', '⚠️ Unexpected error. Please try again.');
  } finally {
    setLoading(btn, false);
  }
}

/* ════════════════════════════════════════════════════════════════
   REGISTER HANDLER
════════════════════════════════════════════════════════════════ */
async function handleRegister(e) {
  e.preventDefault();
  clearErrors();

  const firstName = document.getElementById('firstName').value.trim();
  const lastName  = document.getElementById('lastName').value.trim();
  const email     = document.getElementById('email').value.trim();
  const password  = document.getElementById('password').value;
  const confirm   = document.getElementById('confirmPassword').value;
  const terms     = document.getElementById('terms').checked;
  const btn       = document.getElementById('registerBtn');

  let hasError = false;
  if (!firstName)  { showFieldError('firstNameError',       'First name required'); hasError = true; }
  if (!lastName)   { showFieldError('lastNameError',        'Last name required');  hasError = true; }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showFieldError('emailError', 'Enter a valid email'); hasError = true;
  }
  if (!password || password.length < 8) {
    showFieldError('passwordError', 'Min. 8 characters'); hasError = true;
  }
  if (password !== confirm) {
    showFieldError('confirmPasswordError', 'Passwords do not match'); hasError = true;
  }
  if (!terms) {
    showFieldError('termsError', 'Accept terms to continue'); hasError = true;
  }
  if (hasError) return;

  setLoading(btn, true);
  ObsidianStartup.log('info', 'Register flow started', { email });

  try {
    // Quick health check before registering
    let backendReady = false;
    try {
      const probe = await ObsidianStartup.fetchWithTimeout(ObsidianStartup.HEALTH_URL, {}, 2000);
      backendReady = probe.ok || probe.status < 500;
    } catch (_) {}

    if (!backendReady) {
      showAlert('info', '⏳ Server is waking up — please wait a moment…');
      backendReady = await ObsidianStartup.waitForBackend(
        ObsidianStartup.HEALTH_URL,
        { maxWaitMs: 60000, pollMs: 3000, reqTimeoutMs: 5000 }
      );
      if (!backendReady) {
        showAlert('error', '⚠️ Server unavailable. Please try again in a minute.');
        return;
      }
    }

    const response = await ObsidianStartup.fetchWithTimeout(
      `${API_BASE}/auth/register`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: `${firstName} ${lastName}`, email, password }),
      },
      15000
    );
    const data = await response.json();

    if (response.ok || response.status === 201) {
      ObsidianStartup.log('info', 'Registration successful');
      showAlert('success', '🎉 Account created! Redirecting to login…');
      setTimeout(() => { window.location.href = 'login.html'; }, 1500);
    } else {
      showAlert('error', data.message || data.error || 'Registration failed.');
    }
  } catch (err) {
    ObsidianStartup.log('error', 'Register error', err.message);
    showAlert('error', '⚠️ Cannot reach server. Please try again in a moment.');
  } finally {
    setLoading(btn, false);
  }
}

/* ════════════════════════════════════════════════════════════════
   OAUTH
════════════════════════════════════════════════════════════════ */
// OAuth redirects go directly to Spring Boot — browser navigation has no CORS
// restriction, so we don't need the proxy here. The proxy is only needed for
// fetch() calls where the browser enforces CORS.
function handleGoogleLogin() {
  window.location.href = `${ObsidianStartup.SPRING_DIRECT}/oauth2/authorization/google`;
}
function handleGithubLogin() {
  window.location.href = `${ObsidianStartup.SPRING_DIRECT}/oauth2/authorization/github`;
}
function handleForgotPassword(e) {
  e.preventDefault();
  alert('Implement password reset at: /api/auth/forgot-password');
}

/* ════════════════════════════════════════════════════════════════
   HELPERS
════════════════════════════════════════════════════════════════ */
function getPasswordStrength(p) {
  let s = 0;
  if (p.length >= 8)            s++;
  if (p.length >= 12)           s++;
  if (/[A-Z]/.test(p))         s++;
  if (/[0-9]/.test(p))         s++;
  if (/[^A-Za-z0-9]/.test(p)) s++;
  const levels = [
    { percent:  0, color: '#ef4444', label: '' },
    { percent: 20, color: '#ef4444', label: 'Very weak' },
    { percent: 40, color: '#f59e0b', label: 'Weak' },
    { percent: 60, color: '#eab308', label: 'Fair' },
    { percent: 80, color: '#22c55e', label: 'Strong' },
    { percent:100, color: '#06b6d4', label: 'Very strong' },
  ];
  return levels[s] || levels[0];
}

function setLoading(btn, isLoading) {
  if (!btn) return;
  btn.disabled = isLoading;
  btn.classList.toggle('loading', isLoading);
}

function showFieldError(id, msg) {
  const el = document.getElementById(id);
  if (el) el.textContent = '⚠ ' + msg;
}

function clearErrors() {
  document.querySelectorAll('.field-error').forEach(el => { el.textContent = ''; });
  hideAlert();
}

function showAlert(type, message) {
  const box  = document.getElementById('alertBox');
  const msg  = document.getElementById('alertMsg');
  const icon = document.getElementById('alertIcon');
  if (!box || !msg) return;
  box.className    = `alert alert-${type}`;
  box.style.display = 'flex';
  msg.textContent   = message;
  if (icon) icon.textContent = type === 'success' ? '✅' : type === 'info' ? 'ℹ️' : '⚠️';
  clearTimeout(box._t);
  if (type !== 'info') box._t = setTimeout(hideAlert, 7000);
}

function hideAlert() {
  const box = document.getElementById('alertBox');
  if (box) box.style.display = 'none';
}
