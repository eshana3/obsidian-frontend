'use strict';
// startup.js must be loaded before this file
const API_BASE = ObsidianStartup.SPRING_API;

// ── Auth guard ────────────────────────────────────────────────────────────────
(function checkAuth() {
  const token = localStorage.getItem('jwt_token');
  if (!token || token === 'undefined' || token === 'null') {
    ObsidianStartup.log('warn', 'No valid token — redirecting to login');
    window.location.href = 'login.html';
    return;
  }
  ObsidianStartup.log('info', 'Dashboard auth check passed');
  ObsidianStartup.startKeepAlive();
  initDashboard();
})();

// ── Loading screen helpers ────────────────────────────────────────────────────
function setLoadingMsg(msg, sub) {
  const el  = document.getElementById('loadingMsg');
  const sub_ = document.getElementById('loadingSub');
  if (el)   el.textContent  = msg || '';
  if (sub_) sub_.textContent = sub || '';
}

// ── Initialization ────────────────────────────────────────────────────────────
async function initDashboard() {
  const t0 = Date.now();

  // Absolute safety net — loading screen always disappears after 12 s
  const safetyTimer = setTimeout(() => {
    ObsidianStartup.log('warn', 'Safety timer fired — forcing loading screen off');
    hideLoadingScreen();
  }, 12000);

  setLoadingMsg('Loading your workspace…', '');

  // Show cached user data immediately so the name/email aren't blank
  const name  = localStorage.getItem('user_name')  || 'User';
  const email = localStorage.getItem('user_email') || '';
  setUserInfo(name, email);

  try {
    setLoadingMsg('Connecting to server…', 'First load may take ~30 seconds');
    await loadProfile();
  } catch (e) {
    ObsidianStartup.log('warn', 'Profile fetch failed, using cached data', e.message);
    setLoadingMsg('Using cached profile', 'Server unavailable — some features offline');
  }

  setLoadingMsg('Loading content…', '');
  populateDocuments();
  populateHistory();

  clearTimeout(safetyTimer);
  ObsidianStartup.log('info', `Dashboard ready in ${Date.now() - t0}ms`);
  hideLoadingScreen();
}

// ── Profile loader ────────────────────────────────────────────────────────────
async function loadProfile() {
  const token = localStorage.getItem('jwt_token');

  // Show wake-up hint after 3 s if still waiting
  let wakeHintShown = false;
  const wakeHint = setTimeout(() => {
    wakeHintShown = true;
    setLoadingMsg('Server is waking up…', 'Render free-tier servers take ~30 s on first load');
    ObsidianStartup.log('info', 'Showing wake-up hint on dashboard');
  }, 3000);

  try {
    await ObsidianStartup.retryWithBackoff(
      async (attempt) => {
        ObsidianStartup.log('info', `Profile fetch attempt ${attempt}`);
        const res = await ObsidianStartup.fetchWithTimeout(
          `${API_BASE}/auth/profile`,
          { headers: { 'Authorization': `Bearer ${token}` } },
          9000
        );

        if (res.status === 401 || res.status === 403) {
          clearTimeout(wakeHint);
          await handleLogout();
          return; // handleLogout redirects, so this won't continue
        }

        if (res.ok) {
          const user = await res.json();
          clearTimeout(wakeHint);

          const fullName  = user.name  || user.username || '';
          const userEmail = user.email || '';

          localStorage.setItem('user_name',  fullName);
          localStorage.setItem('user_email', userEmail);
          setUserInfo(fullName, userEmail);

          const g = id => document.getElementById(id);
          const parts = fullName.split(' ');
          if (g('profileFirstName'))    g('profileFirstName').value        = parts[0] || '';
          if (g('profileLastName'))     g('profileLastName').value         = parts.slice(1).join(' ') || '';
          if (g('profileEmail'))        g('profileEmail').value            = userEmail;
          if (g('profileEmailDisplay')) g('profileEmailDisplay').textContent = userEmail;
          if (g('profileFullName'))     g('profileFullName').textContent   = fullName;

          ObsidianStartup.log('info', 'Profile loaded', { name: fullName });
          return;
        }

        // Non-401 error (e.g. 503) — treat as retriable
        if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      },
      {
        maxAttempts: 4,
        baseDelay:   2000,
        maxDelay:    10000,
        onRetry: (attempt, delay) => {
          setLoadingMsg(
            `Server starting up… (attempt ${attempt + 1})`,
            `Retrying in ${delay / 1000}s`
          );
        },
      }
    );
  } catch (err) {
    clearTimeout(wakeHint);
    if (err?.name === 'AbortError' || ObsidianStartup.isColdStart(err)) {
      ObsidianStartup.log('warn', 'Profile timed out — using cached data');
      return; // Non-fatal: continue with localStorage data
    }
    throw err;
  }
}

