/**
 * chatbot-app.js — Obsidian AI Research Assistant (v2)
 * Handles: history sidebar, chat, RAG, document upload, settings, delete-account.
 * All identifiers prefixed cb / cbState to guarantee zero collision.
 */
'use strict';

/* ════════════════════════════════════════════════════════════════
   CONFIG
════════════════════════════════════════════════════════════════ */
// startup.js is loaded before this file and provides ObsidianStartup with the correct API base.
const CB_API = (typeof ObsidianStartup !== 'undefined')
  ? ObsidianStartup.CHATBOT_API
  : 'http://localhost:3001/api'; // fallback for standalone use
const CB_MAX   = 4000;

/* ════════════════════════════════════════════════════════════════
   STATE
════════════════════════════════════════════════════════════════ */
const cbState = {
  userId:       null,
  userName:     'User',
  userEmail:    '',
  chatId:       null,
  chatTitle:    'New Chat',
  docs:         [],          // [{id,name,status,size,chunkCount,selected}]
  history:      [],          // [{id,title,updated_at,pinned}]
  histFilter:   '',
  renameTarget: null,
  pollTimers:   {},
  sending:      false,
  ollamaOnline: false,
  docsPanelOpen:false,
};

/* ════════════════════════════════════════════════════════════════
   BOOT
════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', cbInit);

async function cbInit() {
  cbEnsureUserId();
  cbLoadUserProfile();
  cbApplyStoredPreferences();

  await cbCheckHealth();
  await cbLoadHistory();
  await cbLoadDocuments();

  const screen = document.getElementById('cbLoadingScreen');
  if (screen) screen.classList.remove('show');
  cbFocusInput();
}

/* ── User identity ─────────────────────────────────────────────── */
function cbEnsureUserId() {
  let id = localStorage.getItem('cb_user_id');
  if (!id) { id = cbUUID(); localStorage.setItem('cb_user_id', id); }
  cbState.userId = id;
}

function cbLoadUserProfile() {
  const n = localStorage.getItem('cb_user_name')  || 'User';
  const e = localStorage.getItem('cb_user_email') || '';
  cbState.userName  = n;
  cbState.userEmail = e;
  cbUpdateUserUI();
}

function cbUpdateUserUI() {
  const ini = (cbState.userName || 'U').charAt(0).toUpperCase();
  ['cbHsAvatar', 'cbProfileAvatar'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = ini;
  });
  const els = {
    cbHsName:           cbState.userName,
    cbHsEmail:          cbState.userEmail,
    cbProfileNameDisplay: cbState.userName,
    cbProfileEmailDisplay: cbState.userEmail,
  };
  Object.entries(els).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  });
  const nameInp  = document.getElementById('cbProfileName');
  const emailInp = document.getElementById('cbProfileEmail');
  if (nameInp)  nameInp.value  = cbState.userName;
  if (emailInp) emailInp.value = cbState.userEmail;
}

function cbApplyStoredPreferences() {
  const prefs = cbGetPrefs();
  const sel = document.getElementById('cbModelSelect');
  if (sel && prefs.model) sel.value = prefs.model;
}

function cbGetPrefs() {
  try { return JSON.parse(localStorage.getItem('cb_prefs') || '{}'); } catch { return {}; }
}

/* ════════════════════════════════════════════════════════════════
   API HELPERS
════════════════════════════════════════════════════════════════ */
function cbHeaders(extra) {
  return {
    'Content-Type': 'application/json',
    'x-user-id':    cbState.userId,
    'x-user-name':  cbState.userName,
    'x-user-email': cbState.userEmail,
    ...(extra || {})
  };
}

