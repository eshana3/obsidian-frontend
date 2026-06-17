// services/docx.js — DOCX text extraction using mammoth
'use strict';

const mammoth = require('mammoth');
const fs       = require('fs');
const path     = require('path');
const logger   = require('../utils/logger');

const WORDS_PER_LOGICAL_PAGE = parseInt(process.env.DOCX_WORDS_PER_PAGE, 10) || 500;

/**
 * Extract text and derive logical pages from a DOCX file.
 * DOCX has no native page concept, so we group paragraphs into logical pages.
 */
async function extractDocxAll(filePath, originalName) {
  let result;
  try {
    result = await mammoth.extractRawText({ path: filePath });
  } catch (err) {
    logger.error('DOCX extraction error', { filePath, error: err.message });
    throw new Error(`DOCX extraction failed: ${err.message}`);
  }

  if (result.messages && result.messages.length > 0) {
    result.messages.forEach(m => logger.warn('mammoth warning', { msg: m.message }));
  }

  const fullText = (result.value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Split into paragraphs, filter blanks
  const paragraphs = fullText.split('\n').map(p => p.trim());
  const nonEmpty   = paragraphs.filter(p => p.length > 0);

  // Group paragraphs into logical pages by word count
  const pages   = [];
  let current   = [];
  let wordCount = 0;
  let pageNum   = 1;

  for (const para of paragraphs) {
    const words = para ? para.split(/\s+/).filter(Boolean).length : 0;

    if (wordCount + words > WORDS_PER_LOGICAL_PAGE && current.length > 0) {
      const pageText = current.join('\n').trim();
      pages.push(buildPage(pageNum++, pageText, false, false, false));
      current   = [para];
      wordCount = words;
    } else {
      current.push(para);
      wordCount += words;
    }
  }

  if (current.length > 0) {
    const pageText = current.join('\n').trim();
    pages.push(buildPage(pageNum, pageText, pageText.length < 20, false, false));
  }

  if (pages.length === 0) {
    pages.push(buildPage(1, '', true, false, false));
  }

  const metadata = inferDocxMetadata(nonEmpty, originalName);
  logger.info('DOCX extracted', { filePath, pages: pages.length });

  return { pages, fullText, numPages: pages.length, metadata };
}

function buildPage(pageNumber, text, isBlank, isScanned, hasError) {
  return {
    pageNumber,
    text,
    wordCount: text ? text.split(/\s+/).filter(Boolean).length : 0,
    charCount: text ? text.length : 0,
    isBlank: isBlank || text.length < 20,
    isScanned,
    hasError,
  };
}

function inferDocxMetadata(paragraphs, originalName) {
  const baseName = path.basename(originalName, path.extname(originalName));

  // Heuristic: first paragraph that looks like a title (short, sentence-case)
  const titleLine = paragraphs.find(p => p.length > 5 && p.length < 300 && p.trim());

  // Heuristic: look for a year pattern
  let year = null;
  for (const p of paragraphs.slice(0, 20)) {
    const m = p.match(/\b(19|20)\d{2}\b/);
    if (m) { year = parseInt(m[0]); break; }
  }

  // Look for DOI
  let doi = null;
  for (const p of paragraphs.slice(0, 50)) {
    const m = p.match(/10\.\d{4,}\/[^\s,;)\]]+/);
    if (m) { doi = m[0]; break; }
  }

  return {
    title:    titleLine || baseName,
    authors:  null,
    year:     year || null,
    keywords: null,
    doi:      doi || null,
  };
}

/**
 * Split a plain-text file into logical pages by word count.
 */
function extractTxtAll(filePath, originalName) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`TXT read failed: ${err.message}`);
  }

  const fullText = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const words    = fullText.split(/\s+/).filter(Boolean);
  const pages    = [];
  let   pageNum  = 1;

  for (let i = 0; i < words.length; i += WORDS_PER_LOGICAL_PAGE) {
    const slice    = words.slice(i, i + WORDS_PER_LOGICAL_PAGE);
    const pageText = slice.join(' ');
    pages.push(buildPage(pageNum++, pageText, false, false, false));
  }

  if (pages.length === 0) {
    pages.push(buildPage(1, '', true, false, false));
  }

  const baseName = path.basename(originalName, path.extname(originalName));
  const metadata = { title: baseName, authors: null, year: null, keywords: null, doi: null };

  return { pages, fullText, numPages: pages.length, metadata };
}

module.exports = { extractDocxAll, extractTxtAll };
