'use strict';
// startup.js must be loaded before this — provides ObsidianStartup

// ── Auth guard ────────────────────────────────────────────────────────────────
(function () {
  const token = localStorage.getItem('jwt_token');
  if (!token || token === 'undefined' || token === 'null') {
    window.location.href = 'login.html';
  }
})();

// ── Constants ─────────────────────────────────────────────────────────────────
const API = (typeof ObsidianStartup !== 'undefined' ? ObsidianStartup.CHATBOT_API : '') + '/documents';

const userId    = localStorage.getItem('user_email') || localStorage.getItem('jwt_token')?.slice(0, 16) || 'anonymous';
const userName  = localStorage.getItem('user_name')  || 'User';

// ── State ─────────────────────────────────────────────────────────────────────
let allDocs     = [];
let activeDocId = null;
let activeTab   = 'upload';
let currentPage = 1;
let totalPages  = 0;
let pollTimer   = null;

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function userHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-user-id':    userId,
    'x-user-name':  userName,
  };
}

// ── Initialise ────────────────────────────────────────────────────────────────
async function init() {
  // Populate user info in topbar
  const initial = (userName || 'U').charAt(0).toUpperCase();
  const av = $('topbarAvatar');
  if (av) av.textContent = initial;
  const un = $('topbarUserName');
  if (un) un.textContent = userName;

  await loadDocuments();
  setupUploadZone();
}

// ── Document list ─────────────────────────────────────────────────────────────
async function loadDocuments(search = '') {
  try {
    const url = search ? `${API}?q=${encodeURIComponent(search)}` : API;
    const res  = await fetch(url, { headers: userHeaders() });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    allDocs = data.documents || [];
    renderDocList(allDocs);
    $('sidebarCount').textContent = allDocs.length;

    // Resume polling any "processing" docs
    const processing = allDocs.filter(d => d.status === 'processing');
    if (processing.length > 0) {
      startPolling(processing.map(d => d.id));
    }
  } catch (err) {
    console.error('Load documents error:', err);
    showToast('error', 'Could not load documents.');
  }
}

function renderDocList(docs) {
  const list = $('docList');
  if (!list) return;

  if (docs.length === 0) {
    list.innerHTML = `<div class="sidebar-empty">
      <div class="sidebar-empty-icon">📂</div>
      <div>No documents yet</div>
      <div style="margin-top:6px;font-size:.76rem">Upload a PDF, DOCX, or TXT above</div>
    </div>`;
    return;
  }

  list.innerHTML = docs.map(doc => `
    <div class="doc-item ${doc.id === activeDocId ? 'active' : ''}" onclick="selectDoc('${doc.id}')">
      <div class="doc-type-icon ${doc.fileType || 'pdf'}">${typeIcon(doc.fileType)}</div>
      <div class="doc-item-info">
        <div class="doc-item-name" title="${escHtml(doc.originalName)}">${escHtml(doc.originalName)}</div>
        <div class="doc-item-meta">
          <span class="status-badge ${doc.status}">${statusLabel(doc.status)}</span>
          <span>${doc.pages > 0 ? doc.pages + 'p' : ''}</span>
          <span>${fmtSize(doc.size)}</span>
        </div>
      </div>
      <button class="doc-item-del" onclick="deleteDoc(event,'${doc.id}')" title="Delete">🗑</button>
    </div>
  `).join('');
}

function typeIcon(type) {
  const icons = { pdf: '📄', docx: '📝', txt: '📃' };
  return icons[type] || '📄';
}

function statusLabel(s) {
  const m = { processing: '⏳ Processing', ready: '✅ Ready', error: '❌ Error' };
  return m[s] || s;
}