async function cbApiFetch(path, opts) {
  const options = opts || {};
  const res = await fetch(CB_API + path, {
    ...options,
    headers: { ...cbHeaders(), ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data });
  return data;
}

/* ════════════════════════════════════════════════════════════════
   HEALTH CHECK
════════════════════════════════════════════════════════════════ */
async function cbCheckHealth() {
  try {
    const h = await cbApiFetch('/chat/health');
    cbState.ollamaOnline = h.ollama === 'online';
    const wasOffline = cbState.serverOffline;
    cbState.serverOffline = false;
    cbSetStatus(cbState.ollamaOnline ? 'ready' : 'offline',
                cbState.ollamaOnline ? 'Ready'  : 'Ollama offline');
    if (h.availableModels) cbRenderAvailableModels(h.availableModels);
    // Notify user that the server came back online
    if (wasOffline) {
      cbToast('success', '✅', 'Server is back online');
      cbLoadHistory();
      cbLoadDocuments();
    }
  } catch {
    cbState.serverOffline = true;
    cbSetStatus('offline', 'Server offline');
  }
}

// Poll every 15 seconds so the UI auto-recovers when the server starts
setInterval(cbCheckHealth, 15000);

function cbSetStatus(state, text) {
  const dot = document.getElementById('cbStatusDot');
  const txt = document.getElementById('cbStatusText');
  if (dot) { dot.className = 'cb-status-dot'; if (state !== 'ready') dot.classList.add(state); }
  if (txt) txt.textContent = text;
}

/* ════════════════════════════════════════════════════════════════
   HISTORY SIDEBAR
════════════════════════════════════════════════════════════════ */
async function cbLoadHistory() {
  try {
    const data = await cbApiFetch('/history');
    cbState.history = data.chats || [];
    cbRenderHistory();
  } catch { /* server may be starting */ }
}

function cbRenderHistory(filter) {
  const list = document.getElementById('cbHistoryList');
  if (!list) return;

  const q = (typeof filter !== 'undefined' ? filter : cbState.histFilter).toLowerCase();
  let chats = cbState.history;
  if (q) chats = chats.filter(c => (c.title || '').toLowerCase().includes(q));

  if (!chats.length) {
    list.innerHTML = `<div class="cb-hs-empty">${q ? 'No results.' : 'No conversations yet.<br>Start a new chat!'}</div>`;
    return;
  }

  const now = new Date();
  const groups = {};
  chats.forEach(c => {
    const d = new Date(c.updated_at || c.created_at);
    const lbl = cbDateLabel(d, now);
    (groups[lbl] = groups[lbl] || []).push(c);
  });

  let html = '';

  if (!q) {
    const pinned = chats.filter(c => c.pinned);
    if (pinned.length) {
      html += `<div class="cb-hist-group-label">📌 Pinned</div>`;
      html += pinned.map(cbChatItemHtml).join('');
    }
  }

  Object.entries(groups).forEach(([lbl, items]) => {
    const rows = q ? items : items.filter(c => !c.pinned);
    if (!rows.length) return;
    html += `<div class="cb-hist-group-label">${cbEsc(lbl)}</div>`;
    html += rows.map(cbChatItemHtml).join('');
  });

  list.innerHTML = html;
}

function cbChatItemHtml(c) {
  const active = c.id === cbState.chatId ? ' active' : '';
  const pin    = c.pinned ? '<span class="cb-chat-item-pin">📌</span>' : '';
  const d      = cbFmtTime(new Date(c.updated_at || c.created_at));
  const tid    = cbEsc(c.id);
  const ttl    = cbEsc((c.title || 'Chat').replace(/'/g, '&#x27;'));
  return `
  <div class="cb-chat-item${active}" data-id="${tid}" onclick="cbSelectChat('${tid}')">
    <span class="cb-chat-item-icon">💬</span>
    <div class="cb-chat-item-text">
      <div class="cb-chat-item-title">${cbEsc(c.title || 'Chat')}</div>
      <div class="cb-chat-item-meta">${cbEsc(d)}</div>
    </div>
    ${pin}
    <div class="cb-chat-actions" onclick="event.stopPropagation()">
      <button class="cb-chat-act-btn" onclick="cbPinChat('${tid}')" title="${c.pinned ? 'Unpin' : 'Pin'}">📌</button>
      <button class="cb-chat-act-btn" onclick="cbRenameChat('${tid}','${ttl}')" title="Rename">✏</button>
      <button class="cb-chat-act-btn del" onclick="cbDeleteChat('${tid}')" title="Delete">🗑</button>
    </div>
  </div>`;
}

function cbFilterHistory(q) {
  cbState.histFilter = q;
  cbRenderHistory(q);
}

/* ── Select a chat ─────────────────────────────────────────────── */
async function cbSelectChat(id) {
  if (cbState.chatId === id) return;
  try {
    const data = await cbApiFetch('/history/' + id);
    cbState.chatId    = id;
    cbState.chatTitle = data.chat?.title || 'Chat';
    const titleEl = document.getElementById('cbChatTitle');
    if (titleEl) titleEl.textContent = cbState.chatTitle;

    cbClearMessages();
    (data.messages || []).forEach(m => {
      if (m.role === 'user') {
        cbAppendUserMessage(m.content, m.created_at);
      } else if (m.role === 'assistant') {
        const sources = m.sources ? (() => { try { return JSON.parse(m.sources); } catch { return []; } })() : [];
        cbAppendAiMessage(m.content, sources, m.created_at);
      }
    });

    cbRenderHistory();
    if (window.innerWidth < 768) cbCloseHistorySidebar();
    cbScrollBottom();
  } catch {
    cbToast('error', '⚠', 'Failed to load chat');
  }
}

/* ── New chat ─────────────────────────────────────────────────── */
function cbNewChat() {
  cbState.chatId    = null;
  cbState.chatTitle = 'New Chat';
  const titleEl = document.getElementById('cbChatTitle');
  if (titleEl) titleEl.textContent = 'AI Research Assistant';
  cbClearMessages();
  cbShowWelcome();
  cbRenderHistory();
  if (window.innerWidth < 768) cbCloseHistorySidebar();
  cbFocusInput();
}

/* ── Delete chat ─────────────────────────────────────────────── */
async function cbDeleteChat(id) {
  if (!confirm('Delete this conversation?')) return;
  try {
    await cbApiFetch('/history/' + id, { method: 'DELETE' });
    cbState.history = cbState.history.filter(c => c.id !== id);
    if (cbState.chatId === id) cbNewChat();
    else cbRenderHistory();
    cbToast('success', '🗑', 'Conversation deleted');
  } catch { cbToast('error', '⚠', 'Delete failed'); }
}

/* ── Pin chat ─────────────────────────────────────────────────── */
async function cbPinChat(id) {
  const chat = cbState.history.find(c => c.id === id);
  if (!chat) return;
  const pinned = !chat.pinned;
  try {
    await cbApiFetch('/history/' + id, {
      method: 'PUT',
      body: JSON.stringify({ pinned })
    });
    chat.pinned = pinned;
    cbRenderHistory();
    cbToast('success', '📌', pinned ? 'Pinned' : 'Unpinned');
  } catch { cbToast('error', '⚠', 'Failed to update'); }
}

/* ── Rename flow ─────────────────────────────────────────────── */
function cbRenameChat(id, title) {
  cbState.renameTarget = id;
  const inp = document.getElementById('cbRenameInput');
  if (inp) inp.value = title;
  cbOpenModal('cbRenameModal');
}

async function cbConfirmRename() {
  const inp   = document.getElementById('cbRenameInput');
  const title = inp ? inp.value.trim() : '';
  const id    = cbState.renameTarget;
  if (!title || !id) return;
  try {
    await cbApiFetch('/history/' + id, { method: 'PUT', body: JSON.stringify({ title }) });
    const chat = cbState.history.find(c => c.id === id);
    if (chat) chat.title = title;
    if (cbState.chatId === id) {
      cbState.chatTitle = title;
      const el = document.getElementById('cbChatTitle');
      if (el) el.textContent = title;
    }
    cbRenderHistory();
    cbCloseModal('cbRenameModal');
    cbToast('success', '✅', 'Chat renamed');
  } catch { cbToast('error', '⚠', 'Rename failed'); }
}

function cbRenameModalClick(e) { if (e.target === e.currentTarget) cbCloseModal('cbRenameModal'); }
function cbCloseRenameModal()  { cbCloseModal('cbRenameModal'); }

/* ════════════════════════════════════════════════════════════════
   SIDEBAR TOGGLE
════════════════════════════════════════════════════════════════ */
function cbToggleHistorySidebar() {
  const sb = document.getElementById('cbHistorySidebar');
  const ov = document.getElementById('cbHistoryOverlay');
  if (!sb) return;
  sb.classList.toggle('open');
  if (window.innerWidth < 768 && ov)
    ov.classList.toggle('show', sb.classList.contains('open'));
}

function cbCloseHistorySidebar() {
  const sb = document.getElementById('cbHistorySidebar');
  const ov = document.getElementById('cbHistoryOverlay');
  if (sb) sb.classList.remove('open');
  if (ov) ov.classList.remove('show');
}

/* ════════════════════════════════════════════════════════════════
   SEND MESSAGE
════════════════════════════════════════════════════════════════ */
async function cbSendMessage() {
  if (cbState.sending) return;
  const input = document.getElementById('cbInput');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  if (text.length > CB_MAX) { cbToast('error', '⚠', 'Message too long'); return; }

  cbState.sending = true;
  input.value = '';
  cbAutoResize(input);
  cbUpdateCharCount('');
  cbHideWelcome();
  cbEnableSend(false);
  cbSetStatus('loading', 'Thinking…');

  cbAppendUserMessage(text);
  const typingId = cbShowTyping();

  const selectedDocs = cbState.docs.filter(d => d.selected && d.status === 'ready');
  const docIds = selectedDocs.map(d => d.id);
  const prefs  = cbGetPrefs();

  try {
    const res = await fetch(CB_API + '/chat', {
      method: 'POST',
      headers: cbHeaders(),
      body: JSON.stringify({
        message:    text,
        chatId:     cbState.chatId || undefined,
        docIds,
        userName:   cbState.userName,
        userEmail:  cbState.userEmail,
        model:      prefs.model || undefined
      })
    });
    const data = await res.json().catch(() => ({}));

    cbRemoveTyping(typingId);

    if (data.success) {
      cbAppendAiMessage(data.response, data.sources || []);
      if (data.isNewChat || !cbState.chatId) {
        cbState.chatId    = data.chatId;
        cbState.chatTitle = data.chatTitle || text.slice(0, 50);
        const el = document.getElementById('cbChatTitle');
        if (el) el.textContent = cbState.chatTitle;
        await cbLoadHistory();
      }
      cbSetStatus('ready', 'Ready');
    } else {
      cbAppendError(data.error || 'Unknown error', data.hint);
      cbSetStatus(cbState.ollamaOnline ? 'ready' : 'offline',
                  cbState.ollamaOnline ? 'Ready'  : 'Ollama offline');
    }
  } catch {
    cbRemoveTyping(typingId);
    cbAppendError('Server unreachable. Is the chatbot server running?',
                  'node chatbot-server/server.js');
    cbSetStatus('offline', 'Server offline');
  } finally {
    cbState.sending = false;
    cbEnableSend(true);
    cbFocusInput();
  }
}

function cbHandleKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); cbSendMessage(); }
}

function cbAutoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 180) + 'px';
}

function cbUpdateCharCount(val) {
  const el = document.getElementById('cbCharCount');
  if (!el) return;
  el.textContent = `${val.length} / ${CB_MAX}`;
  el.classList.toggle('warn', val.length > CB_MAX * 0.9);
}

function cbEnableSend(on) {
  const btn = document.getElementById('cbSendBtn');
  if (btn) btn.disabled = !on;
}

function cbFocusInput() {
  setTimeout(() => { const el = document.getElementById('cbInput'); if (el) el.focus(); }, 50);
}

function cbUseSuggestion(btn) {
  const input = document.getElementById('cbInput');
  if (!input) return;
  input.value = btn.textContent;
  cbAutoResize(input);
  cbUpdateCharCount(input.value);
  cbFocusInput();
}

/* ════════════════════════════════════════════════════════════════
   MESSAGE RENDERING
════════════════════════════════════════════════════════════════ */
function cbClearMessages() {
  const el = document.getElementById('cbMessages');
  if (el) el.innerHTML = '';
}

function cbShowWelcome() {
  const el = document.getElementById('cbMessages');
  if (!el) return;
  el.innerHTML = `
  <div class="cb-welcome" id="cbWelcome">
    <div class="cb-welcome-icon">◆</div>
    <h1 class="cb-welcome-title">Your AI Research Assistant</h1>
    <p class="cb-welcome-sub">Upload PDFs and ask questions, or chat freely. Powered by a local LLM — your data stays private.</p>
    <div class="cb-suggestions">
      <button class="cb-suggestion" onclick="cbUseSuggestion(this)">Summarize this PDF</button>
      <button class="cb-suggestion" onclick="cbUseSuggestion(this)">Generate study notes</button>
      <button class="cb-suggestion" onclick="cbUseSuggestion(this)">Generate 10 quiz questions</button>
      <button class="cb-suggestion" onclick="cbUseSuggestion(this)">What are the key findings?</button>
      <button class="cb-suggestion" onclick="cbUseSuggestion(this)">Compare the uploaded documents</button>
      <button class="cb-suggestion" onclick="cbUseSuggestion(this)">Explain the methodology used</button>
    </div>
  </div>`;
}

