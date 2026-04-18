'use strict';

const csv    = require('csvtojson');
const xlsx   = require('xlsx');
const submissionService = require('../services/submissionService');
const { canImport } = require('../utils/submissionPermissions');

// ── POST /:clientId/nodes/:nodeId/mappings/:mappingId/import/csv ──────────────
async function importCsv(req, res) {
  try {
    const { clientId, nodeId, mappingId } = req.params;
    const actor = req.user;

    if (!await canImport(actor, clientId)) {
      return res.status(403).json({ success: false, message: 'Not authorized to import' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No CSV file uploaded' });
    }

    // Parse CSV from buffer
    const csvString = req.file.buffer.toString('utf-8');
    let rows;
    try {
      rows = await csv().fromString(csvString);
    } catch (parseErr) {
      return res.status(400).json({ success: false, message: `CSV parse error: ${parseErr.message}` });
    }

    const results = await _processRows(rows, { clientId, nodeId, mappingId, actor, inputType: 'csv', req });
    return res.json({ success: true, data: results });
  } catch (err) {
    console.error('[importController.importCsv]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── POST /:clientId/nodes/:nodeId/mappings/:mappingId/import/excel ────────────
async function importExcel(req, res) {
  try {
    const { clientId, nodeId, mappingId } = req.params;
    const actor = req.user;

    if (!await canImport(actor, clientId)) {
      return res.status(403).json({ success: false, message: 'Not authorized to import' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No Excel file uploaded' });
    }

    const sheetName = req.body?.sheetName;

    let rows;
    try {
      const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
      const sheet    = sheetName
        ? workbook.Sheets[sheetName]
        : workbook.Sheets[workbook.SheetNames[0]];

      if (!sheet) {
        return res.status(400).json({ success: false, message: 'Sheet not found in Excel file' });
      }
      rows = xlsx.utils.sheet_to_json(sheet, { defval: null });
    } catch (parseErr) {
      return res.status(400).json({ success: false, message: `Excel parse error: ${parseErr.message}` });
    }

    const results = await _processRows(rows, { clientId, nodeId, mappingId, actor, inputType: 'excel', req });
    return res.json({ success: true, data: results });
  } catch (err) {
    console.error('[importController.importExcel]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── POST /:clientId/submissions/:submissionId/ocr-extract ─────────────────────
async function ocrExtract(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded for OCR' });
    }

    let extractedValues = {};
    let confidence      = 0;
    let rawResult       = null;

    // Primary: AWS Textract
    try {
      const { TextractClient, DetectDocumentTextCommand } = require('@aws-sdk/client-textract');
      const client = new TextractClient({ region: process.env.AWS_REGION || 'us-east-1' });
      const command = new DetectDocumentTextCommand({
        Document: { Bytes: req.file.buffer },
      });
      const response = await client.send(command);
      rawResult = response;

      // Extract number-like lines as key=value pairs
      const lines = (response.Blocks || [])
        .filter((b) => b.BlockType === 'LINE')
        .map((b) => b.Text || '');

      for (const line of lines) {
        const match = line.match(/^([A-Za-z0-9_\s]+)[:=\s]+([0-9.,]+)$/);
        if (match) {
          const key = match[1].trim().replace(/\s+/g, '_').toLowerCase();
          extractedValues[key] = parseFloat(match[2].replace(',', ''));
        }
      }

      // Estimate confidence from block confidence values
      const confidences = (response.Blocks || [])
        .filter((b) => b.Confidence != null)
        .map((b) => b.Confidence);
      if (confidences.length) {
        confidence = confidences.reduce((a, b) => a + b, 0) / confidences.length / 100;
      }
    } catch (textractErr) {
      console.warn('[importController.ocrExtract] Textract failed, trying Tesseract:', textractErr.message);

      // Fallback: Tesseract.js
      try {
        const Tesseract = require('tesseract.js');
        const result    = await Tesseract.recognize(req.file.buffer, 'eng');
        const text      = result.data.text || '';
        confidence      = result.data.confidence / 100;

        for (const line of text.split('\n')) {
          const match = line.match(/^([A-Za-z0-9_\s]+)[:=\s]+([0-9.,]+)$/);
          if (match) {
            const key = match[1].trim().replace(/\s+/g, '_').toLowerCase();
            extractedValues[key] = parseFloat(match[2].replace(',', ''));
          }
        }
      } catch (tessErr) {
        return res.status(500).json({ success: false, message: 'OCR extraction failed' });
      }
    }

    return res.json({
      success: true,
      data: { extractedValues, confidence, rawTextractResult: rawResult },
    });
  } catch (err) {
    console.error('[importController.ocrExtract]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── POST /:clientId/submissions/:submissionId/ocr-confirm ─────────────────────
async function ocrConfirm(req, res) {
  try {
    const { clientId, submissionId } = req.params;
    const actor = req.user;
    const { dataValues, ocrConfidence } = req.body || {};

    if (!dataValues) {
      return res.status(400).json({ success: false, message: 'dataValues required' });
    }

    const result = await submissionService.updateDraft(
      submissionId,
      { clientId, dataValues },
      actor,
      { req }
    );

    if (result.error) {
      return res.status(result.status || 400).json({ success: false, message: result.error });
    }

    // Update inputType to 'ocr' and store confidence
    const EsgDataEntry = require('../models/EsgDataEntry');
    await EsgDataEntry.updateOne(
      { _id: submissionId },
      { $set: { inputType: 'ocr', ocrConfidence: ocrConfidence || null } }
    );

    return res.json({ success: true, data: { ...result.doc.toObject(), inputType: 'ocr' } });
  } catch (err) {
    console.error('[importController.ocrConfirm]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ─── Private: Process batch rows ─────────────────────────────────────────────
async function _processRows(rows, { clientId, nodeId, mappingId, actor, inputType, req }) {
  const created  = [];
  const errors   = [];
  let processed  = 0;

  for (const row of rows) {
    try {
      const year        = parseInt(row.year, 10) || new Date().getFullYear();
      const periodLabel = row.periodLabel || row.period_label || String(year);

      // All columns except year + periodLabel are data values
      const dataValues = {};
      for (const [k, v] of Object.entries(row)) {
        if (k === 'year' || k === 'periodLabel' || k === 'period_label') continue;
        if (v !== null && v !== '') dataValues[k] = isNaN(Number(v)) ? v : Number(v);
      }

      const result = await submissionService.create(
        {
          clientId,
          nodeId,
          mappingId,
          period:           { year, periodLabel },
          dataValues,
          inputType,
          submissionSource: 'system_import',
          submitImmediately: true,
        },
        actor,
        { req }
      );

      if (result.error) {
        errors.push({ row: processed + 1, error: result.error });
      } else {
        created.push(result.doc._id.toString());
      }
    } catch (rowErr) {
      errors.push({ row: processed + 1, error: rowErr.message });
    }
    processed++;
  }

  return { processed, created: created.length, failed: errors.length, errors, submissionIds: created };
}

module.exports = { importCsv, importExcel, ocrExtract, ocrConfirm };
