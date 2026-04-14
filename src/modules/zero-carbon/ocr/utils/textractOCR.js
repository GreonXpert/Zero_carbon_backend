// utils/OCR/textractOCR.js
// AWS Textract fallback OCR for low-quality / phone-photographed utility bills.
//
// Called automatically when Tesseract confidence < TEXTRACT_FALLBACK_THRESHOLD (default 50).
//
// Why Textract works better than Tesseract for phone photos:
//   • AWS handles image correction (perspective, rotation, blur) server-side
//   • FORMS feature extracts key-value pairs directly (e.g. "Bill Amount: 16611")
//   • TABLES feature reads consumption tables (kWh rows) accurately
//   • Works with the ORIGINAL colour image — no pre-processing needed
//   • Uses same AWS credentials already configured for S3
//
// Output format matches extractTextFromImage:
//   { text: string, confidence: number, words: [] }

'use strict';

const { TextractClient, AnalyzeDocumentCommand } = require('@aws-sdk/client-textract');

// Confidence returned when Textract successfully reads the image.
// Set below 100 so it doesn't shadow learned OCRFeedback mappings (which are 100).
const TEXTRACT_CONFIDENCE = 90;

// Tesseract confidence threshold below which Textract is triggered.
// Configurable via OCR_TEXTRACT_FALLBACK_THRESHOLD env var (default 50).
const FALLBACK_THRESHOLD = parseInt(process.env.OCR_TEXTRACT_FALLBACK_THRESHOLD || '50', 10);