function cbHideWelcome() {
  const w = document.getElementById('cbWelcome');
  if (w) w.remove();
}

function cbAppendUserMessage(text, ts) {
  const time = ts ? cbFmtTime(new Date(ts)) : cbFmtTime(new Date());
  const safeText = cbEsc(text);
  const safeJs   = text.replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\n/g,'\\n');
  const row = cbEl(`
  <div class="cb-msg-row user">
    <div class="cb-bubble-wrap">
      <div class="cb-bubble">${safeText}</div>
      <div class="cb-msg-actions">
        <button class="cb-action-btn" onclick="cbCopyStr(this,'${safeJs}')">⎘ Copy</button>
      </div>
      <span class="cb-ts">${cbEsc(time)}</span>
    </div>
    <div class="cb-avatar">👤</div>
  </div>`);
  document.getElementById('cbMessages').appendChild(row);
  cbScrollBottom();
}

function cbAppendAiMessage(text, sources, ts) {
  const time   = ts ? cbFmtTime(new Date(ts)) : cbFmtTime(new Date());
  const html   = cbRenderMarkdown(text);
  const srcHtml = (sources && sources.length) ? cbRenderSources(sources) : '';
  const msgId  = 'cbMsg_' + cbUUID().slice(0, 8);

  const row = cbEl(`
  <div class="cb-msg-row ai" id="${msgId}">
    <div class="cb-avatar">◆</div>
    <div class="cb-bubble-wrap">
      <div class="cb-bubble">${html}${srcHtml}</div>
      <div class="cb-msg-actions">
        <button class="cb-action-btn" onclick="cbCopyBubble(this,'${msgId}')">⎘ Copy</button>
        <button class="cb-action-btn" onclick="cbRegenerate()">↺ Regenerate</button>
      </div>
      <span class="cb-ts">${cbEsc(time)}</span>
    </div>
  </div>`);
  document.getElementById('cbMessages').appendChild(row);

  row.querySelectorAll('pre code').forEach(block => {
    if (window.hljs) hljs.highlightElement(block);
  });

  cbScrollBottom();
}

function cbAppendError(msg, hint) {
  const row = cbEl(`
  <div class="cb-msg-row ai">
    <div class="cb-avatar">◆</div>
    <div class="cb-bubble-wrap">
      <div class="cb-error-banner">
        <span>⚠</span>
        <div>
          <div>${cbEsc(msg)}</div>
          ${hint ? `<div class="cb-error-hint">${cbEsc(hint)}</div>` : ''}
        </div>
      </div>
    </div>
  </div>`);
  document.getElementById('cbMessages').appendChild(row);
  cbScrollBottom();
}

function cbShowTyping() {
  const id  = 'cbTyping_' + cbUUID().slice(0, 8);
  const row = cbEl(`
  <div class="cb-typing-row" id="${id}">
    <div class="cb-avatar">◆</div>
    <div class="cb-typing-bubble">
      <div class="cb-typing-dot"></div>
      <div class="cb-typing-dot"></div>
      <div class="cb-typing-dot"></div>
    </div>
  </div>`);
  document.getElementById('cbMessages').appendChild(row);
  cbScrollBottom();
  return id;
}

function cbRemoveTyping(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

function cbRenderSources(sources) {
  if (!sources.length) return '';
  const items = sources.map(s => `
  <div class="cb-source-item">
    <span class="cb-source-icon">📄</span>
    <div class="cb-source-info">
      <div class="cb-source-name">${cbEsc(s.docName || 'Document')}</div>
      ${s.page ? `<div class="cb-source-page">Page ${cbEsc(String(s.page))}</div>` : ''}
      ${s.text ? `<div class="cb-source-snippet">${cbEsc(s.text.slice(0, 120))}…</div>` : ''}
    </div>
  </div>`).join('');
  return `<div class="cb-sources"><div class="cb-sources-title">Sources</div>${items}</div>`;
}

function cbRenderMarkdown(text) {
  if (window.marked) {
    try {
      marked.setOptions({ breaks: true, gfm: true });
      const raw = marked.parse(text);
      return raw.replace(/<pre><code class="language-([^"]+)">/g, (_, lang) =>
        `<div class="cb-code-block"><div class="cb-code-header">` +
        `<span class="cb-code-lang">${cbEsc(lang)}</span>` +
        `<button class="cb-copy-code-btn" onclick="cbCopyCodeBlock(this)">Copy</button></div>` +
        `<pre><code class="language-${cbEsc(lang)}">`
      ).replace(/<\/code><\/pre>/g, '</code></pre></div>');
    } catch { /* fallback */ }
  }
  return `<p>${cbEsc(text).replace(/\n/g, '<br>')}</p>`;
}

function cbScrollBottom() {
  const w = document.getElementById('cbMessagesWrapper');
  if (w) w.scrollTo({ top: w.scrollHeight, behavior: 'smooth' });
}

/* ── Message actions ─────────────────────────────────────────── */
function cbCopyStr(btn, text) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.innerHTML;
    btn.textContent = '✅ Copied';
    btn.classList.add('copied');
    setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied'); }, 2000);
  });
}

function cbCopyBubble(btn, rowId) {
  const bubble = document.querySelector('#' + rowId + ' .cb-bubble');
  const text   = bubble ? bubble.innerText : '';
  cbCopyStr(btn, text);
}

function cbCopyCodeBlock(btn) {
  const block = btn.closest('.cb-code-block');
  const code  = block ? (block.querySelector('code')?.innerText || '') : '';
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
  });
}

