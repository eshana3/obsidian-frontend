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

module.exports = { extractTextFromPdf, chunkText };