// Lazy singleton Textract client
let _client = null;
function getClient() {
  if (!_client) {
    _client = new TextractClient({
      region:      process.env.AWS_REGION      || 'us-east-1',
      credentials: {
        accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return _client;
}

// ─────────────────────────────────────────────────────────────────────────────
// Block parsing helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a lookup map of blockId → Block from the Textract response Blocks array.
 */
function buildBlockMap(blocks) {
  const map = {};
  for (const block of blocks) map[block.Id] = block;
  return map;
}

/**
 * Get the plain text of a block by following its child WORD relationships.
 */
function getBlockText(block, blockMap) {
  if (!block.Relationships) return block.Text || '';
  const words = [];
  for (const rel of block.Relationships) {
    if (rel.Type === 'CHILD') {
      for (const id of rel.Ids) {
        const child = blockMap[id];
        if (child && child.BlockType === 'WORD') words.push(child.Text);
      }
    }
  }
  return words.join(' ');
}

/**
 * Extract FORMS (KEY_VALUE_SET) from Textract blocks.
 * Returns lines in "Key: Value" format that universalFieldExtractor can parse.
 */
function extractForms(blocks, blockMap) {
  const lines = [];
  const keyBlocks = blocks.filter(
    b => b.BlockType === 'KEY_VALUE_SET' && b.EntityTypes && b.EntityTypes.includes('KEY')
  );

  for (const keyBlock of keyBlocks) {
    const keyText = getBlockText(keyBlock, blockMap).trim();
    if (!keyText) continue;

    // Find the associated VALUE block via VALUE relationship
    let valueText = '';
    if (keyBlock.Relationships) {
      for (const rel of keyBlock.Relationships) {
        if (rel.Type === 'VALUE') {
          for (const valId of rel.Ids) {
            const valBlock = blockMap[valId];
            if (valBlock) valueText = getBlockText(valBlock, blockMap).trim();
          }
        }
      }
    }

    if (valueText) lines.push(`${keyText}: ${valueText}`);
  }
  return lines;
}

/**
 * Extract TABLES from Textract blocks.
 * For each table row, produces "CellA CellB: CellC CellD" style lines
 * so the universalFieldExtractor can pick up numeric values with their labels.
 */
function extractTables(blocks, blockMap) {
  const lines = [];
  const tableBlocks = blocks.filter(b => b.BlockType === 'TABLE');

  for (const table of tableBlocks) {
    if (!table.Relationships) continue;

    // Gather all cells belonging to this table
    const cells = [];
    for (const rel of table.Relationships) {
      if (rel.Type === 'CHILD') {
        for (const id of rel.Ids) {
          const cell = blockMap[id];
          if (cell && cell.BlockType === 'CELL') cells.push(cell);
        }
      }
    }

    // Group cells by row
    const rows = {};
    for (const cell of cells) {
      const row = cell.RowIndex;
      if (!rows[row]) rows[row] = [];
      rows[row].push(cell);
    }

    // Sort each row by column and emit as a tab-separated line
    for (const row of Object.values(rows)) {
      row.sort((a, b) => a.ColumnIndex - b.ColumnIndex);
      const parts = row.map(cell => getBlockText(cell, blockMap).trim()).filter(Boolean);
      if (parts.length > 0) lines.push(parts.join('\t'));
    }
  }
  return lines;
}

/**
 * Extract plain LINE blocks (covers any text not captured by FORMS or TABLES).
 */
function extractLines(blocks) {
  return blocks
    .filter(b => b.BlockType === 'LINE' && b.Text)
    .map(b => b.Text.trim())
    .filter(Boolean);
}

/**
 * Compute average confidence across all LINE blocks.
 * Returns TEXTRACT_CONFIDENCE if no lines found (Textract itself succeeded).
 */
function computeConfidence(blocks) {
  const lineConfs = blocks
    .filter(b => b.BlockType === 'LINE' && typeof b.Confidence === 'number')
    .map(b => b.Confidence);
  if (!lineConfs.length) return TEXTRACT_CONFIDENCE;
  const avg = lineConfs.reduce((s, c) => s + c, 0) / lineConfs.length;
  return Math.min(Math.round(avg), TEXTRACT_CONFIDENCE);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract text from a utility bill image using AWS Textract.
 * Sends the raw image buffer directly (no S3 reference needed).
 *
 * FeatureTypes used:
 *   FORMS  — extracts key-value pairs (e.g. "Energy Charges: 12435.50")
 *   TABLES — extracts consumption tables (kWh readings rows)
 *
 * @param {Buffer} buffer   - Original (raw, unprocessed) image buffer
 * @returns {Promise<{ text: string, confidence: number, words: [], source: string }>}
 */
async function extractTextWithTextract(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error('textractOCR: buffer is required');
  }

  const client  = getClient();
  const command = new AnalyzeDocumentCommand({
    Document:     { Bytes: buffer },
    FeatureTypes: ['FORMS', 'TABLES'],
  });

  const response = await client.send(command);
  const blocks   = response.Blocks || [];

  if (!blocks.length) {
    throw new Error('AWS Textract returned no blocks for the image');
  }

  const blockMap = buildBlockMap(blocks);

  // Build the final text in priority order:
  //   1. FORMS  → clean "Key: Value" pairs   (best for field extraction)
  //   2. TABLES → tab-separated rows          (best for kWh reading tables)
  //   3. LINES  → raw text fallback           (catches anything else)
  const formLines  = extractForms(blocks, blockMap);
  const tableLines = extractTables(blocks, blockMap);
  const rawLines   = extractLines(blocks);

  // Deduplicate: don't repeat content already captured by FORMS/TABLES
  const formSet  = new Set(formLines.map(l => l.toLowerCase()));
  const tableSet = new Set(tableLines.map(l => l.toLowerCase()));
  const uniqueRaw = rawLines.filter(
    l => !formSet.has(l.toLowerCase()) && !tableSet.has(l.toLowerCase())
  );

  const combinedText = [
    ...formLines,
    ...tableLines,
    ...uniqueRaw,
  ].join('\n').trim();

  if (!combinedText) {
    throw new Error('AWS Textract extracted no text from the image');
  }

  return {
    text:       combinedText,
    confidence: computeConfidence(blocks),
    words:      [],
    source:     'textract',
  };
}

/**
 * Check whether the Textract fallback should be used for a given Tesseract result.
 *
 * @param {number} tesseractConfidence  - Confidence (0-100) from Tesseract
 * @returns {boolean}
 */
function shouldUseTextractFallback(tesseractConfidence) {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) return false;
  return tesseractConfidence < FALLBACK_THRESHOLD;
}

module.exports = { extractTextWithTextract, shouldUseTextractFallback, TEXTRACT_CONFIDENCE, FALLBACK_THRESHOLD };