async function cbRegenerate() {
  const rows = document.querySelectorAll('.cb-msg-row.user .cb-bubble');
  if (!rows.length) return;
  const lastText = rows[rows.length - 1].textContent;
  const aiRows   = document.querySelectorAll('.cb-msg-row.ai');
  if (aiRows.length) aiRows[aiRows.length - 1].remove();
  const input = document.getElementById('cbInput');
  if (input) input.value = lastText;
  cbAutoResize(input);
  await cbSendMessage();
}

/* ════════════════════════════════════════════════════════════════
   EXPORT / CLEAR
════════════════════════════════════════════════════════════════ */
function cbExportChat() {
  const rows = document.querySelectorAll('.cb-msg-row');
  if (!rows.length) { cbToast('info', 'ℹ', 'Nothing to export'); return; }
  let md = `# ${cbState.chatTitle}\n_Exported ${new Date().toLocaleString()}_\n\n---\n\n`;
  rows.forEach(r => {
    const isUser = r.classList.contains('user');
    const bubble = r.querySelector('.cb-bubble');
    if (!bubble) return;
    md += `**${isUser ? 'You' : 'AI'}:** ${bubble.innerText.trim()}\n\n`;
  });
  const blob = new Blob([md], { type: 'text/markdown' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url,
    download: `${(cbState.chatTitle || 'chat').slice(0, 40)}.md`
  });
  a.click();
  URL.revokeObjectURL(url);
}

function cbClearChat() {
  if (!confirm('Clear the current chat from view? (History is preserved in sidebar)')) return;
  cbClearMessages();
  cbShowWelcome();
  cbState.chatId = null;
  const el = document.getElementById('cbChatTitle');
  if (el) el.textContent = 'AI Research Assistant';
}

/* ════════════════════════════════════════════════════════════════
   DOCUMENTS PANEL
════════════════════════════════════════════════════════════════ */
function cbToggleDocsPanel() {
  const panel = document.getElementById('cbDocsPanel');
  const ov    = document.getElementById('cbDocsOverlay');
  const btn   = document.getElementById('cbDocsToggleBtn');
  if (!panel) return;
  cbState.docsPanelOpen = !cbState.docsPanelOpen;
  panel.classList.toggle('open', cbState.docsPanelOpen);
  if (window.innerWidth <= 1100 && ov)
    ov.classList.toggle('show', cbState.docsPanelOpen);
  if (btn) btn.classList.toggle('active', cbState.docsPanelOpen);
}

function cbCloseDocsPanel() {
  cbState.docsPanelOpen = false;
  const panel = document.getElementById('cbDocsPanel');
  const ov    = document.getElementById('cbDocsOverlay');
  const btn   = document.getElementById('cbDocsToggleBtn');
  if (panel) panel.classList.remove('open');
  if (ov)    ov.classList.remove('show');
  if (btn)   btn.classList.remove('active');
}

/* ── Load documents ───────────────────────────────────────────── */
async function cbLoadDocuments() {
  try {
    const data = await cbApiFetch('/documents');
    cbState.docs = (data.documents || []).map(d => ({ ...d, selected: false }));
    cbRenderDocuments();
    cbUpdateDocBadge();
  } catch { /* ignore on first boot */ }
}

function cbRenderDocuments() {
  const list   = document.getElementById('cbDocList');
  const empty  = document.getElementById('cbDpEmpty');
  const ctrl   = document.getElementById('cbDpControls');
  const lbl    = document.getElementById('cbDpDocsLabel');
  const allBtn = document.getElementById('cbSelectAllBtn');
  if (!list) return;

  if (!cbState.docs.length) {
    list.innerHTML = '';
    if (empty) empty.style.display = '';
    if (ctrl)  ctrl.style.display  = 'none';
    return;
  }

  if (empty) empty.style.display = 'none';
  if (ctrl)  ctrl.style.display  = 'flex';
  if (lbl)   lbl.textContent     = `${cbState.docs.length} document${cbState.docs.length !== 1 ? 's' : ''}`;

  const allSel = cbState.docs.length > 0 && cbState.docs.every(d => d.selected);
  if (allBtn) allBtn.textContent = allSel ? 'Deselect All' : 'Select All';

  list.innerHTML = cbState.docs.map(doc => {
    const sz  = cbFmtSize(doc.size || 0);
    const cls = doc.status === 'ready' ? 'ready' : doc.status === 'error' ? 'error' : 'processing';
    const sel = doc.selected ? ' selected' : '';
    const chk = doc.selected ? 'checked' : '';
    const docId = cbEsc(doc.id);
    return `
    <div class="cb-doc-card${sel}" data-id="${docId}">
      <input type="checkbox" class="cb-doc-checkbox" ${chk}
             onchange="cbToggleDoc('${docId}',this.checked)"/>
      <div class="cb-doc-icon">📄</div>
      <div class="cb-doc-info">
        <div class="cb-doc-name" title="${cbEsc(doc.originalName || doc.name)}">${cbEsc(doc.originalName || doc.name || 'Document')}</div>
        <div class="cb-doc-meta">${cbEsc(sz)}${doc.chunkCount ? ' • ' + doc.chunkCount + ' chunks' : ''}</div>
        <span class="cb-doc-status ${cls}">${cls.charAt(0).toUpperCase() + cls.slice(1)}</span>
      </div>
      <button class="cb-doc-delete" onclick="cbDeleteDoc('${docId}')" title="Delete">🗑</button>
    </div>`;
  }).join('');

  cbUpdateRagBar();
}