// ── Select document ───────────────────────────────────────────────────────────
async function selectDoc(docId) {
  activeDocId = docId;
  currentPage = 1;
  renderDocList(allDocs);  // update active highlight

  const doc = allDocs.find(d => d.id === docId);
  if (!doc) return;

  if (doc.status === 'processing') {
    showTab('upload');
    showToast('info', 'Document is still processing…');
    return;
  }

  showTab('metadata');
  await loadMetadata(docId);
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function showTab(name) {
  activeTab = name;
  ['upload', 'metadata', 'text', 'validation'].forEach(t => {
    const panel = $('tab-' + t);
    const btn   = $('tabBtn-' + t);
    if (panel) panel.hidden = (t !== name);
    if (btn)   btn.classList.toggle('active', t === name);
  });
}

// ── Metadata tab ──────────────────────────────────────────────────────────────
async function loadMetadata(docId) {
  const panel = $('tab-metadata');
  if (!panel) return;
  panel.innerHTML = '<div style="text-align:center;padding:40px"><span class="spinner-ring"></span></div>';

  try {
    const res  = await fetch(`${API}/${docId}`, { headers: userHeaders() });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    renderMetadata(data.document);
  } catch (err) {
    panel.innerHTML = `<p style="color:var(--red)">Failed to load metadata: ${escHtml(err.message)}</p>`;
  }
}

function renderMetadata(doc) {
  const m = field => doc[field] != null ? escHtml(String(doc[field])) : '<span class="null">Not available</span>';

  $('tab-metadata').innerHTML = `
    <div class="meta-section-title">📋 Basic Information</div>
    <div class="meta-grid">
      <div class="meta-card"><div class="meta-label">Title</div><div class="meta-value">${m('title')}</div></div>
      <div class="meta-card"><div class="meta-label">Authors</div><div class="meta-value">${m('authors')}</div></div>
      <div class="meta-card"><div class="meta-label">Year</div><div class="meta-value">${m('year')}</div></div>
      <div class="meta-card"><div class="meta-label">File Type</div><div class="meta-value">${(doc.fileType || 'pdf').toUpperCase()}</div></div>
    </div>
    <div class="meta-section-title">📊 File Details</div>
    <div class="meta-grid">
      <div class="meta-card"><div class="meta-label">File Name</div><div class="meta-value">${escHtml(doc.originalName)}</div></div>
      <div class="meta-card"><div class="meta-label">File Size</div><div class="meta-value">${fmtSize(doc.size)}</div></div>
      <div class="meta-card"><div class="meta-label">Pages</div><div class="meta-value">${doc.pages > 0 ? doc.pages : '<span class="null">—</span>'}</div></div>
      <div class="meta-card"><div class="meta-label">Text Chunks (RAG)</div><div class="meta-value">${doc.chunkCount || 0}</div></div>
    </div>
    <div class="meta-section-title">🔬 Research Metadata</div>
    <div class="meta-grid">
      <div class="meta-card"><div class="meta-label">Keywords</div><div class="meta-value">${m('keywords')}</div></div>
      <div class="meta-card"><div class="meta-label">DOI</div><div class="meta-value meta-doi">${m('doi')}</div></div>
    </div>
    <div class="meta-section-title">⏱️ Processing</div>
    <div class="meta-grid">
      <div class="meta-card"><div class="meta-label">Upload Date</div><div class="meta-value">${fmtDate(doc.uploadDate)}</div></div>
      <div class="meta-card"><div class="meta-label">Status</div><div class="meta-value"><span class="status-badge ${doc.status}">${statusLabel(doc.status)}</span></div></div>
    </div>
  `;
}

// ── Text tab ──────────────────────────────────────────────────────────────────
async function loadTextTab(docId) {
  const panel = $('tab-text');
  if (!panel) return;
  panel.innerHTML = '<div style="text-align:center;padding:40px"><span class="spinner-ring"></span></div>';

  try {
    const res  = await fetch(`${API}/${docId}/pages`, { headers: userHeaders() });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    totalPages  = data.total || 0;
    currentPage = 1;
    renderTextTab(data.pages);
  } catch (err) {
    panel.innerHTML = `<p style="color:var(--red)">Failed to load text: ${escHtml(err.message)}</p>`;
  }
}

function renderTextTab(pages) {
  if (!pages || pages.length === 0) {
    $('tab-text').innerHTML = `
      <div class="viewer-placeholder">
        <div class="viewer-placeholder-icon">📭</div>
        <div class="viewer-placeholder-text">No extracted text available</div>
      </div>`;
    return;
  }

  totalPages = pages.length;
  window._docPages = pages;

  $('tab-text').innerHTML = `
    <div class="text-nav">
      <label>Page</label>
      <button class="text-prev" onclick="changePage(-1)" id="btnPrev">◀ Prev</button>
      <span class="text-page-info" id="pageInfo">1 / ${totalPages}</span>
      <button class="text-next" onclick="changePage(1)" id="btnNext">Next ▶</button>
      <select class="text-page-select" id="pageSelect" onchange="jumpToPage(this.value)">
        ${pages.map(p => `<option value="${p.page_number}">Page ${p.page_number} — ${p.status}</option>`).join('')}
      </select>
    </div>
    <div id="pageContent"></div>
  `;

  renderPage(1);
}

function renderPage(num) {
  currentPage = num;
  const pages = window._docPages || [];
  const page  = pages.find(p => p.page_number === num) || pages[num - 1];
  if (!page) return;

  const content = $('pageContent');
  if (!content) return;

  const isEmpty = !page.text || page.text.trim().length === 0;
  content.innerHTML = `
    <div class="page-card">
      <div class="page-card-header">
        <span class="page-num">PAGE ${page.page_number}</span>
        <span class="page-status-badge ${page.status}">${page.status}</span>
        ${page.ocr_required ? '<span style="font-size:.72rem;color:var(--amber)">⚠️ OCR needed</span>' : ''}
        <span class="page-words">${page.word_count} words · ${page.char_count} chars</span>
      </div>
      <div class="page-text ${isEmpty ? 'empty' : ''}">${isEmpty ? (page.status === 'SCANNED' ? 'Image-only page — OCR required to extract text.' : 'No text content on this page.') : escHtml(page.text)}</div>
    </div>
  `;

  // Update nav controls
  const info  = $('pageInfo');
  const prev  = $('btnPrev');
  const next  = $('btnNext');
  const sel   = $('pageSelect');
  if (info) info.textContent = `${num} / ${totalPages}`;
  if (prev) prev.disabled = num <= 1;
  if (next) next.disabled = num >= totalPages;
  if (sel)  sel.value     = num;
}

function changePage(delta) {
  const next = currentPage + delta;
  if (next < 1 || next > totalPages) return;
  renderPage(next);
}

function jumpToPage(val) {
  renderPage(parseInt(val, 10));
}

// ── Validation tab ────────────────────────────────────────────────────────────
async function loadValidationTab(docId) {
  const panel = $('tab-validation');
  if (!panel) return;
  panel.innerHTML = '<div style="text-align:center;padding:40px"><span class="spinner-ring"></span></div>';

  try {
    const res  = await fetch(`${API}/${docId}/validation`, { headers: userHeaders() });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    renderValidation(data.report, data.pages);
  } catch (err) {
    panel.innerHTML = `<p style="color:var(--red)">No validation report available yet.</p>`;
  }
}

function renderValidation(report, pages) {
  const statusIcon = { SUCCESS: '✅', PARTIAL: '⚠️', FAILED: '❌', PENDING: '⏳' };

  $('tab-validation').innerHTML = `
    <div class="val-overall ${report.status}">
      ${statusIcon[report.status] || '?'} Overall: ${report.status}
    </div>
    <div class="val-summary">
      <div class="val-stat total">
        <div class="val-stat-num">${report.totalPages}</div>
        <div class="val-stat-label">Total Pages</div>
      </div>
      <div class="val-stat success">
        <div class="val-stat-num">${report.processedPages}</div>
        <div class="val-stat-label">Processed</div>
      </div>
      <div class="val-stat blank">
        <div class="val-stat-num">${report.blankPages}</div>
        <div class="val-stat-label">Blank</div>
      </div>
      <div class="val-stat scanned">
        <div class="val-stat-num">${report.scannedPages}</div>
        <div class="val-stat-label">Scanned (OCR)</div>
      </div>
      <div class="val-stat failed">
        <div class="val-stat-num">${report.failedPages}</div>
        <div class="val-stat-label">Failed</div>
      </div>
    </div>

    ${pages && pages.length > 0 ? `
    <div class="meta-section-title">Page-level results</div>
    <div class="val-table-wrap">
      <table class="val-table">
        <thead><tr><th>Page</th><th>Status</th><th>Words</th><th>Chars</th><th>OCR?</th></tr></thead>
        <tbody>
          ${pages.map(p => `
            <tr>
              <td>${p.page_number}</td>
              <td><span class="page-status-badge ${p.status}">${p.status}</span></td>
              <td>${p.word_count}</td>
              <td>${p.char_count}</td>
              <td>${p.ocr_required ? '⚠️ Yes' : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    ` : ''}
  `;
}

// ── Tab switching (called from HTML onclick) ──────────────────────────────────
async function switchTab(name) {
  showTab(name);
  if (!activeDocId && name !== 'upload') {
    showToast('info', 'Select a document first.');
    showTab('upload');
    return;
  }
  if (name === 'metadata')   await loadMetadata(activeDocId);
  if (name === 'text')       await loadTextTab(activeDocId);
  if (name === 'validation') await loadValidationTab(activeDocId);
}

// ── Upload ────────────────────────────────────────────────────────────────────
function setupUploadZone() {
  const zone  = $('uploadZone');
  const input = $('fileInput');
  if (!zone || !input) return;

  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) uploadFile(file);
  });

  input.addEventListener('change', e => {
    const file = e.target?.files?.[0];
    if (file) uploadFile(file);
    e.target.value = '';
  });
}

async function uploadFile(file) {
  const ALLOWED = ['.pdf', '.docx', '.txt'];
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  if (!ALLOWED.includes(ext)) {
    showToast('error', `❌ Unsupported format. Use PDF, DOCX, or TXT.`);
    return;
  }

  const MAX_MB = 25;
  if (file.size > MAX_MB * 1024 * 1024) {
    showToast('error', `❌ File too large (max ${MAX_MB} MB).`);
    return;
  }

  const progress = $('uploadProgress');
  const pBar     = $('progressBar');
  const pStatus  = $('progressStatus');
  const pName    = $('progressName');

  if (pName)   pName.textContent   = file.name;
  if (pStatus) pStatus.textContent = 'Uploading…';
  if (pBar)    pBar.style.width    = '20%';
  if (progress) progress.classList.add('show');

  const fd = new FormData();
  fd.append('file', file);

  try {
    const res = await fetch(`${API}/upload`, {
      method:  'POST',
      headers: { 'x-user-id': userId, 'x-user-name': userName },
      body:    fd,
    });

    const data = await res.json();

    if (res.status === 409) {
      if (pStatus) pStatus.textContent = '⚠️ Duplicate';
      if (pBar)    pBar.style.width    = '100%';
      showToast('error', data.error || 'Duplicate file.');
      setTimeout(() => progress && progress.classList.remove('show'), 2500);
      return;
    }

    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Upload failed');
    }

    if (pBar)    pBar.style.width    = '60%';
    if (pStatus) pStatus.textContent = '⏳ Processing…';

    showToast('success', `✅ "${file.name}" uploaded! Processing in background…`);
    await loadDocuments();

    // Poll until ready
    const newId = data.documentId || data.document?.id;
    if (newId) {
      if (pBar) pBar.style.width = '75%';
      startPolling([newId], () => {
        if (pBar)    pBar.style.width    = '100%';
        if (pStatus) pStatus.textContent = '✅ Ready!';
        setTimeout(() => progress && progress.classList.remove('show'), 1800);
        showToast('success', `✅ "${file.name}" is ready!`);
      });
    }

  } catch (err) {
    if (pStatus) pStatus.textContent = '❌ Failed';
    showToast('error', `❌ ${err.message}`);
    setTimeout(() => progress && progress.classList.remove('show'), 2500);
  }
}

// ── Polling ───────────────────────────────────────────────────────────────────
function startPolling(docIds, onAllDone) {
  if (pollTimer) clearInterval(pollTimer);
  const pending = new Set(docIds);

  pollTimer = setInterval(async () => {
    for (const id of [...pending]) {
      try {
        const res  = await fetch(`${API}/${id}/status`, { headers: userHeaders() });
        const data = await res.json();
        if (data.status === 'ready' || data.status === 'error') {
          pending.delete(id);
          // Update local state
          const doc = allDocs.find(d => d.id === id);
          if (doc) { doc.status = data.status; doc.pages = data.pages; doc.chunkCount = data.chunkCount; }
          renderDocList(allDocs);
        }
      } catch (_) {}
    }
    if (pending.size === 0) {
      clearInterval(pollTimer);
      if (onAllDone) onAllDone();
    }
  }, 4000);
}

// ── Delete ────────────────────────────────────────────────────────────────────
async function deleteDoc(e, docId) {
  e.stopPropagation();
  const doc = allDocs.find(d => d.id === docId);
  if (!doc) return;
  if (!confirm(`Delete "${doc.originalName}"? This cannot be undone.`)) return;

  try {
    const res = await fetch(`${API}/${docId}`, {
      method:  'DELETE',
      headers: userHeaders(),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    showToast('success', `🗑️ "${doc.originalName}" deleted.`);
    allDocs = allDocs.filter(d => d.id !== docId);
    if (activeDocId === docId) { activeDocId = null; showTab('upload'); }
    renderDocList(allDocs);
    $('sidebarCount').textContent = allDocs.length;
  } catch (err) {
    showToast('error', `❌ Delete failed: ${err.message}`);
  }
}

// ── Search ────────────────────────────────────────────────────────────────────
let searchTimer;
function onSearch(val) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadDocuments(val), 320);
}

// ── Formatting helpers ────────────────────────────────────────────────────────
function fmtSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function escHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(type, msg) {
  const t = $('toast');
  const m = $('toastMsg');
  if (!t || !m) return;
  t.className = `toast ${type} show`;
  m.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
