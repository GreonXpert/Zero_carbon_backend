// utils/OCR/geminiOCR.js
// Google Gemini Vision fallback OCR for low-quality / phone-photographed utility bills.
//
// Called automatically when Tesseract confidence < GEMINI_FALLBACK_THRESHOLD (default 50).
// Uses gemini-1.5-flash — fast, free-tier eligible, excellent at reading real photos.
//
// Unlike Tesseract, Gemini:
//   • Handles perspective distortion, shadows, and glare natively
//   • Understands bill structure (tables, columns, sections)
//   • Works on the ORIGINAL colour image — no preprocessing needed
//   • Returns structured key-value text that the existing field extractor can parse
//
// Output format matches extractTextFromImage:
//   { text: string, confidence: number, words: [] }

'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');

// Confidence returned when Gemini successfully reads the image.
// Set below 100 so it doesn't shadow learned OCRFeedback mappings (which are 100).
const GEMINI_CONFIDENCE = 88;

// Confidence threshold below which Gemini is triggered.
// Configurable via env var OCR_GEMINI_FALLBACK_THRESHOLD (default 50).
const FALLBACK_THRESHOLD = parseInt(process.env.OCR_GEMINI_FALLBACK_THRESHOLD || '50', 10);

// Supported image MIME types for Gemini inline data
const SUPPORTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/tiff']);

// Lazy singleton client — created only on first use
let _genAI = null;
function getClient() {
  if (!_genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set in environment variables');
    _genAI = new GoogleGenerativeAI(apiKey);
  }
  return _genAI;
}

/**
 * The prompt sent to Gemini.
 * Asks it to extract every key-value pair visible on the bill,
 * formatted as "Label: value unit" — one entry per line.
 * This is exactly what the existing universalFieldExtractor already parses.
 */
const EXTRACTION_PROMPT = `You are an expert at reading utility bills and electricity invoices.

This image is a utility bill (electricity / power bill). Extract ALL text visible in the image.

Format your response as a plain list of key-value pairs, one per line, using this format:
  Label: value unit

Rules:
- Include every field you can read: meter readings, consumption, charges, dates, account info, etc.
- For meter reading tables, extract each row separately. Example:
    KWH/NL/I Curr: 6223 kWh
    KWH/NL/I Prev: 5959 kWh
    KWH/NL/I Cons: 264 kWh
    KWH/OP/I Cons: 257 kWh
    KWH/PK/I Cons: 136 kWh
    Total Units Consumed: 657 kWh
- For the Readings & Consumption section, always include a "Total Units Consumed" or "Cons" line with the total kWh
- Include billing amounts, dates, and any other printed fields
- If a value is unclear, skip that line rather than guessing
- Do NOT include explanatory text or markdown — only the key: value lines
- Numbers must use digits only (no words like "one hundred")`;

/**
 * Convert an image buffer to base64 inline data for Gemini API.
 * Falls back to image/jpeg if MIME type is not directly supported.
 */
function toInlineData(buffer, originalMimetype) {
  const mimeType = SUPPORTED_MIME.has(originalMimetype) ? originalMimetype : 'image/jpeg';
  return {
    inlineData: {
      data: buffer.toString('base64'),
      mimeType,
    },
  };
}

/**
 * Extract text from a utility bill image using Google Gemini Vision.
 *
 * @param {Buffer} buffer          - Original (raw, unprocessed) image buffer
 * @param {string} [mimetype]      - MIME type of the image (default: 'image/jpeg')
 * @returns {Promise<{ text: string, confidence: number, words: [] }>}
 */
async function extractTextWithGemini(buffer, mimetype = 'image/jpeg') {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error('geminiOCR: buffer is required');
  }

  const genAI  = getClient();
  const model  = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  const image  = toInlineData(buffer, mimetype);

  const result   = await model.generateContent([image, EXTRACTION_PROMPT]);
  const response = await result.response;
  const text     = (response.text() || '').trim();

  if (!text) {
    throw new Error('Gemini returned empty response for the bill image');
  }

  return {
    text,
    confidence: GEMINI_CONFIDENCE,
    words: [],        // Gemini doesn't return word-level bounding boxes
    source: 'gemini' // tag so callers know which engine produced this
  };
}

/**
 * Check whether the Gemini fallback should be used for a given Tesseract result.
 *
 * @param {number} tesseractConfidence  - Confidence (0-100) from Tesseract
 * @returns {boolean}
 */
function shouldUsegeminiFallback(tesseractConfidence) {
  if (!process.env.GEMINI_API_KEY) return false;
  return tesseractConfidence < FALLBACK_THRESHOLD;
}

module.exports = { extractTextWithGemini, shouldUsegeminiFallback, GEMINI_CONFIDENCE, FALLBACK_THRESHOLD };
