'use strict';
// startup.js must be loaded first — it provides ObsidianStartup

const API_BASE = ObsidianStartup.SPRING_API;

// OTP flow state
let _loginEmail       = '';
let _registerEmail    = '';
let _loginResendTimer = null;
let _regResendTimer   = null;
const RESEND_COOLDOWN_S = 30;

/* ════════════════════════════════════════════════════════════════
   BOOTSTRAP  — called on every auth page
════════════════════════════════════════════════════════════════ */
async function initAuthPage(type) {
  // Show error from OAuth redirect (e.g. GitHub private email)
  const params     = new URLSearchParams(window.location.search);
  const errorParam = params.get('error');
  if (errorParam) {
    window.history.replaceState({}, '', window.location.pathname);
    const msgs = {
      github_no_email: 'GitHub account has no public email. ' +
        'Set a public email on GitHub or use email OTP below.',
      oauth_failed: 'GitHub login failed. Please try again or use email OTP.',
    };
    showAlert('error', msgs[errorParam] || 'Login failed. Please try again.');
  }

  // Auto-login: valid JWT
  const token = localStorage.getItem('jwt_token');
  if (token && token !== 'undefined' && token !== 'null') {
    if (!ObsidianStartup.isJwtExpired(token)) {
      window.location.href = 'chatbot.html';
      return;
    }
    // JWT expired — try refresh
    showAlert('info', 'Refreshing your session…');
    const refreshed = await ObsidianStartup.tryRefreshToken();
    if (refreshed) {
      window.location.href = 'chatbot.html';
      return;
    }
    // Clear stale session
    ['jwt_token', 'refresh_token'].forEach(k => {
      localStorage.removeItem(k);
      sessionStorage.removeItem(k);
    });
    hideAlert();
  }

  if (type === 'login')         initLoginPage();
  else if (type === 'register') initRegisterPage();

  ObsidianStartup.startKeepAlive();
}

/* ════════════════════════════════════════════════════════════════
   LOGIN PAGE
════════════════════════════════════════════════════════════════ */
function initLoginPage() {
  wireGitHubButton('githubBtn');
  document.getElementById('sendOtpBtn')
    ?.addEventListener('click', handleSendOtp);
  document.getElementById('loginForm')
    ?.addEventListener('submit', handleVerifyOtp);
  document.getElementById('backToEmailBtn')
    ?.addEventListener('click', showLoginStep1);
  document.getElementById('resendOtpBtn')
    ?.addEventListener('click', handleResendOtp);
  initOtpDigits('loginOtpGroup');
}