function cbToggleDoc(id, checked) {
  const doc = cbState.docs.find(d => d.id === id);
  if (doc) doc.selected = checked;
  cbRenderDocuments();
  cbUpdateRagBar();
  cbUpdateDocBadge();
}

function cbSelectAllDocs() {
  const allSel = cbState.docs.every(d => d.selected);
  cbState.docs.forEach(d => { d.selected = !allSel; });
  cbRenderDocuments();
  cbUpdateRagBar();
  cbUpdateDocBadge();
}

function cbUpdateRagBar() {
  const bar = document.getElementById('cbRagBar');
  const txt = document.getElementById('cbRagBarText');
  const ind = document.getElementById('cbInputDocsIndicator');
  const cnt = document.getElementById('cbInputDocCount');

  const sel = cbState.docs.filter(d => d.selected && d.status === 'ready');
  if (sel.length) {
    if (bar) bar.style.display = 'flex';
    if (txt) txt.textContent   = `Using ${sel.length} document${sel.length !== 1 ? 's' : ''} for context`;
    if (ind) ind.style.display = 'flex';
    if (cnt) cnt.textContent   = sel.length;
  } else {
    if (bar) bar.style.display = 'none';
    if (ind) ind.style.display = 'none';
  }
}

function cbClearDocSelection() {
  cbState.docs.forEach(d => { d.selected = false; });
  cbRenderDocuments();
  cbUpdateRagBar();
  cbUpdateDocBadge();
}

function cbUpdateDocBadge() {
  const badge = document.getElementById('cbDocCountBadge');
  const n = cbState.docs.length;
  if (badge) {
    badge.textContent   = n;
    badge.style.display = n > 0 ? '' : 'none';
  }
}

/* ── Delete doc ───────────────────────────────────────────────── */
async function cbDeleteDoc(id) {
  if (!confirm('Remove this document? All embedded chunks will be deleted.')) return;
  try {
    await cbApiFetch('/documents/' + id, { method: 'DELETE' });
    cbState.docs = cbState.docs.filter(d => d.id !== id);
    cbRenderDocuments();
    cbUpdateDocBadge();
    cbUpdateRagBar();
    cbToast('success', '🗑', 'Document removed');
  } catch { cbToast('error', '⚠', 'Delete failed'); }
}

/* ════════════════════════════════════════════════════════════════
   PDF UPLOAD
════════════════════════════════════════════════════════════════ */
function cbTriggerPdfUpload() {
  document.getElementById('cbFileInput').click();
}

function cbHandleFileSelect(e) {
  Array.from(e.target.files || []).forEach(cbUploadFile);
  e.target.value = '';
}

function cbDragOver(e)  {
  e.preventDefault();
  const z = document.getElementById('cbUploadZone');
  if (z) z.classList.add('drag-over');
}
function cbDragLeave()  {
  const z = document.getElementById('cbUploadZone');
  if (z) z.classList.remove('drag-over');
}
function cbDrop(e) {
  e.preventDefault();
  cbDragLeave();
  const pdfs = Array.from(e.dataTransfer.files).filter(
    f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
  );
  if (!pdfs.length) { cbToast('error', '⚠', 'Only PDF files can be dropped here'); return; }
  pdfs.forEach(cbUploadFile);
}

/* Classify HTTP/network errors into human-readable strings */
function cbUploadErrorMsg(status, serverMsg) {
  if (!status || status === 0) return 'AI server is offline. Start it with start-server.bat';
  if (status === 413)          return `File too large (max 25 MB)`;
  if (status === 415)          return 'Not a valid PDF file';
  if (status === 400)          return serverMsg || 'Bad request — check the file';
  if (status === 429)          return 'Too many uploads — wait a moment and retry';
  if (status === 503)          return 'Server is busy — try again shortly';
  if (status >= 500)           return 'Server error. Please try again.';
  return serverMsg || `Upload failed (HTTP ${status})`;
}

function cbUploadFile(file) {
  console.log('[Upload] Starting:', file.name, cbFmtSize(file.size), file.type);

  // ── Client-side validation ────────────────────────────────────
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!isPdf) {
    cbToast('error', '⚠', `${file.name}: not a PDF file`);
    console.warn('[Upload] Rejected: wrong type', file.type);
    return;
  }
  if (file.size > 25 * 1024 * 1024) {
    cbToast('error', '⚠', `${file.name}: exceeds 25 MB (${cbFmtSize(file.size)})`);
    console.warn('[Upload] Rejected: too large', file.size);
    return;
  }
  if (file.size === 0) {
    cbToast('error', '⚠', `${file.name}: file is empty`);
    return;
  }

  // ── Duplicate guard ───────────────────────────────────────────
  const alreadyUploaded = cbState.docs.some(
    d => d.originalName === file.name && d.status !== 'error'
  );
  if (alreadyUploaded) {
    cbToast('info', 'ℹ', `${file.name}: already uploaded`);
    return;
  }

  const tempId = 'up_' + cbUUID().slice(0, 8);
  cbShowUploadProgress(tempId, file.name, 0, 'Preparing…');

  // userId/userName go in the FormData body, NOT as XHR request headers.
  // Custom headers (x-user-id, x-user-name) would make the multipart request
  // "non-simple" and trigger a CORS preflight. From a file:// page Chrome sends
  // Origin: null in the preflight, which most CORS configs reject.
  // Putting the same values in the body avoids the preflight entirely because
  // multipart/form-data without custom headers IS a "simple" CORS request.
  const form = new FormData();
  form.append('pdf', file);
  form.append('userId',   cbState.userId   || '');
  form.append('userName', cbState.userName || 'User');

  // ── XHR upload — gives real progress events ───────────────────
  const xhr = new XMLHttpRequest();

  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) {
      const pct = Math.min(Math.round((e.loaded / e.total) * 75), 75);
      cbUpdateUploadProgress(tempId, pct, `Uploading… ${pct}%`);
      console.log('[Upload] Progress:', pct + '%');
    }
  });

  xhr.addEventListener('load', () => {
    console.log('[Upload] Server response:', xhr.status, xhr.responseText.slice(0, 200));

    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch (_) {
      cbRemoveUploadProgress(tempId);
      cbToast('error', '⚠', `${file.name}: server returned non-JSON response`);
      return;
    }

    if (xhr.status === 201 && data.success) {
      cbUpdateUploadProgress(tempId, 80, 'Processing PDF…');
      cbPollDocStatus(tempId, data.document.id, file.name);
    } else {
      cbRemoveUploadProgress(tempId);
      const msg = cbUploadErrorMsg(xhr.status, data.error);
      cbToast('error', '⚠', `${file.name}: ${msg}`);
      console.error('[Upload] Failed:', xhr.status, data);
    }
  });

  xhr.addEventListener('error', () => {
    cbRemoveUploadProgress(tempId);
    cbToast('error', '🔌', 'AI server is offline. Double-click start-server.bat to start it.');
    cbSetStatus('offline', 'Server offline');
    cbState.serverOffline = true;
    console.error('[Upload] Network error — server not reachable');
  });

  xhr.addEventListener('timeout', () => {
    cbRemoveUploadProgress(tempId);
    cbToast('error', '⏱', `${file.name}: upload timed out (2 min). Try a smaller file.`);
    console.error('[Upload] Timeout');
  });

  xhr.open('POST', CB_API + '/documents/upload');
  // No custom headers here — userId/userName are in the FormData body above.
  // Adding ANY non-standard header here would re-introduce the CORS preflight.
  xhr.timeout = 120000; // 2 min
  xhr.send(form);

  console.log('[Upload] XHR sent to', CB_API + '/documents/upload');
}

