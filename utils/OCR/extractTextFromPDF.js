// utils/OCR/extractTextFromPDF.js
// Convert PDF pages to images then OCR each page using pdf2pic + Tesseract
//
// SYSTEM DEPENDENCY: pdf2pic requires GraphicsMagick or ImageMagick AND
// Ghostscript to be installed on the host OS.
// - Ubuntu/Debian: sudo apt-get install ghostscript graphicsmagick
// - Amazon Linux 2: sudo yum install ghostscript GraphicsMagick
// - macOS (brew): brew install ghostscript graphicsmagick
// Without these, this module will throw at runtime.

const { fromBuffer } = require('pdf2pic');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { preprocessImage } = require('./preprocessImage');
const { extractTextFromImage } = require('./extractTextFromImage');

const MAX_PAGES = parseInt(process.env.OCR_MAX_PDF_PAGES || '10', 10);

/**
 * Extract text from a PDF buffer by converting pages to images and OCR-ing each.
 *
 * Returns:
 *  - text:       All pages joined (backward compat — used by legacy /ocr-data route)
 *  - confidence: Average confidence across pages (backward compat)
 *  - pageCount:  Total pages processed (backward compat)
 *  - pages:      Per-page detail array (NEW — used by /ocr-extract route for multi-record preview)
 *                [{ pageNumber, text, confidence }]
 *
 * @param {Buffer} pdfBuffer   - Raw PDF file buffer
 * @returns {Promise<{
 *   text: string,
 *   confidence: number,
 *   pageCount: number,
 *   pages: Array<{ pageNumber: number, text: string, confidence: number }>
 * }>}
 */
async function extractTextFromPDF(pdfBuffer) {
  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
    throw new Error('extractTextFromPDF: pdfBuffer is required');
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-pdf-'));

  try {
    // Convert PDF pages to PNG images
    const converter = fromBuffer(pdfBuffer, {
      density: 300,      // DPI — higher = better OCR accuracy but slower
      format: 'png',
      width: 2480,       // A4 at 300dpi
      height: 3508,
      savePath: tmpDir,
      saveFilename: 'page'
    });

    // Detect page count by attempting conversion with a high upper bound
    // pdf2pic throws when page exceeds document length — we catch and stop
    const pageTexts = [];
    const pageConfidences = [];

    /** @type {Array<{ pageNumber: number, text: string, confidence: number }>} */
    const pages = [];
    let pageCount = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      let result;
      try {
        result = await converter(page, { responseType: 'buffer' });
      } catch (err) {
        // pdf2pic throws when the page number exceeds the document's page count
        if (
          err.message?.includes('Page') ||
          err.message?.includes('page') ||
          err.message?.includes('Invalid')
        ) {
          break; // normal end of document
        }
        // Password-protected or corrupt PDF
        if (
          err.message?.includes('password') ||
          err.message?.includes('encrypted')
        ) {
          throw new Error('PDF is password-protected and cannot be processed');
        }
        throw new Error(`PDF page conversion failed (page ${page}): ${err.message}`);
      }

      if (!result || !result.buffer) break;
      pageCount++;

      let pageText = `[OCR failed for page ${page}]`;
      let pageConf = 0;

      try {
        const processedBuffer = await preprocessImage({ buffer: result.buffer });
        const { text, confidence } = await extractTextFromImage(processedBuffer);
        pageText = text || '';
        pageConf = confidence || 0;
      } catch (ocrErr) {
        // Skip a page that fails OCR rather than aborting the whole document
        console.warn(`[extractTextFromPDF] OCR failed for page ${page}: ${ocrErr.message}`);
      }

      pages.push({ pageNumber: page, text: pageText, confidence: pageConf });
      pageTexts.push(`--- PAGE ${page} ---\n${pageText}`);
      pageConfidences.push(pageConf);
    }

    if (pageCount === 0) {
      throw new Error('PDF appears to be empty or could not be converted to images');
    }

    const avgConfidence =
      pageConfidences.length > 0
        ? Math.round(pageConfidences.reduce((a, b) => a + b, 0) / pageConfidences.length)
        : 0;

    return {
      // Backward-compatible fields (used by legacy saveOCRData)
      text: pageTexts.join('\n\n'),
      confidence: avgConfidence,
      pageCount,
      // New per-page detail (used by extractOCRPreview for multi-record output)
      pages
    };
  } finally {
    // Always clean up temporary files
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn('[extractTextFromPDF] Temp cleanup failed:', cleanupErr.message);
    }
  }
}

module.exports = { extractTextFromPDF };
