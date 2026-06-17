// services/pdf.js — PDF text extraction and chunking
'use strict';

const pdfParse = require('pdf-parse');
const fs       = require('fs');
const logger   = require('../utils/logger');

const CHUNK_SIZE    = parseInt(process.env.CHUNK_SIZE,    10) || 800;
const CHUNK_OVERLAP = parseInt(process.env.CHUNK_OVERLAP, 10) || 120;

/**
 * Extract full text and page count from a PDF file.
 * @param {string} filePath  Absolute path to the .pdf file on disk.
 * @returns {{ text: string, numPages: number }}
 */
async function extractTextFromPdf(filePath) {
  const buffer = fs.readFileSync(filePath);

  let data;
  try {
    data = await pdfParse(buffer);
  } catch (err) {
    logger.error('PDF parse error', { filePath, error: err.message });
    throw new Error(`Could not read PDF: ${err.message}`);
  }

  const text = (data.text || '').replace(/\x00/g, '').trim();
  if (!text) throw new Error('PDF appears to be empty or image-only (no extractable text).');

  return { text, numPages: data.numpages || 0 };
}

/**
 * Attempt to map a character offset back to a page number.
 * pdf-parse puts a form-feed (\f) character between pages.
 */
function estimatePage(text, charOffset) {
  const pageBreaks = [...text.slice(0, charOffset).matchAll(/\f/g)];
  return pageBreaks.length + 1;
}

/**
 * Split a long text into overlapping chunks suitable for embedding.
 * Tries to break on sentence boundaries where possible.
 *
 * @param {string} text
 * @returns {{ text: string, chunkIndex: number, pageNumber: number }[]}
 */
function chunkText(text) {
  const chunks = [];
  let start = 0;
  let index = 0;

  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length);

    // Snap end forward to the nearest sentence break (. ! ?) within 120 chars
    if (end < text.length) {
      const window = text.slice(end, Math.min(end + 120, text.length));
      const sentenceEnd = window.search(/[.!?]\s/);
      if (sentenceEnd !== -1) end += sentenceEnd + 1;
    }

    const chunk = text.slice(start, end).replace(/\s+/g, ' ').trim();

    if (chunk.length >= 60) {   // ignore micro-chunks
      chunks.push({
        text:        chunk,
        chunkIndex:  index++,
        pageNumber:  estimatePage(text, start)
      });
    }

    start = end - CHUNK_OVERLAP;
    if (start <= 0 || start >= text.length) break;
  }

  logger.info('Text chunked', { total: text.length, chunks: chunks.length });
  return chunks;
}

/**
 * Extract text page-by-page from a PDF.
 * Uses pdf-parse's pagerender callback — pdf-parse processes pages sequentially,
 * so push() into pageTexts maintains the correct order.
 *
 * Returns:
 *   { pages: [{ pageNumber, text, wordCount, charCount, isBlank, isScanned, hasError }],
 *     fullText: string, numPages: number }
 */
async function extractPdfAll(filePath) {
  const buffer    = fs.readFileSync(filePath);
  const pageTexts = [];   // populated in page order by the callback

  let data;
  try {
    data = await pdfParse(buffer, {
      pagerender: async (pageData) => {
        try {
          const tc = await pageData.getTextContent();
          let text = '';
          let lastY = null;
          for (const item of tc.items) {
            if (lastY !== null && Math.abs(lastY - item.transform[5]) > 5) {
              text += '\n';
            }
            text += item.str || '';
            lastY = item.transform[5];
          }
          const trimmed = text.replace(/\x00/g, '').trim();
          pageTexts.push({ text: trimmed, error: null });
          return trimmed;
        } catch (e) {
          pageTexts.push({ text: '', error: e.message });
          return '';
        }
      }
    });
  } catch (err) {
    logger.error('PDF page extraction error', { filePath, error: err.message });
    throw new Error(`PDF extraction failed: ${err.message}`);
  }

  const numPages  = data.numpages || pageTexts.length;
  const fullText  = (data.text || '').replace(/\x00/g, '');
  const info      = data.info || {};

  const pages = pageTexts.map((p, i) => {
    const text      = p?.text || '';
    const charCount = text.length;
    const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;
    const isBlank   = charCount < 20;
    const isScanned = isBlank && !p?.error;  // blank without error = likely image-only
    return {
      pageNumber: i + 1,
      text,
      wordCount,
      charCount,
      isBlank,
      isScanned,
      hasError: !!(p?.error),
    };
  });

  return { pages, fullText, numPages, info };
}

/**
 * Extract basic PDF metadata from the info dictionary and first-page text.
 * Pass the result of extractPdfAll to avoid re-parsing.
 */
function extractPdfMetadata(fullText, info, numPages, originalName) {
  const path = require('path');
  const baseName = path.basename(originalName, path.extname(originalName));

  // Title
  let title = (info.Title || '').trim() || null;
  if (!title) {
    const firstLine = fullText.split('\n').map(l => l.trim()).find(l => l.length > 5 && l.length < 300);
    title = firstLine || baseName;
  }

  // Authors
  const authors = (info.Author || '').trim() || null;

  // Year from creation date or text
  let year = null;
  if (info.CreationDate) {
    const m = info.CreationDate.match(/D:(\d{4})/);
    if (m) year = parseInt(m[1]);
  }
  if (!year) {
    const m = fullText.slice(0, 1000).match(/\b(19|20)\d{2}\b/);
    if (m) year = parseInt(m[0]);
  }

  // Keywords
  const keywords = (info.Keywords || '').trim() || null;

  // DOI
  const doiMatch = fullText.match(/10\.\d{4,}\/[^\s,;)\]]+/);
  const doi = doiMatch ? doiMatch[0] : null;

  return { title: title || baseName, authors, year, keywords, doi, pageCount: numPages };
}

module.exports = { extractTextFromPdf, chunkText, extractPdfAll, extractPdfMetadata };