// ── Loading screen ────────────────────────────────────────────────────────────
function hideLoadingScreen() {
  const ls = document.getElementById('loadingScreen');
  if (!ls || !ls.classList.contains('show')) return;
  ls.style.opacity = '0';
  setTimeout(() => ls.classList.remove('show'), 320);
}

// ── User info ─────────────────────────────────────────────────────────────────
function setUserInfo(name, email) {
  const initial = (name || 'U').charAt(0).toUpperCase();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('sidebarName',        name);
  set('sidebarEmail',       email);
  set('sidebarAvatar',      initial);
  set('topbarAvatar',       initial);
  set('welcomeName',        name.split(' ')[0] || 'User');
  set('profileAvatarLarge', initial);
}

// ── Panel switching ───────────────────────────────────────────────────────────
const panels = ['dashboard', 'chat', 'documents', 'history', 'summaries', 'profile', 'settings'];
function showPanel(name) {
  panels.forEach(p => {
    const el = document.getElementById(`panel-${p}`);
    if (el) el.style.display = 'none';
  });
  const target = document.getElementById(`panel-${name}`);
  if (target) target.style.display = name === 'chat' ? 'flex' : 'block';
  if (name === 'chat') {
    const t = document.getElementById('panel-chat');
    if (t) t.style.flexDirection = 'column';
  }
  const titles = {
    dashboard: 'Dashboard', chat: 'AI Research Chat', documents: 'My Documents',
    history: 'Chat History', summaries: 'Saved Summaries', profile: 'Profile', settings: 'Settings',
  };
  const titleEl = document.getElementById('topbarTitle');
  if (titleEl) titleEl.textContent = titles[name] || 'Dashboard';
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.remove('active');
    const oc = item.getAttribute('onclick') || '';
    if (oc.includes(`'${name}'`)) item.classList.add('active');
  });
  if (window.innerWidth <= 768) {
    const sb = document.getElementById('sidebar');
    if (sb) sb.classList.remove('open');
  }
}

function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  if (sb) sb.classList.toggle('open');
}

// ── Chat ──────────────────────────────────────────────────────────────────────
function sendDashMessage() {
  const input = document.getElementById('dashChatInput');
  const area  = document.getElementById('dashChatArea');
  const text  = (input?.value || '').trim();
  if (!text) return;
  appendMessage(area, 'user', text);
  input.value = '';
  const typingId = 'typing-' + Date.now();
  appendTyping(area, typingId);
  sendToAI(text, area, typingId);
}

function sendFullMessage() {
  const input = document.getElementById('fullChatInput');
  const area  = document.getElementById('fullChatArea');
  const text  = (input?.value || '').trim();
  if (!text) return;
  appendMessage(area, 'user', text);
  input.value = '';
  const typingId = 'typing-' + Date.now();
  appendTyping(area, typingId);
  sendToAI(text, area, typingId);
}

function handleChatKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFullMessage(); }
}

