// services/textcleaner.js - Text Cleaning Module for RAG Pipeline
// Pipeline: Text Extraction -> [THIS MODULE] -> Chunking -> Embedding
'use strict';

// -- Patterns ------------------------------------------------------------------

// Task 3: page number lines (e.g. "Page 1", "- 3 -", "1 of 20")
const RE_PAGE_NUM = /^(?:(?:[-\u2013]\s*)?\bpage\b\s*\d+\s*(?:[-\u2013]\s*)?|\d+\s*of\s*\d+|\d+\s*)\s*$/gim;

// Task 8: URLs
const RE_URL = /https?:\/\/[^\s)>\]"']+/g;

// Task 9: emails
const RE_EMAIL = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// Task 11: boilerplate phrases
const RE_BOILERPLATE = /\b(?:all rights reserved|copyright(?:\s+\(c\))?|terms of (?:use|service)|privacy policy|cookie policy|disclaimer|confidential(?:ity)?)\b/gi;

// -- Task 4: Header / Footer detection ----------------------------------------
// Lines that appear in >=30% of pages are likely headers/footers.

function detectRepeatedLines(pages) {
  const freq = new Map();
  for (const page of pages) {
    const lines = page.split('\n');
    const seen = new Set();
    for (const raw of lines) {
      const line = raw.trim();
      if (line.length < 3 || line.length > 120) continue;
      if (!seen.has(line)) {
        seen.add(line);
        freq.set(line, (freq.get(line) || 0) + 1);
      }
    }
  }
  const threshold = Math.max(2, Math.ceil(pages.length * 0.3));
  const repeated = new Set();
  for (const [line, count] of freq) {
    if (count >= threshold) repeated.add(line);
  }
  return repeated;
}

function removeRepeatedLines(text, repeated) {
  if (!repeated.size) return text;
  return text
    .split('\n')
    .filter(line => !repeated.has(line.trim()))
    .join('\n');
}

// -- Task 6: Fix broken sentences ---------------------------------------------
// Lowercase -> lowercase across newline: join with space
const RE_BROKEN_SENTENCE = /([a-z,;])\n([a-z])/g;

// -- Core single-page cleaner -------------------------------------------------

function cleanPage(text, repeatedLines) {
  let t = text;

  // Task 7: Unicode normalization (NFKC)
  // Converts ligatures, full-width chars, fancy quotes, etc.
  t = t.normalize('NFKC');

  // Remove null bytes and non-printable control characters (but keep \n \t)
  t = t.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ');

  // Replace non-breaking spaces and other whitespace variants with regular space
  t = t.replace(/[\xa0\u2000-\u200b\u2028\u2029\u3000]/g, ' ');

  // Task 3: page numbers (match whole lines)
  const pageMatches = t.match(RE_PAGE_NUM) || [];
  if (pageMatches.length) {
    t = t.replace(RE_PAGE_NUM, '');
    // stats.removedPageNumbers = pageMatches.length;
  }

  // Task 4: repeated headers/footers
  if (repeatedLines && repeatedLines.size) {
    t = removeRepeatedLines(t, repeatedLines);
  }

  // Task 8: URLs
  t = t.replace(RE_URL, ' ');

  // Task 9: emails
  t = t.replace(RE_EMAIL, ' ');

  // Task 11: boilerplate
  t = t.replace(RE_BOILERPLATE, ' ');

  // Task 6: fix broken sentences (before collapsing spaces)
  t = t.replace(RE_BROKEN_SENTENCE, '$1 $2');

  // Task 5: special characters - keep alphanumeric, punctuation, whitespace
  t = t.replace(/[^\w\s.,!?;:()\[\]{}"'\-\u2013\u2014\/\\@#$%&*+=<>~`|^]/g, ' ');

  // Task 1: normalize horizontal whitespace (multiple spaces -> single)
  t = t.replace(/[^\S\n]+/g, ' ');

  // Task 2: normalize multiple blank lines (3+ -> 2)
  t = t.replace(/\n{3,}/g, '\n\n');

  // Trim leading/trailing whitespace per line
  t = t.split('\n').map(line => line.trim()).join('\n');

  // Final trim
  t = t.trim();

  return t;
}

// -- Document-level cleaner (all pages at once) -------------------------------

/**
 * Clean an array of page strings.
 * @param {string[]} pages
 * @returns {{ pages: string[], stats: object }}
 */
function cleanDocument(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    return { pages: [], stats: {} };
  }

  // Detect repeated lines across pages for header/footer removal
  const repeatedLines = detectRepeatedLines(pages);

  const cleaned = pages.map(page => cleanPage(page || '', repeatedLines));

  const stats = {
    totalPages: pages.length,
    repeatedLinesRemoved: repeatedLines.size,
    avgLengthBefore: Math.round(pages.reduce((s, p) => s + p.length, 0) / pages.length),
    avgLengthAfter: Math.round(cleaned.reduce((s, p) => s + p.length, 0) / cleaned.length),
  };

  return { pages: cleaned, stats };
}

/**
 * Clean a single string (convenience wrapper).
 * @param {string} text
 * @returns {string}
 */
function cleanText(text) {
  if (typeof text !== 'string') return '';
  return cleanPage(text, new Set());
}

module.exports = { cleanDocument, cleanText, cleanPage, detectRepeatedLines };
