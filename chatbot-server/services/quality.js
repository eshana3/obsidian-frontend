// services/quality.js — Document extraction quality validation
'use strict';

const MIN_TEXT_LENGTH = 20; // chars below this = blank/scanned

/**
 * Validate extracted pages and produce a quality report.
 *
 * @param {Array}  pages     Array of { pageNumber, text, wordCount, charCount, isBlank, isScanned, hasError }
 * @param {string} fileType  'pdf' | 'docx' | 'txt'
 * @returns {{ totalPages, processedPages, blankPages, scannedPages, failedPages, overallStatus, pages }}
 */
function validateDocument(pages, fileType) {
  let processedPages = 0;
  let blankPages     = 0;
  let scannedPages   = 0;
  let failedPages    = 0;

  const validatedPages = pages.map(page => {
    if (page.hasError) {
      failedPages++;
      return { ...page, status: 'ERROR', ocrRequired: false };
    }

    // Scanned detection: blank text in a PDF (image-only pages)
    if ((page.isScanned || page.charCount < MIN_TEXT_LENGTH) && fileType === 'pdf' && page.charCount === 0) {
      scannedPages++;
      blankPages++;
      return { ...page, status: 'SCANNED', ocrRequired: true };
    }

    if (page.isBlank || page.charCount < MIN_TEXT_LENGTH) {
      blankPages++;
      return { ...page, status: 'BLANK', ocrRequired: false };
    }

    processedPages++;
    return { ...page, status: 'OK', ocrRequired: false };
  });

  const total = pages.length;
  let overallStatus;
  if (total === 0 || failedPages === total)     overallStatus = 'FAILED';
  else if (processedPages === total)            overallStatus = 'SUCCESS';
  else if (processedPages === 0 && scannedPages === 0) overallStatus = 'FAILED';
  else                                          overallStatus = 'PARTIAL';

  return {
    totalPages:     total,
    processedPages,
    blankPages,
    scannedPages,
    failedPages,
    overallStatus,
    pages:          validatedPages,
  };
}

module.exports = { validateDocument };
