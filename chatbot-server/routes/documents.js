// routes/documents.js — Document upload, processing, and management (PDF + DOCX + TXT)
'use strict';

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db, ensureUser }              = require('../database/db');
const { extractPdfAll, extractPdfMetadata, chunkText } = require('../services/pdf');
const { extractDocxAll, extractTxtAll }                = require('../services/docx');
const { validateDocument }            = require('../services/quality');
const { cleanDocumentPages }          = require('../services/textcleaner');
const { generateEmbeddings }          = require('../services/embeddings');
const logger   = require('../utils/logger');

const router = express.Router();

const UPLOAD_DIR  = path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads');
const MAX_FILE_MB = parseInt(process.env.MAX_PDF_SIZE_MB, 10) || 25;

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Allowed file types ────────────────────────────────────────────────────────

const ALLOWED_EXTS     = new Set(['.pdf', '.docx', '.txt']);
const ALLOWED_MIMETYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain',
]);

function detectFileType(filename, mimetype) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf' || mimetype === 'application/pdf') return 'pdf';
  if (ext === '.docx' || mimetype.includes('wordprocessingml')) return 'docx';
  if (ext === '.txt'  || mimetype === 'text/plain') return 'txt';
  return null;
}

// ── Multer ────────────────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file, cb) => {
    const ext     = path.extname(file.originalname).toLowerCase();
    const safeExt = ALLOWED_EXTS.has(ext) ? ext : '.pdf';
    cb(null, `${uuidv4()}${safeExt}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext    = path.extname(file.originalname).toLowerCase();
    const extOk  = ALLOWED_EXTS.has(ext);
    const mimeOk = ALLOWED_MIMETYPES.has(file.mimetype);
    if (extOk || mimeOk) return cb(null, true);
    const err  = new Error('Only PDF, DOCX, and TXT files are supported.');
    err.code   = 'WRONG_FILE_TYPE';
    cb(err);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function getUserId(req) {
  return req.headers['x-user-id'] || req.body?.userId || req.query?.userId || 'anonymous';
}

/** Detect duplicate by original filename + user */
function isDuplicate(userId, originalName) {
  const row = db.prepare(`
    SELECT id FROM documents
    WHERE user_id = ? AND original_name = ? AND status != 'error'
    LIMIT 1
  `).get(userId, originalName);
  return !!row;
}

// ── Document processing pipeline ──────────────────────────────────────────────

async function processDocument(docId, filePath, fileType, userId, originalName) {
  logger.info('Processing document', { docId, fileType });

  try {
    // ── 1. Extract text & pages ─────────────────────────────────────────────
    let pages, fullText, numPages, metadata;

    if (fileType === 'pdf') {
      const result = await extractPdfAll(filePath);
      pages    = result.pages;
      fullText = result.fullText;
      numPages = result.numPages;
      metadata = extractPdfMetadata(result.fullText, result.info, result.numPages, originalName);
    } else if (fileType === 'docx') {
      const result = await extractDocxAll(filePath, originalName);
      pages    = result.pages;
      fullText = result.fullText;
      numPages = result.numPages;
      metadata = result.metadata;
    } else {
      const result = extractTxtAll(filePath, originalName);
      pages    = result.pages;
      fullText = result.fullText;
      numPages = result.numPages;
      metadata = result.metadata;
    }

    // ── 2. Quality validation ───────────────────────────────────────────────
    const report = validateDocument(pages, fileType);

    // ── 3. Text cleaning (Track 2.3) ────────────────────────────────────────
    // Runs AFTER quality validation so blank/scanned pages are already flagged.
    // Only clean pages that have extractable text (OK status).
    const { cleanedPages, report: cleaningReport } = cleanDocumentPages(report.pages, fileType);
    logger.info('Text cleaned', { docId, charsBefore: cleaningReport.charsBefore, charsAfter: cleaningReport.charsAfter, reduction: cleaningReport.reductionPercent + '%' });

    // ── 4. Persist pages (raw + cleaned text) ───────────────────────────────
    const insertPage = db.prepare(`
      INSERT INTO document_pages
        (id, document_id, page_number, text, word_count, char_count, status, ocr_required,
         cleaned_text, cleaned_word_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
      for (const p of cleanedPages) {
        insertPage.run(
          uuidv4(), docId, p.pageNumber,
          p.text, p.wordCount, p.charCount, p.status, p.ocrRequired ? 1 : 0,
          p.cleanedText ?? null, p.cleanedWordCount ?? 0
        );
      }
    })();

    // ── 5. Persist validation report ────────────────────────────────────────
    db.prepare(`
      INSERT OR REPLACE INTO validation_reports
        (id, document_id, total_pages, processed_pages, blank_pages, scanned_pages, failed_pages, overall_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), docId, report.totalPages, report.processedPages, report.blankPages, report.scannedPages, report.failedPages, report.overallStatus);

    // ── 6. Persist cleaning report ───────────────────────────────────────────
    db.prepare(`
      INSERT OR REPLACE INTO text_cleaning_reports
        (id, document_id, chars_before, chars_after, reduction_percent,
         removed_page_numbers, removed_headers, detected_header_lines,
         removed_urls, removed_emails, removed_boilerplate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(), docId,
      cleaningReport.charsBefore, cleaningReport.charsAfter, cleaningReport.reductionPercent,
      cleaningReport.removedPageNumbers, cleaningReport.removedHeaders, cleaningReport.detectedHeaderLines,
      cleaningReport.removedUrls, cleaningReport.removedEmails, cleaningReport.removedBoilerplate
    );

    // ── 7. RAG chunking + embeddings (uses CLEANED text for better retrieval) ─
    // Join cleaned text from all non-blank pages as the corpus for chunking.
    const cleanedFullText = cleanedPages
      .filter(p => p.status === 'OK' && p.cleanedText)
      .map(p => p.cleanedText)
      .join('\n\n');

    let chunkCount = 0;
    if (cleanedFullText.trim().length > 60) {
      const chunks     = chunkText(cleanedFullText);
      const embeddings = await generateEmbeddings(chunks.map(c => c.text));

      const insertChunk = db.prepare(`
        INSERT INTO chunks (id, document_id, chunk_text, chunk_index, page_number, embedding)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      db.transaction(() => {
        for (let i = 0; i < chunks.length; i++) {
          insertChunk.run(uuidv4(), docId, chunks[i].text, chunks[i].chunkIndex, chunks[i].pageNumber, embeddings[i] ? JSON.stringify(embeddings[i]) : null);
        }
      })();

      chunkCount = chunks.length;
      logger.info('Chunks embedded', { docId, count: chunkCount });
    }

    // ── 6. Update document record ────────────────────────────────────────────
    db.prepare(`
      UPDATE documents
      SET status = 'ready', pages = ?, chunk_count = ?, file_type = ?,
          title = ?, authors = ?, year = ?, keywords = ?, doi = ?
      WHERE id = ?
    `).run(numPages, chunkCount, fileType, metadata.title, metadata.authors, metadata.year, metadata.keywords, metadata.doi, docId);

    logger.info('Document ready', { docId, fileType, pages: numPages, chunks: chunkCount, status: report.overallStatus });

  } catch (err) {
    logger.error('Document processing failed', { docId, error: err.message });
    db.prepare(`UPDATE documents SET status = 'error' WHERE id = ?`).run(docId);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/documents/upload
 * Accepts: multipart/form-data, field name "file" (also accepts "pdf" for backward compat)
 * Headers: x-user-id, x-user-name
 */
router.post('/upload', (req, res, next) => {
  upload.single('file')(req, res, (multerErr) => {
    if (multerErr) return next(multerErr);

    // Fallback: try field name "pdf" for backward compat
    if (!req.file) {
      return upload.single('pdf')(req, res, (err2) => {
        if (err2) return next(err2);
        handleUpload(req, res);
      });
    }
    handleUpload(req, res);
  });
});

function handleUpload(req, res) {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file received. Send field name "file".' });
  }

  const userId   = getUserId(req);
  const userName = req.headers['x-user-name'] || 'User';
  const origName = req.file.originalname;

  // Duplicate check
  if (isDuplicate(userId, origName)) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(409).json({ success: false, error: `"${origName}" is already uploaded. Delete it first to re-upload.` });
  }

  // Detect file type
  const fileType = detectFileType(req.file.filename, req.file.mimetype);
  if (!fileType) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(415).json({ success: false, error: 'Unsupported file type.' });
  }

  const ext   = path.extname(req.file.filename);
  const docId = path.basename(req.file.filename, ext);

  try {
    ensureUser(userId, userName, '');

    db.prepare(`
      INSERT INTO documents (id, user_id, filename, original_name, size, file_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(docId, userId, req.file.filename, origName, req.file.size, fileType);

    logger.info('Document uploaded', { docId, name: origName, fileType, size: req.file.size, userId });

    // Process asynchronously — respond 201 immediately
    processDocument(docId, req.file.path, fileType, userId, origName).catch(err =>
      logger.error('Background processing error', { docId, error: err.message })
    );

    return res.status(201).json({
      success:    true,
      documentId: docId,
      fileName:   origName,
      fileType,
      status:     'uploaded',
      uploadedAt: new Date().toISOString(),
      // backward-compat shape
      document: { id: docId, originalName: origName, size: req.file.size, fileType, status: 'processing' }
    });
  } catch (dbErr) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    logger.error('Upload DB error', { error: dbErr.message });
    return res.status(500).json({ success: false, error: 'Failed to record upload.' });
  }
}

/**
 * GET /api/documents
 * Returns all documents for the user.
 */
router.get('/', (req, res) => {
  const userId = getUserId(req);
  const search = (req.query.q || '').trim();
  const page   = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit  = Math.min(100, parseInt(req.query.limit, 10) || 50);
  const offset = (page - 1) * limit;

  try {
    let sql = `
      SELECT d.id, d.original_name AS originalName, d.size, d.pages, d.chunk_count AS chunkCount,
             d.status, d.file_type AS fileType, d.title, d.authors, d.year, d.upload_date AS uploadDate
      FROM documents d
      WHERE d.user_id = ?
    `;
    const params = [userId];

    if (search) {
      sql += ` AND (d.original_name LIKE ? OR d.title LIKE ? OR d.authors LIKE ?)`;
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    const total = db.prepare(sql.replace('SELECT d.id,', 'SELECT COUNT(*) AS cnt,').replace('ORDER BY d.upload_date DESC', '')).get(...params)?.cnt || 0;

    sql += ` ORDER BY d.upload_date DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const docs = db.prepare(sql).all(...params);
    res.json({ success: true, documents: docs, total, page, limit });
  } catch (err) {
    logger.error('List documents error', { error: err.message });
    res.status(500).json({ success: false, error: 'Could not load documents.' });
  }
});

/**
 * GET /api/documents/:id
 * Returns full document details including metadata.
 */
router.get('/:id', (req, res) => {
  try {
    const doc = db.prepare(`
      SELECT d.id, d.original_name AS originalName, d.size, d.pages, d.chunk_count AS chunkCount,
             d.status, d.file_type AS fileType, d.title, d.authors, d.year, d.keywords, d.doi,
             d.upload_date AS uploadDate
      FROM documents d WHERE d.id = ?
    `).get(req.params.id);

    if (!doc) return res.status(404).json({ success: false, error: 'Document not found.' });
    res.json({ success: true, document: doc });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Could not fetch document.' });
  }
});

/**
 * GET /api/documents/:id/status
 * Poll processing status (backward compatible).
 */
router.get('/:id/status', (req, res) => {
  try {
    const doc = db.prepare(`
      SELECT id, original_name AS originalName, status, pages, chunk_count AS chunkCount, file_type AS fileType
      FROM documents WHERE id = ?
    `).get(req.params.id);

    if (!doc) return res.status(404).json({ success: false, error: 'Document not found.' });
    res.json({ success: true, document: doc, id: doc.id, status: doc.status, pages: doc.pages, chunkCount: doc.chunkCount });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Status check failed.' });
  }
});

/**
 * GET /api/documents/:id/pages
 * Returns extracted text pages for a document.
 */
router.get('/:id/pages', (req, res) => {
  const pageNum = parseInt(req.query.page, 10) || null;

  try {
    const doc = db.prepare('SELECT id, status FROM documents WHERE id = ?').get(req.params.id);
    if (!doc) return res.status(404).json({ success: false, error: 'Document not found.' });
    if (doc.status === 'processing') return res.status(202).json({ success: false, error: 'Still processing.' });

    let pages;
    if (pageNum) {
      pages = db.prepare('SELECT * FROM document_pages WHERE document_id = ? AND page_number = ?').all(req.params.id, pageNum);
    } else {
      pages = db.prepare('SELECT * FROM document_pages WHERE document_id = ? ORDER BY page_number ASC').all(req.params.id);
    }

    res.json({ success: true, documentId: req.params.id, pages, total: pages.length });
  } catch (err) {
    logger.error('Pages fetch error', { error: err.message });
    res.status(500).json({ success: false, error: 'Could not fetch pages.' });
  }
});

/**
 * GET /api/documents/:id/validation
 * Returns the quality validation report for a document.
 */
router.get('/:id/validation', (req, res) => {
  try {
    const report = db.prepare('SELECT * FROM validation_reports WHERE document_id = ?').get(req.params.id);
    if (!report) return res.status(404).json({ success: false, error: 'No validation report found.' });

    const pageStatuses = db.prepare(`
      SELECT page_number, status, ocr_required, word_count, char_count
      FROM document_pages WHERE document_id = ? ORDER BY page_number ASC
    `).all(req.params.id);

    res.json({
      success:  true,
      report: {
        documentId:     report.document_id,
        totalPages:     report.total_pages,
        processedPages: report.processed_pages,
        blankPages:     report.blank_pages,
        scannedPages:   report.scanned_pages,
        failedPages:    report.failed_pages,
        status:         report.overall_status,
        createdAt:      report.created_at,
      },
      pages: pageStatuses,
    });
  } catch (err) {
    logger.error('Validation report error', { error: err.message });
    res.status(500).json({ success: false, error: 'Could not fetch validation report.' });
  }
});

/**
 * GET /api/documents/:id/cleaned-text
 * Returns the cleaned version of extracted pages.
 * Query: ?page=N to get a single page, otherwise all pages.
 */
router.get('/:id/cleaned-text', (req, res) => {
  const pageNum = parseInt(req.query.page, 10) || null;
  try {
    const doc = db.prepare('SELECT id, status FROM documents WHERE id = ?').get(req.params.id);
    if (!doc)                       return res.status(404).json({ success: false, error: 'Document not found.' });
    if (doc.status === 'processing') return res.status(202).json({ success: false, error: 'Still processing.' });

    let pages;
    if (pageNum) {
      pages = db.prepare(`
        SELECT page_number, cleaned_text AS text, cleaned_word_count AS wordCount,
               char_count, status, ocr_required
        FROM document_pages WHERE document_id = ? AND page_number = ?
      `).all(req.params.id, pageNum);
    } else {
      pages = db.prepare(`
        SELECT page_number, cleaned_text AS text, cleaned_word_count AS wordCount,
               char_count, status, ocr_required
        FROM document_pages WHERE document_id = ? ORDER BY page_number ASC
      `).all(req.params.id);
    }

    res.json({ success: true, documentId: req.params.id, pages, total: pages.length });
  } catch (err) {
    logger.error('Cleaned-text fetch error', { error: err.message });
    res.status(500).json({ success: false, error: 'Could not fetch cleaned text.' });
  }
});

/**
 * GET /api/documents/:id/cleaning-report
 * Returns the text-cleaning statistics for a document.
 */
router.get('/:id/cleaning-report', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM text_cleaning_reports WHERE document_id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: 'No cleaning report found.' });

    res.json({
      success: true,
      report: {
        documentId:          row.document_id,
        charsBefore:         row.chars_before,
        charsAfter:          row.chars_after,
        reductionPercent:    row.reduction_percent,
        removedPageNumbers:  row.removed_page_numbers,
        removedHeaders:      row.removed_headers,
        detectedHeaderLines: row.detected_header_lines,
        removedUrls:         row.removed_urls,
        removedEmails:       row.removed_emails,
        removedBoilerplate:  row.removed_boilerplate,
        createdAt:           row.created_at,
      }
    });
  } catch (err) {
    logger.error('Cleaning report fetch error', { error: err.message });
    res.status(500).json({ success: false, error: 'Could not fetch cleaning report.' });
  }
});

/**
 * DELETE /api/documents/:id
 */
router.delete('/:id', (req, res) => {
  const userId = getUserId(req);
  try {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?').get(req.params.id, userId);
    if (!doc) return res.status(404).json({ success: false, error: 'Document not found.' });

    const filePath = path.join(UPLOAD_DIR, doc.filename);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }

    db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    logger.info('Document deleted', { docId: doc.id, userId });
    res.json({ success: true });
  } catch (err) {
    logger.error('Delete document error', { error: err.message });
    res.status(500).json({ success: false, error: 'Delete failed.' });
  }
});

// ── Multer error handler ──────────────────────────────────────────────────────
router.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE')   return res.status(413).json({ success: false, error: `File too large. Max ${MAX_FILE_MB} MB.` });
  if (err.code === 'WRONG_FILE_TYPE')   return res.status(415).json({ success: false, error: err.message });
  logger.error('Documents route error', { error: err.message });
  res.status(500).json({ success: false, error: err.message || 'Upload failed.' });
});

module.exports = router;