function focusChatInput() {
  showPanel('chat');
  setTimeout(() => { const i = document.getElementById('fullChatInput'); if (i) i.focus(); }, 100);
}

async function sendToAI(message, chatArea, typingId) {
  const token = localStorage.getItem('jwt_token');
  try {
    const response = await fetch(`${API_BASE}/chat/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ question: message }),
    });
    removeTyping(typingId);
    if (response.ok) {
      const data = await response.json();
      appendMessage(chatArea, 'ai', data.answer || data.response || 'I received your question.');
    } else if (response.status === 401) {
      appendMessage(chatArea, 'ai', '⚠️ Session expired. Logging out…');
      setTimeout(handleLogout, 2000);
    } else {
      appendMessage(chatArea, 'ai', '⚠️ Server error. Please try again.');
    }
  } catch (e) {
    removeTyping(typingId);
    const demos = [
      'Based on your uploaded documents, this relates to transformer architectures — multi-head attention allows the model to attend to information from different representation subspaces simultaneously.',
      'According to your papers, the methodology involves dense passage retrieval followed by generative language model synthesis for accurate answers.',
      '⚠️ Demo mode — Spring Boot server is offline. Start backend with: mvn spring-boot:run',
    ];
    appendMessage(chatArea, 'ai', demos[Math.floor(Math.random() * demos.length)]);
  }
}

function appendMessage(area, role, text) {
  if (!area) return;
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const safe = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  div.innerHTML = `<div class="msg-avatar">${role === 'ai' ? '🤖' : 'E'}</div><div class="msg-bubble">${safe}</div>`;
  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
}

function appendTyping(area, id) {
  if (!area) return;
  const div = document.createElement('div');
  div.className = 'msg ai'; div.id = id;
  div.innerHTML = '<div class="msg-avatar">🤖</div><div class="msg-bubble" style="padding:12px 16px;"><div style="display:flex;gap:5px;align-items:center;"><span style="width:7px;height:7px;background:#C4956A;border-radius:50%;animation:typingBounce 1.2s ease-in-out infinite;"></span><span style="width:7px;height:7px;background:#C4956A;border-radius:50%;animation:typingBounce 1.2s ease-in-out 0.2s infinite;"></span><span style="width:7px;height:7px;background:#C4956A;border-radius:50%;animation:typingBounce 1.2s ease-in-out 0.4s infinite;"></span></div></div>';
  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
}

function removeTyping(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

// ── Documents ─────────────────────────────────────────────────────────────────
const sampleDocs = [
  { name: 'Attention Is All You Need.pdf',       icon: 'arxiv', emoji: '🔬', time: '2 days ago' },
  { name: 'BERT Pre-training Deep.pdf',          icon: 'pdf',   emoji: '📕', time: '5 days ago' },
  { name: 'RAG Knowledge-Intensive NLP.pdf',     icon: 'arxiv', emoji: '🔬', time: '1 week ago' },
  { name: 'GPT-4 Technical Report.pdf',          icon: 'pdf',   emoji: '📕', time: '2 weeks ago' },
];

function populateDocuments() {
  const list = document.getElementById('allDocsList');
  if (!list) return;
  list.innerHTML = sampleDocs.map(d =>
    `<div class="doc-item">
       <div class="doc-icon ${d.icon}">${d.emoji}</div>
       <div><div class="doc-name">${d.name}</div><div class="doc-meta">${d.time}</div></div>
       <div class="doc-actions">
         <button class="doc-btn" onclick="showPanel('chat')">💬</button>
         <button class="doc-btn" onclick="this.closest('.doc-item').remove();showToast('success','🗑️ Deleted.')">🗑️</button>
       </div>
     </div>`
  ).join('');
}

const sampleHistory = [
  { title: 'Transformer attention mechanisms explained', time: '2h ago' },
  { title: 'BERT vs GPT: Key differences',              time: 'Yesterday' },
  { title: 'RAG pipeline architecture overview',        time: '3 days ago' },
  { title: 'How does positional encoding work?',        time: '5 days ago' },
];

function populateHistory() {
  const list = document.getElementById('fullHistoryList');
  if (!list) return;
  list.innerHTML = sampleHistory.map(h =>
    `<div class="history-item">
       <span class="history-dot"></span>
       <span class="history-title">${h.title}</span>
       <span class="history-time">${h.time}</span>
     </div>`
  ).join('');
}

// ── File upload ───────────────────────────────────────────────────────────────
function triggerFileInput() {
  const fi = document.getElementById('fileInput');
  if (fi) fi.click();
}

function handleDragOver(e) {
  e.preventDefault();
  const uz = document.getElementById('uploadZone');
  if (uz) uz.classList.add('drag-over');
}

function handleDrop(e) {
  e.preventDefault();
  const uz = document.getElementById('uploadZone');
  if (uz) uz.classList.remove('drag-over');
  const files = e.dataTransfer?.files;
  if (files?.length > 0) uploadFile(files[0]);
}

function handleFileUpload(e) {
  const file = e.target?.files?.[0];
  if (file) uploadFile(file);
}

async function uploadFile(file) {
  showToast('info', `⏳ Uploading "${file.name}"…`);
  const token = localStorage.getItem('jwt_token');
  try {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch(`${API_BASE}/documents/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: fd,
    });
    if (r.ok) {
      showToast('success', `✅ "${file.name}" uploaded!`);
      populateDocuments();
    } else {
      showToast('error', '❌ Upload failed.');
    }
  } catch (e) {
    showToast('success', `✅ (Demo) "${file.name}" would upload when server runs.`);
  }
}

