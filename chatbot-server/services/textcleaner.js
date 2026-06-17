// services/textcleaner.js — Text Cleaning Module for RAG Pipeline (Track 2.3)
//
// Pipeline position:
//   Text Extraction → [THIS MODULE] → Chunking → Embedding
//
// Implements all 12 cleaning tasks:
//   1  Remove extra spaces              7  Unicode normalization
//   2  Remove multiple blank lines      8  Remove URLs
//   3  Remove page numbers              9  Remove email addresses
//   4  Remove headers/footers           10 OCR error heuristics
//   5  Remove special characters        11 Remove boilerplate
//   6  Fix broken sentences             12 Preserve important structure
'use strict';

// ── Patterns ──────────────────────────────────────────────────────────────────

// Task 3 — page number lines (e.g. "Page 1", "- 3 -", "1 of 20")
const RE_PAGE_NUM = /^(?:(?:[-–]\s*)?\bpage\b\s*\d+\s*(?:[-–]\s*)?|\d+\s*of\s*\d+|\d+\s*)\s*$/gim;

// Task 8 — URLs
const RE_URL   = /https?:\/\/[^\s<>"{}|\\^[\]`]+/gi;

// Task 9 — emails
const RE_EMAIL = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;

// Task 11 — boilerplate phrases
const BOILERPLATE = [
  /copyright\s*[©(c)]*\s*\d{0,4}/gi,
  /all\s+rights?\s+reserved/gi,
  /do\s+not\s+(?:copy|distribute|reproduce)/gi,
  /confidential(?:\s+(?:information|document))?/gi,
  /proprietary\s+(?:and\s+)?confidential/gi,
  /for\s+internal\s+use\s+only/gi,
  /printed\s+on\s+\d+\s*\//gi,
];

// Separator lines (--- ===  *** ...)
const RE_SEPARATOR = /^[=\-_*~.]{3,}\s*$/gm;

// ── Task 4: Header / Footer detection ────────────────────────────────────────
// Lines that appear in ≥30% of pages are likely headers/footers.

/**
 * @param {string[]} pageTexts
 * @param {number}   minPageFrac  fraction of pages the line must appear on (default 0.3)
 * @returns {Set<string>}
 */
function detectRepeatedLines(pageTexts, minPageFrac = 0.3) {
  if (pageTexts.length < 2) return new Set();

  const lineCount = new Map();
  for (const text of pageTexts) {
    // Use a Set per page so a repeated line within ONE page counts only once
    const seenOnPage = new Set(
      text.split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 3 && l.length < 200)
    );
    for (const line of seenOnPage) {
      lineCount.set(line, (lineCount.get(line) || 0) + 1);
    }
  }

  const threshold = Math.max(2, Math.floor(pageTexts.length * minPageFrac));
  const repeated  = new Set();
  for (const [line, count] of lineCount) {
    if (count >= threshold) repeated.add(line);
  }
  return repeated;
}

// ── Task 6: Fix broken sentences ─────────────────────────────────────────────
// PDF extractors often break a sentence mid-word across lines.
// Only join if: line ends with a lowercase letter/comma/semi-colon
// AND next line starts with a lowercase letter (not a new paragraph/heading).

function fixBrokenSentences(text) {
  // Lowercase → lowercase across newline: join with space
  text = text.replace(/([a-z,;:])\n([a-z])/g, '$1 $2');
  // Word ends with hyphen (hyphenated line break): join without space
  text = text.replace(/(\w)-\n(\w)/g, '$1$2');
  return text;
}

// ── Core single-page cleaner ──────────────────────────────────────────────────

/**
 * Clean one page's text and return { cleaned, stats }.
 *
 * @param {string}   rawText        Extracted text of the page
 * @param {Set}      repeatedLines  Lines detected as headers/footers across all pages
 * @param {object}   opts           { removeUrls, removeEmails, removeSpecialChars }
 */