function cbPollDocStatus(tempId, docId, fileName) {
  let attempts = 0;
  const timer = setInterval(async () => {
    attempts++;
    if (attempts > 90) {
      clearInterval(timer);
      delete cbState.pollTimers[docId];
      cbRemoveUploadProgress(tempId);
      cbToast('error', '⏱', `${fileName || 'Document'}: processing timed out`);
      return;
    }

    try {
      const data = await cbApiFetch('/documents/' + docId + '/status');
      const docName = data.document?.originalName || fileName || 'Document';

      if (data.status === 'ready') {
        const chunks = data.chunkCount || data.document?.chunkCount || 0;
        cbUpdateUploadProgress(tempId, 100, `Ready — ${chunks} chunks`);
        clearInterval(timer);
        delete cbState.pollTimers[docId];
        setTimeout(() => cbRemoveUploadProgress(tempId), 1200);
        await cbLoadDocuments();
        cbToast('success', '📄', `${docName} ready (${chunks} chunks)`);
        console.log('[Upload] Processing complete:', docId, chunks, 'chunks');

      } else if (data.status === 'error') {
        cbUpdateUploadProgress(tempId, 100, 'Processing failed');
        clearInterval(timer);
        delete cbState.pollTimers[docId];
        setTimeout(() => cbRemoveUploadProgress(tempId), 1500);
        cbToast('error', '⚠', `${docName}: PDF processing failed`);
        console.error('[Upload] Processing failed for', docId);
        await cbLoadDocuments();

      } else {
        // still processing
        const pct = Math.min(80 + Math.floor(attempts / 3), 97);
        cbUpdateUploadProgress(tempId, pct, `Processing… (${attempts * 2}s)`);
      }
    } catch (err) {
      console.warn('[Upload] Poll error (attempt ' + attempts + '):', err.message);
      if (attempts >= 5) {
        clearInterval(timer);
        delete cbState.pollTimers[docId];
        cbRemoveUploadProgress(tempId);
        cbToast('error', '⚠', 'Lost connection while processing');
      }
    }
  }, 2000);

  cbState.pollTimers[docId] = timer;
}

function cbShowUploadProgress(id, name, pct, status) {
  const list = document.getElementById('cbUploadProgressList');
  if (!list) return;
  list.appendChild(cbEl(`
  <div class="cb-upload-progress" id="${id}">
    <div class="cb-up-name">${cbEsc(name)}</div>
    <div class="cb-up-bar-wrap"><div class="cb-up-bar" style="width:${pct}%"></div></div>
    <div class="cb-up-status">${cbEsc(status)}</div>
  </div>`));
}

function cbUpdateUploadProgress(id, pct, status) {
  const el = document.getElementById(id);
  if (!el) return;
  const bar = el.querySelector('.cb-up-bar');
  const txt = el.querySelector('.cb-up-status');
  if (bar) bar.style.width = pct + '%';
  if (txt) txt.textContent = status;
}

