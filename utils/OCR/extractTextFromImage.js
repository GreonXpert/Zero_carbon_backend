// utils/OCR/extractTextFromImage.js
// Extract text from an image buffer using Tesseract.js
//
// Uses a singleton worker pattern with a Promise-based lock to prevent
// duplicate initialisation under concurrent requests.
//
// PSM strategy for utility bills:
//   We try PSM 6 first (uniform block of text — best for printed bills/forms).
//   If confidence < 50, we retry with PSM 4 (single column of text — good for
//   narrow-column bills like KSEB).
//   PSM 3 (auto) is kept as a final fallback.
//   The result with the highest confidence is returned.
//
// SCALING NOTE: A single Tesseract worker holds ~100MB RAM. For production
// traffic, replace this singleton with a worker pool or move OCR processing
// to a Bull queue job. See ocrWorker.js (planned) for the queue variant.

let _workerPromise = null;

/**
 * Lazily initialise (and cache) the Tesseract worker.
 * The Promise-based lock prevents double-initialisation under concurrency.
 */
function getWorker() {
  if (!_workerPromise) {
    const { createWorker } = require('tesseract.js');
    _workerPromise = createWorker('eng', 1, {
      // OEM 1 = LSTM neural engine (most accurate)
      logger: () => {} // suppress Tesseract progress logs
    }).catch(err => {
      _workerPromise = null; // allow retry on next call
      throw err;
    });
  }
  return _workerPromise;
}

/**
 * Run Tesseract with a specific Page Segmentation Mode (PSM).
 */
async function recognizeWithPSM(worker, buffer, psm) {
  const { data } = await worker.recognize(buffer, {
    tessedit_pageseg_mode: psm,
  });
  return {
    text: (data.text || '').trim(),
    confidence: Math.round(data.confidence || 0),
    words: data.words || []
  };
}

/**
 * Extract text from a preprocessed image buffer.
 * Automatically tries multiple PSM modes and returns the best result.
 *
 * PSM modes tried (in order):
 *   6  = Assume a single uniform block of text  → best for standard bills
 *   4  = Assume a single column of text          → good for narrow receipts
 *   3  = Fully automatic (default fallback)
 *
 * @param {Buffer} buffer - PNG/JPEG buffer (ideally pre-processed with preprocessImage)
 * @returns {Promise<{ text: string, confidence: number, words: Array }>}
 */
async function extractTextFromImage(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error('extractTextFromImage: buffer is required');
  }

  try {
    const worker = await getWorker();

    // PSM 6: uniform block of text — best starting point for utility bills
    const result6 = await recognizeWithPSM(worker, buffer, 6);
    if (result6.confidence >= 50) return result6;

    // PSM 4: single column — good for narrow-format bills (KSEB style)
    const result4 = await recognizeWithPSM(worker, buffer, 4);
    if (result4.confidence >= 50) return result4;

    // PSM 3: automatic fallback — pick whichever gave the best confidence
    const result3 = await recognizeWithPSM(worker, buffer, 3);

    const best = [result6, result4, result3].reduce((a, b) =>
      b.confidence > a.confidence ? b : a
    );
    return best;

  } catch (err) {
    throw new Error(`OCR text extraction failed: ${err.message}`);
  }
}

module.exports = { extractTextFromImage };