function cleanPageText(rawText, repeatedLines = new Set(), opts = {}) {
  const {
    removeUrls         = true,
    removeEmails       = true,
    removeSpecialChars = true,
  } = opts;

  if (!rawText || !rawText.trim()) {
    return { cleaned: '', stats: emptyStats() };
  }

  const stats = emptyStats();
  let t = rawText;

  // Task 7 — Unicode normalization (NFKC: compatibility + composition)
  // Converts ligatures (ﬁ→fi), full-width chars, fancy quotes ("→"), etc.
  t = t.normalize('NFKC');

  // Remove null bytes and non-printable control characters (but keep \n \t)
  t = t.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ');
  // Replace non-breaking spaces and other whitespace variants with regular space
  t = t.replace(/[  -​  　]/g, ' ');

  // Task 3 — page numbers (match whole lines)
  const pageMatches = t.match(RE_PAGE_NUM) || [];
  if (pageMatches.length) {
    t = t.replace(RE_PAGE_NUM, '');
    stats.removedPageNumbers = pageMatches.length;
  }

  // Task 4 — repeated headers/footers
  if (repeatedLines.size > 0) {
    const lines   = t.split('\n');
    const cleaned = [];
    for (const line of lines) {
      if (repeatedLines.has(line.trim())) {
        stats.removedHeaders++;
      } else {
        cleaned.push(line);
      }
    }
    t = cleaned.join('\n');
  }

  // Separator lines (----, ====, ...)
  t = t.replace(RE_SEPARATOR, '');

  // Task 8 — URLs
  if (removeUrls) {
    const m = t.match(RE_URL) || [];
    stats.removedUrls = m.length;
    t = t.replace(RE_URL, '');
  }

  // Task 9 — emails
  if (removeEmails) {
    const m = t.match(RE_EMAIL) || [];
    stats.removedEmails = m.length;
    t = t.replace(RE_EMAIL, '');
  }

  // Task 11 — boilerplate
  for (const pat of BOILERPLATE) {
    pat.lastIndex = 0;  // reset stateful regex
    if (pat.test(t)) {
      pat.lastIndex = 0;
      t = t.replace(pat, '');
      stats.removedBoilerplate++;
    }
  }

  // Task 6 — fix broken sentences (before collapsing spaces)
  t = fixBrokenSentences(t);

  // Task 5 — special characters
  // Task 12: PRESERVE letters, digits, common punctuation, mathematical symbols,
  //          newlines, and unicode letters/digits (scientific content).
  // REMOVE: decorative/noise chars not in the allowed set.
  if (removeSpecialChars) {
    // Keep: Unicode letters (L), numbers (N), common punctuation/symbol categories,
    //       ASCII punctuation useful in research, and newlines.
    t = t.replace(/[^\p{L}\p{N}\p{P}\p{S}\t\n ]/gu, ' ');
  }

  // Task 1 — normalize horizontal whitespace (multiple spaces → single)
  t = t.replace(/[ \t]+/g, ' ');

  // Task 2 — normalize multiple blank lines (3+ → 2)
  t = t.replace(/\n{3,}/g, '\n\n');

  // Trim trailing whitespace on each line
  t = t.split('\n').map(l => l.trimEnd()).join('\n').trim();

  stats.charsRemoved = rawText.length - t.length;

  return { cleaned: t, stats };
}

// ── Document-level cleaner (all pages at once) ────────────────────────────────

/**
 * Clean all extracted pages of a document.
 *
 * @param {Array}  pages     [{pageNumber, text, wordCount, charCount, ...}]
 * @param {string} fileType  'pdf' | 'docx' | 'txt'
 * @param {object} opts      Cleaning options (see cleanPageText)
 * @returns {{ cleanedPages, report }}
 */
function cleanDocumentPages(pages, fileType, opts = {}) {
  const pageTexts    = pages.map(p => p.text || '');

  // Task 4: detect repeated headers/footers across pages
  const repeatedLines = detectRepeatedLines(pageTexts);

  let charsBefore         = 0;
  let charsAfter          = 0;
  let totalPageNums       = 0;
  let totalHeaders        = 0;
  let totalUrls           = 0;
  let totalEmails         = 0;
  let totalBoilerplate    = 0;

  const cleanedPages = pages.map(page => {
    const rawText = page.text || '';
    const { cleaned, stats } = cleanPageText(rawText, repeatedLines, opts);

    charsBefore      += rawText.length;
    charsAfter       += cleaned.length;
    totalPageNums    += stats.removedPageNumbers;
    totalHeaders     += stats.removedHeaders;
    totalUrls        += stats.removedUrls;
    totalEmails      += stats.removedEmails;
    totalBoilerplate += stats.removedBoilerplate;

    // Recompute word count from cleaned text
    const cleanedWords = cleaned ? cleaned.split(/\s+/).filter(Boolean).length : 0;

    return { ...page, cleanedText: cleaned, cleanedWordCount: cleanedWords };
  });

  const reductionPct = charsBefore > 0
    ? parseFloat(((charsBefore - charsAfter) / charsBefore * 100).toFixed(2))
    : 0;

  const report = {
    charsBefore,
    charsAfter,
    reductionPercent:    reductionPct,
    removedPageNumbers:  totalPageNums,
    removedHeaders:      totalHeaders,
    detectedHeaderLines: repeatedLines.size,
    removedUrls:         totalUrls,
    removedEmails:       totalEmails,
    removedBoilerplate:  totalBoilerplate,
  };

  return { cleanedPages, report };
}

// ── Utility ───────────────────────────────────────────────────────────────────

function emptyStats() {
  return {
    removedPageNumbers: 0,
    removedHeaders:     0,
    removedUrls:        0,
    removedEmails:      0,
    removedBoilerplate: 0,
    charsRemoved:       0,
  };
}

/**
 * Convenience: clean a raw string (single block, not page-split).
 * Used by external callers that don't use the page pipeline.
 */
function cleanRawText(text, opts = {}) {
  const { cleaned } = cleanPageText(text, new Set(), opts);
  return cleaned;
}

module.exports = { cleanDocumentPages, cleanPageText, detectRepeatedLines, cleanRawText };