function cbRemoveUploadProgress(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

/* ════════════════════════════════════════════════════════════════
   SETTINGS MODAL
════════════════════════════════════════════════════════════════ */
function cbOpenSettings() { cbOpenModal('cbSettingsModal'); cbLoadStats(); }
function cbCloseSettings() { cbCloseModal('cbSettingsModal'); }
function cbSettingsModalClick(e) { if (e.target === e.currentTarget) cbCloseSettings(); }

function cbSwitchTab(name, btn) {
  document.querySelectorAll('.cb-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.cb-tab-content').forEach(c => { c.style.display = 'none'; });
  if (btn) btn.classList.add('active');
  const pane = document.getElementById('cb-tab-' + name);
  if (pane) pane.style.display = '';
  if (name === 'stats')       cbLoadStats();
  if (name === 'preferences') cbLoadModels();
}

/* ── Profile ─────────────────────────────────────────────────── */
async function cbSaveProfile() {
  const nameEl  = document.getElementById('cbProfileName');
  const emailEl = document.getElementById('cbProfileEmail');
  const name    = (nameEl?.value  || '').trim() || cbState.userName;
  const email   = (emailEl?.value || '').trim() || cbState.userEmail;
  try {
    await cbApiFetch('/account/profile', {
      method: 'PUT',
      body:   JSON.stringify({ name, email })
    });
    cbState.userName  = name;
    cbState.userEmail = email;
    localStorage.setItem('cb_user_name',  name);
    localStorage.setItem('cb_user_email', email);
    cbUpdateUserUI();
    cbToast('success', '✅', 'Profile saved');
  } catch { cbToast('error', '⚠', 'Save failed'); }
}

/* ── Preferences ─────────────────────────────────────────────── */
function cbSavePreferences() {
  const sel   = document.getElementById('cbModelSelect');
  const model = sel ? sel.value : 'llama3.2';
  localStorage.setItem('cb_prefs', JSON.stringify({ ...cbGetPrefs(), model }));
  cbToast('success', '✅', 'Preferences saved');
}

async function cbLoadModels() {
  const el = document.getElementById('cbAvailableModels');
  if (!el) return;
  try {
    const data = await cbApiFetch('/chat/models');
    if (data.models && data.models.length) {
      const prefs = cbGetPrefs();
      el.innerHTML = data.models.map(m => {
        const cur = m.name === (prefs.model || 'llama3.2');
        return `<span class="cb-model-tag${cur ? ' current' : ''}">🤖 ${cbEsc(m.name)}</span>`;
      }).join('');
    } else { el.textContent = 'No models found.'; }
  } catch { el.textContent = 'Could not load models.'; }
}

function cbRenderAvailableModels(models) {
  const el = document.getElementById('cbAvailableModels');
  if (!el || !models.length) return;
  const prefs = cbGetPrefs();
  el.innerHTML = models.map(m => {
    const cur = m.name === (prefs.model || 'llama3.2');
    return `<span class="cb-model-tag${cur ? ' current' : ''}">🤖 ${cbEsc(m.name)}</span>`;
  }).join('');
}

/* ── Stats ───────────────────────────────────────────────────── */
async function cbLoadStats() {
  try {
    const data = await cbApiFetch('/account/stats');
    const s = data.stats || {};
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('cbStatChats',   s.chats ?? '—');
    set('cbStatDocs',    s.documents ?? '—');
    set('cbStatMsgs',    s.messages ?? '—');
    set('cbStatStorage', cbFmtSize(s.storage_bytes || 0));
  } catch { /* ignore */ }
}

/* ── Delete account ──────────────────────────────────────────── */
function cbOpenDeleteModal() {
  cbCloseSettings();
  cbOpenModal('cbDeleteModal');
}

function cbCloseDeleteModal() {
  cbCloseModal('cbDeleteModal');
  const inp = document.getElementById('cbDeleteConfirmInput');
  if (inp) inp.value = '';
  const btn = document.getElementById('cbConfirmDeleteBtn');
  if (btn) btn.disabled = true;
}

function cbDeleteModalClick(e) { if (e.target === e.currentTarget) cbCloseDeleteModal(); }

function cbCheckDeleteConfirm(el) {
  const btn = document.getElementById('cbConfirmDeleteBtn');
  if (btn) btn.disabled = el.value !== 'DELETE';
}

async function cbDeleteAccount() {
  const inp = document.getElementById('cbDeleteConfirmInput');
  if (!inp || inp.value !== 'DELETE') return;
  try {
    await cbApiFetch('/account', { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE' }) });
    ['cb_user_id','cb_user_name','cb_user_email','cb_prefs'].forEach(k => localStorage.removeItem(k));
    cbCloseDeleteModal();
    cbToast('success', '✅', 'Account deleted. Refreshing…');
    setTimeout(() => location.reload(), 1800);
  } catch (err) {
    cbToast('error', '⚠', err.message || 'Delete failed');
  }
}

function cbLogout() {
  ['cb_user_id','cb_user_name','cb_user_email'].forEach(k => localStorage.removeItem(k));
  location.reload();
}

/* ════════════════════════════════════════════════════════════════
   MODAL HELPERS
════════════════════════════════════════════════════════════════ */
function cbOpenModal(id)  { const el = document.getElementById(id); if (el) el.classList.add('open'); }
function cbCloseModal(id) { const el = document.getElementById(id); if (el) el.classList.remove('open'); }

/* ════════════════════════════════════════════════════════════════
   TOAST
════════════════════════════════════════════════════════════════ */
var _cbToastTimer = null;
function cbToast(type, icon, msg) {
  const t  = document.getElementById('cbToast');
  const ic = document.getElementById('cbToastIcon');
  const m  = document.getElementById('cbToastMsg');
  if (!t) return;
  if (_cbToastTimer) clearTimeout(_cbToastTimer);
  t.className = 'cb-toast ' + (type || 'info');
  if (ic) ic.textContent = icon || '';
  if (m)  m.textContent  = msg  || '';
  t.classList.add('show');
  _cbToastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

/* ════════════════════════════════════════════════════════════════
   UTILITIES
════════════════════════════════════════════════════════════════ */
function cbUUID() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function cbEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
}

function cbEl(html) {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild;
}

function cbFmtTime(d) {
  if (!d || isNaN(d)) return '';
  const now  = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60)   return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function cbDateLabel(d, now) {
  const diff = Math.floor((now - d) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7)  return d.toLocaleDateString([], { weekday: 'long' });
  if (diff < 30) return 'This month';
  return d.toLocaleDateString([], { month: 'long', year: 'numeric' });
}

function cbFmtSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024)    return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}