// ── Profile update ────────────────────────────────────────────────────────────
async function updateProfile(e) {
  e.preventDefault();
  const token     = localStorage.getItem('jwt_token');
  const firstName = (document.getElementById('profileFirstName')?.value || '').trim();
  const lastName  = (document.getElementById('profileLastName')?.value  || '').trim();
  const email     = (document.getElementById('profileEmail')?.value     || '').trim();
  const fullName  = `${firstName} ${lastName}`.trim();
  try {
    const r = await fetch(`${API_BASE}/auth/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ name: fullName, email }),
    });
    if (r.ok) {
      localStorage.setItem('user_name', fullName);
      localStorage.setItem('user_email', email);
      setUserInfo(fullName, email);
      showToast('success', '✅ Profile updated!');
    } else {
      showToast('error', '❌ Could not update profile.');
    }
  } catch (e) {
    localStorage.setItem('user_name', fullName);
    localStorage.setItem('user_email', email);
    setUserInfo(fullName, email);
    showToast('success', '✅ (Demo) Profile updated locally.');
  }
}

// ── Logout ────────────────────────────────────────────────────────────────────
async function handleLogout() {
  const token = localStorage.getItem('jwt_token');
  try {
    await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
    });
  } catch (e) { /* ignore — clear session regardless */ }
  localStorage.removeItem('jwt_token');
  localStorage.removeItem('user_name');
  localStorage.removeItem('user_email');
  window.location.href = 'login.html';
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimeout;
function showToast(type, message) {
  const toast = document.getElementById('toast');
  const msg   = document.getElementById('toastMsg');
  const icon  = document.getElementById('toastIcon');
  if (!toast || !msg) return;
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  toast.className = `toast ${type} show`;
  msg.textContent  = message;
  if (icon) icon.textContent = icons[type] || 'ℹ️';
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 4000);
}

// ── Keyboard shortcut ─────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); focusChatInput(); }
});

// ── Typing animation ──────────────────────────────────────────────────────────
const _style = document.createElement('style');
_style.textContent = '@keyframes typingBounce{0%,100%{transform:translateY(0);opacity:.5}50%{transform:translateY(-5px);opacity:1}}';
document.head.appendChild(_style);
