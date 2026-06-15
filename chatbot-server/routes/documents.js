// routes/documents.js — PDF upload, processing, and management
'use strict';

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db, ensureUser }      = require('../database/db');
const { extractTextFromPdf, chunkText } = require('../services/pdf');
const { generateEmbeddings }  = require('../services/embeddings');
const logger   = require('../utils/logger');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads');
const MAX_PDF_MB = parseInt(process.env.MAX_PDF_SIZE_MB, 10) || 25;

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Multer ────────────────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, _file, cb) => cb(null, `${uuidv4()}.pdf`)
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_PDF_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' ||
               file.originalname.toLowerCase().endsWith('.pdf');
    if (ok) return cb(null, true);
    const err = new Error('Only PDF files are allowed.');
    err.code  = 'WRONG_FILE_TYPE';
    cb(err);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function getUserId(req) {
  return req.headers['x-user-id'] || req.body?.userId || req.query?.userId || 'anonymous';
}

async function processPdf(docId, filePath, userId) {
  try {
    logger.info('Processing PDF', { docId });
    const { text, numPages } = await extractTextFromPdf(filePath);

    db.prepare('UPDATE documents SET pages = ? WHERE id = ?').run(numPages, docId);

    const chunks = chunkText(text);
    logger.info('Chunks created', { docId, count: chunks.length });

    const embeddings = await generateEmbeddings(chunks.map(c => c.text));

    const insertChunk = db.prepare(`
      INSERT INTO chunks (id, document_id, chunk_text, chunk_index, page_number, embedding)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertAll = db.transaction(() => {
      for (let i = 0; i < chunks.length; i++) {
        insertChunk.run(
          uuidv4(),
          docId,
          chunks[i].text,
          chunks[i].chunkIndex,
          chunks[i].pageNumber,
          embeddings[i] ? JSON.stringify(embeddings[i]) : null
        );
      }
    });
    insertAll();

    db.prepare(`UPDATE documents SET status = 'ready', pages = ?, chunk_count = ? WHERE id = ?`)
      .run(numPages, chunks.length, docId);

    logger.info('PDF ready', { docId, chunks: chunks.length, pages: numPages });
  } catch (err) {
    logger.error('PDF processing failed', { docId, error: err.message });
    db.prepare(`UPDATE documents SET status = 'error' WHERE id = ?`).run(docId);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/documents/upload
 * Accepts: multipart/form-data, field "pdf"
 * Headers: x-user-id, x-user-name
 */
router.post('/upload', (req, res, next) => {
  // Run multer and catch its errors explicitly so we can return JSON
  upload.single('pdf')(req, res, (err) => {
    if (err) return next(err);

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No PDF file received. Make sure the field name is "pdf".'
      });
    }

    const userId = getUserId(req);
    const name   = req.headers['x-user-name'] || 'User';

    try {
      ensureUser(userId, name, '');

      const docId = req.file.filename.replace('.pdf', '');

      db.prepare(`
        INSERT INTO documents (id, user_id, filename, original_name, size)
        VALUES (?, ?, ?, ?, ?)
      `).run(docId, userId, req.file.filename, req.file.originalname, req.file.size);

      logger.info('PDF uploaded', { docId, name: req.file.originalname, size: req.file.size, userId });

      // Process asynchronously — respond immediately with 201
      processPdf(docId, req.file.path, userId).catch(err =>
        logger.error('Background PDF processing error', { docId, error: err.message })
      );

      return res.status(201).json({
        success: true,
        document: {
          id:           docId,
          originalName: req.file.originalname,
          size:         req.file.size,
          status:       'processing'
        }
      });
    } catch (dbErr) {
      // Clean up the file if we couldn't record it in the DB
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      logger.error('Upload DB error', { error: dbErr.message });
      return res.status(500).json({ success: false, error: 'Failed to record upload. Please try again.' });
    }
  });
});

/**
 * GET /api/documents
 * Returns all documents for the user with chunk counts.
 */
router.get('/', (req, res) => {
  const userId = getUserId(req);
  try {
    const docs = db.prepare(`
      SELECT
        d.id,
        d.original_name  AS originalName,
        d.size,
        d.pages,
        d.chunk_count    AS chunkCount,
        d.status,
        d.upload_date    AS uploadDate
      FROM documents d
      WHERE d.user_id = ?
      ORDER BY d.upload_date DESC
    `).all(userId);

    res.json({ success: true, documents: docs });
  } catch (err) {
    logger.error('List documents error', { error: err.message });
    res.status(500).json({ success: false, error: 'Could not load documents.' });
  }
});

/**
 * GET /api/documents/:id/status
 * Poll processing status of a single document.
 */
router.get('/:id/status', (req, res) => {
  try {
    const doc = db.prepare(`
      SELECT id, original_name AS originalName, status, pages, chunk_count AS chunkCount
      FROM documents WHERE id = ?
    `).get(req.params.id);

    if (!doc) return res.status(404).json({ success: false, error: 'Document not found.' });

    res.json({
      success:  true,
      document: doc,
      // top-level fields for backward compat
      id:         doc.id,
      status:     doc.status,
      pages:      doc.pages,
      chunkCount: doc.chunkCount
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Status check failed.' });
  }
});

/**
 * DELETE /api/documents/:id
 */
router.delete('/:id', (req, res) => {
  const userId = getUserId(req);
  try {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?')
                 .get(req.params.id, userId);

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
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      error: `File too large. Maximum size is ${MAX_PDF_MB} MB.`
    });
  }
  if (err.code === 'WRONG_FILE_TYPE') {
    return res.status(415).json({ success: false, error: err.message });
  }
  logger.error('Documents route error', { error: err.message });
  res.status(500).json({ success: false, error: err.message || 'Upload failed.' });
});

module.exports = router;