/* ── Send OTP (Login step 1) ─────────────────────────────────── */
async function handleSendOtp() {
  clearErrors();
  const email = document.getElementById('email')?.value.trim();
  const btn   = document.getElementById('sendOtpBtn');

  if (!email) {
    showFieldError('emailError', 'Email is required'); return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showFieldError('emailError', 'Enter a valid email address'); return;
  }

  setLoading(btn, true);
  const t0 = Date.now();
  ObsidianStartup.log('info', 'Send OTP started', { email });

  try {
    showWakeup();

    /* Step 1 — local chatbot server */
    setStep('local', 'active', '');
    setProgress(10);
    try {
      const res = await ObsidianStartup.fetchWithTimeout(ObsidianStartup.HEALTH_URL, {}, 4000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStep('local', 'done', 'localhost:3001 ready');
      setProgress(33);
    } catch (err) {
      setStep('local', 'failed', 'start-server.bat not running');
      hideWakeup();
      showAlert('error',
        '⚠️ Local server is not running. Double-click start-server.bat and try again.');
      return;
    }

    /* Step 2 — Spring Boot backend via proxy */
    setStep('spring', 'active', 'connecting…');
    const wakeHint = setTimeout(() => {
      setStep('spring', 'active', 'Render waking up (~30 s)…');
      setProgress(45);
    }, 5000);

    let springOk = false;
    try {
      await ObsidianStartup.retryWithBackoff(
        async (attempt) => {
          setProgress(33 + Math.min(attempt * 8, 30),
            `Attempt ${attempt} • ${Math.round((Date.now() - t0) / 1000)}s`);
          const res = await ObsidianStartup.fetchWithTimeout(
            ObsidianStartup.HEALTH_SPRING, {}, 65000);
          if (!res.ok && res.status >= 500) throw new Error(`HTTP ${res.status}`);
          return res;
        },
        { maxAttempts: 3, baseDelay: 2000, maxDelay: 4000 }
      );
      springOk = true;
    } catch (_) {
      try {
        const r = await ObsidianStartup.fetchWithTimeout(
          `${API_BASE}/auth/send-otp`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
          65000);
        springOk = r.status < 500;
      } catch (_2) { springOk = false; }
    }

    clearTimeout(wakeHint);

    if (!springOk) {
      setStep('spring', 'failed', 'Backend unreachable');
      hideWakeup();
      showAlert('error',
        '⚠️ Backend is unavailable. Please try again in 1 minute.');
      return;
    }

    setStep('spring', 'done',
      `connected in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    setProgress(66);

    /* Step 3 — Send OTP */
    setStep('login', 'active', 'sending code…');
    setProgress(80);

    const res = await ObsidianStartup.fetchWithTimeout(
      `${API_BASE}/auth/send-otp`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, mode: 'login' }),
      },
      15000
    );
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      setStep('login', 'done', 'code sent ✓');
      setProgress(100);
      _loginEmail = email;
      setTimeout(() => { hideWakeup(); showLoginStep2(email); }, 600);
    } else if (res.status === 404 && data.notRegistered) {
      setStep('login', 'failed', 'not registered');
      hideWakeup();
      showAlert('error',
        `No account found for <strong>${email}</strong>. ` +
        `<a href="register.html" style="color:#C4956A;font-weight:700;">Create one for free →</a>`
      );
    } else {
      setStep('login', 'failed', data.error || 'Failed');
      hideWakeup();
      showAlert('error', data.error || 'Could not send OTP. Please try again.');
    }

  } catch (err) {
    ObsidianStartup.log('error', 'Send OTP error', err.message);
    hideWakeup();
    showAlert('error', '⚠️ Unexpected error. Please try again.');
  } finally {
    setLoading(btn, false);
  }
}

/* ── Verify OTP (Login step 2) ──────────────────────────────── */
async function handleVerifyOtp(e) {
  e.preventDefault();
  clearErrors();
  const otp        = getOtpValue('loginOtpGroup');
  const rememberMe = document.getElementById('rememberMe')?.checked ?? false;
  const btn        = document.getElementById('verifyOtpBtn');

  if (otp.length < 6) {
    showFieldError('otpError', 'Please enter the full 6-digit code'); return;
  }

  setLoading(btn, true);
  try {
    const res = await ObsidianStartup.fetchWithTimeout(
      `${API_BASE}/auth/verify-otp`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          email: _loginEmail, otp,
          rememberMe: String(rememberMe),
        }),
      },
      15000
    );
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      const token = data.token || data.access_token || '';
      if (!token) {
        showAlert('error', '⚠️ Login succeeded but no token was returned.'); return;
      }
      storeSession(token, data.refresh_token, data.name, data.email, rememberMe);
      showAlert('success', '✅ Verified! Redirecting…');
      ObsidianStartup.startKeepAlive();
      setTimeout(() => { window.location.href = 'chatbot.html'; }, 800);
    } else {
      showFieldError('otpError', data.error || 'Invalid code. Please try again.');
      clearOtpDigits('loginOtpGroup');
      document.querySelector('#loginOtpGroup .otp-digit')?.focus();
    }
  } catch (err) {
    ObsidianStartup.log('error', 'Verify OTP error', err.message);
    showAlert('error', '⚠️ Could not verify code. Please try again.');
  } finally {
    setLoading(btn, false);
  }
}

async function handleResendOtp() {
  clearErrors();
  const btn = document.getElementById('resendOtpBtn');
  btn.disabled = true;
  try {
    const res = await ObsidianStartup.fetchWithTimeout(
      `${API_BASE}/auth/send-otp`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: _loginEmail, mode: 'login' }),
      },
      15000
    );
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      showAlert('success', 'New code sent! Check your inbox.');
      clearOtpDigits('loginOtpGroup');
      document.querySelector('#loginOtpGroup .otp-digit')?.focus();
      startResendTimer('resendTimerText', 'resendOtpBtn', false);
    } else {
      showAlert('error', data.error || 'Could not resend OTP.');
      btn.disabled = false;
    }
  } catch (err) {
    showAlert('error', '⚠️ Could not resend OTP.');
    btn.disabled = false;
  }
}

function showLoginStep1() {
  document.getElementById('loginStep1').style.display = '';
  document.getElementById('loginStep2').style.display = 'none';
  clearErrors();
  clearOtpDigits('loginOtpGroup');
  if (_loginResendTimer) { clearInterval(_loginResendTimer); _loginResendTimer = null; }
}

function showLoginStep2(email) {
  document.getElementById('loginStep1').style.display = 'none';
  document.getElementById('loginStep2').style.display = '';
  const el = document.getElementById('otpEmailDisplay');
  if (el) el.textContent = email;
  clearOtpDigits('loginOtpGroup');
  setTimeout(() => document.querySelector('#loginOtpGroup .otp-digit')?.focus(), 100);
  startResendTimer('resendTimerText', 'resendOtpBtn', false);
}

/* ════════════════════════════════════════════════════════════════
   REGISTER PAGE
════════════════════════════════════════════════════════════════ */
function initRegisterPage() {
  wireGitHubButton('githubBtn');
  document.getElementById('regSendOtpBtn')
    ?.addEventListener('click', handleRegSendOtp);
  document.getElementById('registerForm')
    ?.addEventListener('submit', handleRegVerifyOtp);
  document.getElementById('regBackBtn')
    ?.addEventListener('click', showRegStep1);
  document.getElementById('regResendBtn')
    ?.addEventListener('click', handleRegResendOtp);
  initOtpDigits('regOtpGroup');
}

async function handleRegSendOtp() {
  clearErrors();
  const firstName = document.getElementById('firstName')?.value.trim();
  const lastName  = document.getElementById('lastName')?.value.trim();
  const email     = document.getElementById('email')?.value.trim();
  const terms     = document.getElementById('terms')?.checked;
  const btn       = document.getElementById('regSendOtpBtn');

  let hasError = false;
  if (!firstName) { showFieldError('firstNameError', 'First name required'); hasError = true; }
  if (!lastName)  { showFieldError('lastNameError',  'Last name required');  hasError = true; }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showFieldError('emailError', 'Enter a valid email address'); hasError = true;
  }
  if (!terms) { showFieldError('termsError', 'Accept terms to continue'); hasError = true; }
  if (hasError) return;

  setLoading(btn, true);
  try {
    // Quick server check
    let ok = false;
    try {
      const p = await ObsidianStartup.fetchWithTimeout(ObsidianStartup.HEALTH_URL, {}, 3000);
      ok = p.ok;
    } catch (_) {}

    if (!ok) {
      showAlert('info', '⏳ Server is waking up — please wait…');
      ok = await ObsidianStartup.waitForBackend(ObsidianStartup.HEALTH_URL,
        { maxWaitMs: 60000, pollMs: 3000, reqTimeoutMs: 5000 });
      if (!ok) {
        showAlert('error', '⚠️ Server unavailable. Please try again in a minute.'); return;
      }
      hideAlert();
    }

    const res = await ObsidianStartup.fetchWithTimeout(
      `${API_BASE}/auth/send-otp`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          email,
          name: `${firstName} ${lastName}`,
          mode: 'register',
        }),
      },
      15000
    );
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      _registerEmail = email;
      showRegStep2(email);
    } else {
      showAlert('error', data.error || 'Could not send OTP. Please try again.');
    }
  } catch (err) {
    ObsidianStartup.log('error', 'RegSendOtp error', err.message);
    showAlert('error', '⚠️ Unexpected error. Please try again.');
  } finally {
    setLoading(btn, false);
  }
}

async function handleRegVerifyOtp(e) {
  e.preventDefault();
  clearErrors();
  const otp       = getOtpValue('regOtpGroup');
  const firstName = document.getElementById('firstName')?.value.trim();
  const lastName  = document.getElementById('lastName')?.value.trim();
  const btn       = document.getElementById('regVerifyBtn');

  if (otp.length < 6) {
    showFieldError('regOtpError', 'Please enter the full 6-digit code'); return;
  }

  setLoading(btn, true);
  try {
    const res = await ObsidianStartup.fetchWithTimeout(
      `${API_BASE}/auth/verify-otp`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          email: _registerEmail, otp,
          name: `${firstName} ${lastName}`,
          rememberMe: 'true',
        }),
      },
      15000
    );
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      const token = data.token || data.access_token || '';
      storeSession(token, data.refresh_token, data.name, data.email, true);
      showAlert('success', '🎉 Account created! Redirecting…');
      ObsidianStartup.startKeepAlive();
      setTimeout(() => { window.location.href = 'chatbot.html'; }, 800);
    } else {
      showFieldError('regOtpError', data.error || 'Invalid code. Please try again.');
      clearOtpDigits('regOtpGroup');
      document.querySelector('#regOtpGroup .otp-digit')?.focus();
    }
  } catch (err) {
    showAlert('error', '⚠️ Could not verify code. Please try again.');
  } finally {
    setLoading(btn, false);
  }
}

async function handleRegResendOtp() {
  clearErrors();
  const btn       = document.getElementById('regResendBtn');
  const firstName = document.getElementById('firstName')?.value.trim();
  const lastName  = document.getElementById('lastName')?.value.trim();
  btn.disabled = true;
  try {
    const res = await ObsidianStartup.fetchWithTimeout(
      `${API_BASE}/auth/send-otp`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          email: _registerEmail,
          name:  `${firstName} ${lastName}`,
          mode:  'register',
        }),
      },
      15000
    );
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      showAlert('success', 'New code sent!');
      clearOtpDigits('regOtpGroup');
      document.querySelector('#regOtpGroup .otp-digit')?.focus();
      startResendTimer('regResendTimerText', 'regResendBtn', true);
    } else {
      showAlert('error', data.error || 'Could not resend OTP.');
      btn.disabled = false;
    }
  } catch (err) {
    showAlert('error', '⚠️ Could not resend OTP.');
    btn.disabled = false;
  }
}

function showRegStep1() {
  document.getElementById('regStep1').style.display = '';
  document.getElementById('regStep2').style.display = 'none';
  clearErrors();
  clearOtpDigits('regOtpGroup');
  if (_regResendTimer) { clearInterval(_regResendTimer); _regResendTimer = null; }
}

function showRegStep2(email) {
  document.getElementById('regStep1').style.display = 'none';
  document.getElementById('regStep2').style.display = '';
  const el = document.getElementById('regOtpEmail');
  if (el) el.textContent = email;
  clearOtpDigits('regOtpGroup');
  setTimeout(() => document.querySelector('#regOtpGroup .otp-digit')?.focus(), 100);
  startResendTimer('regResendTimerText', 'regResendBtn', true);
}

/* ════════════════════════════════════════════════════════════════
   OTP DIGIT INPUT HELPERS
════════════════════════════════════════════════════════════════ */
function initOtpDigits(groupId) {
  const group  = document.getElementById(groupId);
  if (!group) return;
  const digits = group.querySelectorAll('.otp-digit');
  digits.forEach((input, i) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(-1);
      if (input.value && i < digits.length - 1) digits[i + 1].focus();
      updateDigitStyles(groupId);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && i > 0) {
        digits[i - 1].focus();
        digits[i - 1].value = '';
        updateDigitStyles(groupId);
      }
      if (e.key === 'ArrowLeft'  && i > 0)               digits[i - 1].focus();
      if (e.key === 'ArrowRight' && i < digits.length - 1) digits[i + 1].focus();
    });
    input.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
      text.split('').forEach((char, idx) => { if (digits[idx]) digits[idx].value = char; });
      digits[Math.min(text.length, digits.length - 1)].focus();
      updateDigitStyles(groupId);
    });
    input.addEventListener('focus', () => input.select());
  });
}

function getOtpValue(groupId) {
  const group = document.getElementById(groupId);
  if (!group) return '';
  return Array.from(group.querySelectorAll('.otp-digit')).map(d => d.value).join('');
}

function clearOtpDigits(groupId) {
  const group = document.getElementById(groupId);
  if (!group) return;
  group.querySelectorAll('.otp-digit').forEach(d => {
    d.value = '';
    d.classList.remove('filled');
  });
}

function updateDigitStyles(groupId) {
  const group = document.getElementById(groupId);
  if (!group) return;
  group.querySelectorAll('.otp-digit').forEach(d => d.classList.toggle('filled', !!d.value));
}

/* ════════════════════════════════════════════════════════════════
   RESEND TIMER
════════════════════════════════════════════════════════════════ */
function startResendTimer(timerId, btnId, isReg) {
  const timerEl = document.getElementById(timerId);
  const btnEl   = document.getElementById(btnId);
  if (!timerEl || !btnEl) return;
  let seconds  = RESEND_COOLDOWN_S;
  btnEl.disabled = true;
  timerEl.textContent = `Resend in ${seconds}s`;
  const interval = setInterval(() => {
    seconds--;
    if (seconds <= 0) {
      clearInterval(interval);
      timerEl.textContent = '';
      btnEl.disabled = false;
    } else {
      timerEl.textContent = `Resend in ${seconds}s`;
    }
  }, 1000);
  if (isReg) {
    if (_regResendTimer) clearInterval(_regResendTimer);
    _regResendTimer = interval;
  } else {
    if (_loginResendTimer) clearInterval(_loginResendTimer);
    _loginResendTimer = interval;
  }
}

/* ════════════════════════════════════════════════════════════════
   GITHUB BUTTON WIRING
════════════════════════════════════════════════════════════════ */
const GITHUB_OAUTH_URL = 'https://obsidian-backend-n8zo.onrender.com/oauth2/authorization/github';

function wireGitHubButton(id) {
  const btn = document.getElementById(id);
  if (btn) btn.href = GITHUB_OAUTH_URL;
}

/* ════════════════════════════════════════════════════════════════
   SESSION HELPERS
════════════════════════════════════════════════════════════════ */
function storeSession(token, refreshToken, name, email, rememberMe) {
  localStorage.setItem('jwt_token',     token || '');
  localStorage.setItem('user_name',     name  || '');
  localStorage.setItem('user_email',    email || '');
  localStorage.setItem('cb_user_id',    email || '');
  localStorage.setItem('cb_user_name',  name  || '');
  localStorage.setItem('cb_user_email', email || '');
  if (refreshToken) {
    if (rememberMe) {
      localStorage.setItem('refresh_token', refreshToken);
      sessionStorage.removeItem('refresh_token');
    } else {
      sessionStorage.setItem('refresh_token', refreshToken);
      localStorage.removeItem('refresh_token');
    }
  }
}

/* ════════════════════════════════════════════════════════════════
   WAKE-UP UI  (same 3-step checklist as before)
════════════════════════════════════════════════════════════════ */
function showWakeup() {
  const box = document.getElementById('wakeupBox');
  if (box) box.style.display = '';
  hideAlert();
  setStep('local',  'pending', '');
  setStep('spring', 'idle',    '');
  setStep('login',  'idle',    '');
  setProgress(0);
}
function hideWakeup() {
  const box = document.getElementById('wakeupBox');
  if (box) box.style.display = 'none';
}
function setStep(name, state, detail) {
  const li    = document.getElementById('step-' + name);
  const icon  = document.getElementById('step-' + name + '-icon');
  const detEl = document.getElementById('step-' + name + '-detail');
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
   SHARED UI HELPERS
════════════════════════════════════════════════════════════════ */
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
  box.className     = `alert alert-${type}`;
  box.style.display = 'flex';
  msg.innerHTML     = message;
  if (icon) icon.textContent = type === 'success' ? '✅' : type === 'info' ? 'ℹ️' : '⚠️';
  clearTimeout(box._t);
  if (type !== 'info') box._t = setTimeout(hideAlert, 8000);
}
function hideAlert() {
  const box = document.getElementById('alertBox');
  if (box) box.style.display = 'none';
}
