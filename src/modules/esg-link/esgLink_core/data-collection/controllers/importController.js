'use strict';

const csv    = require('csvtojson');
const xlsx   = require('xlsx');
const submissionService = require('../services/submissionService');
const { canImport } = require('../utils/submissionPermissions');

// ── In-memory job store for background import jobs ───────────────────────────
const importJobStore = new Map();

const getImportProgress = (req, res) => {
  const { jobId } = req.params;
  const job = importJobStore.get(jobId);
  if (!job) return res.status(404).json({ success: false, message: 'Job not found or expired' });
  return res.json({
    success:    true,
    jobId,
    status:     job.status,
    total:      job.total,
    processed:  job.processed,
    created:    job.created,
    failed:     job.failed,
    errors:     job.errors,
    startTime:  job.startTime,
    endTime:    job.endTime,
  });
};

// Required fields every import must resolve (non-formula fallback)
const REQUIRED_FIELDS = ['year', 'periodLabel', 'primaryValue'];

// ── Helper: load variableConfigs for a mapping ────────────────────────────────
// bodyVariableConfigs: array sent by the frontend (preferred — already loaded into task card)
// Falls back to querying EsgLinkBoundary where variableConfigs actually lives.
async function _getVarNames(mappingId, clientId, bodyVariableConfigs) {
  if (Array.isArray(bodyVariableConfigs) && bodyVariableConfigs.length > 0) {
    return bodyVariableConfigs.map((vc) => vc.varName || vc.name).filter(Boolean);
  }
  if (!mappingId) return [];
  try {
    const EsgLinkBoundary = require('../../boundary/models/EsgLinkBoundary');
    const query = clientId ? { clientId } : {};
    const docs  = await EsgLinkBoundary.find(query).exec();
    for (const doc of docs) {
      for (const node of (doc.nodes || [])) {
        const m = (node.metricsDetails || []).find((m) => String(m._id) === String(mappingId));
        if (m?.variableConfigs?.length > 0) {
          return m.variableConfigs.map((vc) => vc.varName).filter(Boolean);
        }
      }
    }
  } catch { /* ignore */ }
  return [];
}

// ── POST /:clientId/nodes/:nodeId/mappings/:mappingId/import/preview ──────────
// Step 1 of smart import: parse file, return headers + sample rows + suggested mapping.
// Nothing is persisted — this is read-only.
async function importPreview(req, res) {
  try {
    const { clientId, mappingId } = req.params;
    const actor = req.user;

    if (!await canImport(actor, clientId)) {
      return res.status(403).json({ success: false, message: 'Not authorized to import' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    // Determine required fields: formula metrics use their variable names.
    // Frontend sends variableConfigs in the multipart body so we don't need a DB lookup.
    let bodyVarConfigs;
    try {
      bodyVarConfigs = req.body.variableConfigs
        ? (typeof req.body.variableConfigs === 'string' ? JSON.parse(req.body.variableConfigs) : req.body.variableConfigs)
        : null;
    } catch { /* ignore */ }
    const varNames      = await _getVarNames(mappingId, clientId, bodyVarConfigs);
    const requiredFields = varNames.length > 0
      ? ['year', 'periodLabel', ...varNames]
      : REQUIRED_FIELDS;

    let rows;
    try {
      rows = await _parseFile(req.file);
    } catch (parseErr) {
      return res.status(400).json({ success: false, message: parseErr.message });
    }

    if (!rows.length) {
      return res.status(400).json({ success: false, message: 'File is empty or has no data rows' });
    }

    const headers      = Object.keys(rows[0]);
    const sampleRows   = rows.slice(0, 5);
    const totalRows    = rows.length;
    const autoMapping  = _suggestMapping(headers, varNames);
    const alreadyValid = _isExactMatch(headers, varNames);

    return res.json({
      success: true,
      data: {
        headers,
        sampleRows,
        totalRows,
        requiredFields,
        varNames,         // sent back so the frontend can build FIELD_META labels
        autoMapping,      // e.g. { year: "Year", periodLabel: "Date", Emission: "Emission_kWh" }
        alreadyValid,     // true → skip mapping UI, use direct import
      },
    });
  } catch (err) {
    console.error('[importController.importPreview]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── POST /:clientId/nodes/:nodeId/mappings/:mappingId/import/mapped ───────────
// Step 2 of smart import: apply user-confirmed column mapping and persist rows.
// Body: { columnMapping: { year, periodLabel, primaryValue, extra?: {...} }, fileKey?: 'sheet name for excel' }
async function importMapped(req, res) {
  try {
    const { clientId, nodeId, mappingId } = req.params;
    const actor = req.user;

    if (!await canImport(actor, clientId)) {
      return res.status(403).json({ success: false, message: 'Not authorized to import' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    let columnMapping;
    try {
      columnMapping = typeof req.body.columnMapping === 'string'
        ? JSON.parse(req.body.columnMapping)
        : req.body.columnMapping;
    } catch {
      return res.status(400).json({ success: false, message: 'columnMapping must be valid JSON' });
    }

    if (!columnMapping || !columnMapping.year || !columnMapping.periodLabel) {
      return res.status(400).json({
        success: false,
        message: 'columnMapping must include: year, periodLabel',
      });
    }

    // For formula metrics, validate that all variable names are mapped
    let bodyVarConfigsMapped;
    try {
      bodyVarConfigsMapped = req.body.variableConfigs
        ? (typeof req.body.variableConfigs === 'string' ? JSON.parse(req.body.variableConfigs) : req.body.variableConfigs)
        : null;
    } catch { /* ignore */ }
    const varNames = await _getVarNames(mappingId, clientId, bodyVarConfigsMapped);
    if (varNames.length > 0) {
      const missing = varNames.filter((v) => !columnMapping[v]);
      if (missing.length > 0) {
        return res.status(400).json({
          success: false,
          message: `columnMapping must include formula variables: ${missing.join(', ')}`,
        });
      }
    } else if (!columnMapping.primaryValue) {
      return res.status(400).json({
        success: false,
        message: 'columnMapping must include: year, periodLabel, primaryValue',
      });
    }

    let rows;
    try {
      rows = await _parseFile(req.file, req.body.sheetName);
    } catch (parseErr) {
      return res.status(400).json({ success: false, message: parseErr.message });
    }

    // Apply mapping: remap each row's keys to canonical names
    const remappedRows = rows.map((row) => _applyMapping(row, columnMapping, varNames));

    const results = await _processRows(remappedRows, {
      clientId, nodeId, mappingId, actor, inputType: 'csv', req,
    });

    return res.json({ success: true, data: results });
  } catch (err) {
    console.error('[importController.importMapped]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

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

    const csvString = req.file.buffer.toString('utf-8');
    let rows;
    try {
      rows = await csv().fromString(csvString);
    } catch (parseErr) {
      return res.status(400).json({ success: false, message: `CSV parse error: ${parseErr.message}` });
    }

    return _startImportJob(res, rows, { clientId, nodeId, mappingId, actor, inputType: 'csv', req });
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

    let rows;
    try {
      rows = await _parseFile(req.file, req.body?.sheetName);
    } catch (parseErr) {
      return res.status(400).json({ success: false, message: parseErr.message });
    }

    return _startImportJob(res, rows, { clientId, nodeId, mappingId, actor, inputType: 'excel', req });
  } catch (err) {
    console.error('[importController.importExcel]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── Shared: create job, respond immediately, process rows in background ───────
function _startImportJob(res, rows, context) {
  const jobId = `esg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    status:    'processing',
    total:     rows.length,
    processed: 0,
    created:   0,
    failed:    0,
    errors:    [],
    startTime: Date.now(),
    endTime:   null,
  };
  importJobStore.set(jobId, job);

  // Respond immediately so frontend can start polling
  res.status(202).json({ success: true, jobId, total: rows.length });

  // Process in background
  setImmediate(async () => {
    try {
      await _processRowsWithJob(rows, context, job);
      job.status  = 'done';
      job.endTime = Date.now();
    } catch (bgErr) {
      console.error('[importController] background error:', bgErr);
      job.status  = 'error';
      job.endTime = Date.now();
    }
    // Auto-cleanup after 30 min
    setTimeout(() => importJobStore.delete(jobId), 30 * 60 * 1000);
  });
}

// ── POST /:clientId/ocr-scan ──────────────────────────────────────────────────
// Standalone OCR scan — no submissionId required.
// Accepts a file, runs OCR, and returns extracted key-value pairs.
async function ocrScan(req, res) {
  return _runOcrExtraction(req, res);
}

// ── POST /:clientId/submissions/:submissionId/ocr-extract ─────────────────────
async function ocrExtract(req, res) {
  return _runOcrExtraction(req, res);
}

// ── Shared OCR extraction logic ───────────────────────────────────────────────
async function _runOcrExtraction(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded for OCR' });
    }

    let extractedValues = {};
    let confidence      = 0;
    let rawText         = '';
    let rawResult       = null;
    let needsAiPass     = false;

    // ── Step 1: AWS Textract (AnalyzeDocument for FORMS + LINE text) ──────────
    try {
      const { TextractClient, AnalyzeDocumentCommand } = require('@aws-sdk/client-textract');
      const client  = new TextractClient({ region: process.env.AWS_REGION || 'us-east-1' });
      const command = new AnalyzeDocumentCommand({
        Document:     { Bytes: req.file.buffer },
        FeatureTypes: ['FORMS', 'TABLES'],
      });
      const response = await client.send(command);
      rawResult = response;

      // LINE blocks → raw text
      const lineText = (response.Blocks || [])
        .filter((b) => b.BlockType === 'LINE')
        .map((b) => b.Text || '')
        .join('\n');

      // KEY_VALUE_SET blocks → "Key: Value" pairs
      const formText = _extractTextractForms(response.Blocks || []);

      // TABLE blocks → "Key: Value" rows (catches bill-detail charge tables)
      const tableText = _extractTextractTables(response.Blocks || []);

      rawText = [lineText, formText, tableText].filter(Boolean).join('\n');

      const confidences = (response.Blocks || [])
        .filter((b) => b.Confidence != null)
        .map((b) => b.Confidence);
      if (confidences.length) {
        confidence = confidences.reduce((a, b) => a + b, 0) / confidences.length / 100;
      }

      // Preliminary extract to check field count — run Gemini if low
      const prelimFields = _extractNumericFields(rawText);
      if (confidence < 0.5 || Object.keys(prelimFields).length < 8) needsAiPass = true;
    } catch (textractErr) {
      console.warn('[importController._runOcrExtraction] Textract failed, trying Tesseract:', textractErr.message);
      needsAiPass = true;

      try {
        const Tesseract = require('tesseract.js');
        const result    = await Tesseract.recognize(req.file.buffer, 'eng');
        rawText    = result.data.text || '';
        confidence = result.data.confidence / 100;
        if (confidence < 0.5) needsAiPass = true;
      } catch {
        console.warn('[importController._runOcrExtraction] Tesseract also failed');
        // fall through to Gemini
      }
    }

    // ── Step 2: DeepSeek text-intelligence pass ──────────────────────────────
    // Textract gives us raw line/form/table text. DeepSeek reads that text and
    // produces a clean key: value list — catching fields the regex missed.
    // Runs whenever Textract confidence is low OR too few fields were extracted.
    if (needsAiPass && process.env.DEEPSEEK_API_KEY) {
      try {
        const { extractOcrFields } = require('../../../../../modules/greon-iq/providers/deepseekProvider');
        const dsResult = await extractOcrFields(rawText || '');
        if (dsResult.success && Object.keys(dsResult.fields).length > 0) {
          // Merge DeepSeek fields — Textract regex values take precedence if already present
          const prelimFields = _extractNumericFields(rawText);
          for (const [k, v] of Object.entries(dsResult.fields)) {
            if (!(k in prelimFields)) prelimFields[k] = v;
          }
          // Re-serialise merged fields back to text so the final _extractNumericFields pass picks them up
          const mergedLines = Object.entries(prelimFields).map(([k, v]) => `${k}: ${v}`).join('\n');
          rawText    = [rawText, mergedLines].filter(Boolean).join('\n');
          confidence = Math.max(confidence, 0.88);
        }
      } catch (dsErr) {
        console.warn('[importController._runOcrExtraction] DeepSeek pass failed:', dsErr.message);
      }
    }

    if (!rawText) {
      return res.json({
        success: true,
        data: { extractedValues: {}, confidence: 0, suggestedPeriod: null, rawTextractResult: null },
      });
    }

    extractedValues   = _extractNumericFields(rawText);
    const suggestedPeriod = _extractPeriod(rawText);

    return res.json({
      success: true,
      data: { extractedValues, confidence, suggestedPeriod, rawTextractResult: rawResult },
    });
  } catch (err) {
    console.error('[importController._runOcrExtraction]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── Extract KEY_VALUE pairs from Textract FORMS analysis ──────────────────────
// Returns a string of "Key: Value\n..." lines to be merged with LINE text.
function _extractTextractForms(blocks) {
  const blockMap = {};
  for (const b of blocks) blockMap[b.Id] = b;

  const pairs = [];
  for (const block of blocks) {
    if (block.BlockType !== 'KEY_VALUE_SET' || !block.EntityTypes?.includes('KEY')) continue;

    const keyText = (block.Relationships || [])
      .filter((r) => r.Type === 'CHILD')
      .flatMap((r) => r.Ids || [])
      .map((id) => blockMap[id]?.Text || '')
      .join(' ')
      .trim();

    const valueRel = (block.Relationships || []).find((r) => r.Type === 'VALUE');
    if (!valueRel?.Ids?.length) continue;

    const valueBlock = blockMap[valueRel.Ids[0]];
    if (!valueBlock) continue;

    const valText = (valueBlock.Relationships || [])
      .filter((r) => r.Type === 'CHILD')
      .flatMap((r) => r.Ids || [])
      .map((id) => blockMap[id]?.Text || '')
      .join(' ')
      .trim();

    if (keyText && valText) pairs.push(`${keyText}: ${valText}`);
  }

  return pairs.join('\n');
}

// ── Extract TABLE blocks from Textract analysis ───────────────────────────────
// Returns "col1: col2" lines from detected tables (catches bill charge rows).
function _extractTextractTables(blocks) {
  const blockMap = {};
  for (const b of blocks) blockMap[b.Id] = b;

  const lines = [];
  for (const block of blocks) {
    if (block.BlockType !== 'TABLE') continue;

    // Map rowIndex → { colIndex → text }
    const rows = {};
    for (const rel of block.Relationships || []) {
      if (rel.Type !== 'CHILD') continue;
      for (const cellId of rel.Ids || []) {
        const cell = blockMap[cellId];
        if (!cell || cell.BlockType !== 'CELL') continue;
        const row = cell.RowIndex;
        const col = cell.ColumnIndex;
        const text = (cell.Relationships || [])
          .filter((r) => r.Type === 'CHILD')
          .flatMap((r) => r.Ids || [])
          .map((id) => blockMap[id]?.Text || '')
          .join(' ')
          .trim();
        if (!rows[row]) rows[row] = {};
        rows[row][col] = text;
      }
    }

    for (const row of Object.values(rows)) {
      const cols = Object.keys(row)
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => row[k])
        .filter(Boolean);
      if (cols.length >= 2) {
        lines.push(cols.join(': '));
      }
    }
  }

  return lines.join('\n');
}

// ── Extract a reporting period (YYYY-MM) from raw OCR text ───────────────────
// Looks for common date patterns, prioritising lines that contain date/period keywords.
function _extractPeriod(text) {
  if (!text) return null;

  const MONTH_MAP = {
    jan: '01', january: '01',
    feb: '02', february: '02',
    mar: '03', march: '03',
    apr: '04', april: '04',
    may: '05',
    jun: '06', june: '06',
    jul: '07', july: '07',
    aug: '08', august: '08',
    sep: '09', september: '09',
    oct: '10', october: '10',
    nov: '11', november: '11',
    dec: '12', december: '12',
  };

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  // Prioritise lines that contain date/period-related keywords
  const isDateLine = (l) =>
    /bill\s*date|billing\s*month|report\s*date|period|issue\s*date|from\s*date|to\s*date|month|date/i.test(l);
  const sorted = [...lines.filter(isDateLine), ...lines.filter((l) => !isDateLine(l))];

  for (const line of sorted) {
    let m;

    // YYYY-MM or YYYY/MM  (e.g. 2026-05)
    m = line.match(/\b(20\d{2})[\/\-](0[1-9]|1[0-2])\b/);
    if (m) return `${m[1]}-${m[2]}`;

    // DD/MM/YYYY or DD-MM-YYYY
    m = line.match(/\b\d{1,2}[\/\-](0[1-9]|1[0-2])[\/\-](20\d{2})\b/);
    if (m) return `${m[2]}-${m[1].padStart(2, '0')}`;

    // YYYY/MM/DD or YYYY-MM-DD (ISO-like, take year+month)
    m = line.match(/\b(20\d{2})[\/\-](0[1-9]|1[0-2])[\/\-]\d{1,2}\b/);
    if (m) return `${m[1]}-${m[2]}`;

    // MM/YYYY or MM-YYYY
    m = line.match(/\b(0[1-9]|1[0-2])[\/\-](20\d{2})\b/);
    if (m) return `${m[2]}-${m[1]}`;

    // "May 2026" or "May-2026"
    m = line.match(/\b([A-Za-z]{3,9})[\s\-](20\d{2})\b/);
    if (m) {
      const mon = MONTH_MAP[m[1].toLowerCase()];
      if (mon) return `${m[2]}-${mon}`;
    }

    // "2026 May" or "2026-May"
    m = line.match(/\b(20\d{2})[\s\-]([A-Za-z]{3,9})\b/);
    if (m) {
      const mon = MONTH_MAP[m[2].toLowerCase()];
      if (mon) return `${m[1]}-${mon}`;
    }
  }

  return null;
}

// ── Extract numeric key-value pairs from raw OCR text ────────────────────────
// Handles:
//   "Energy Charges : 12435.50"
//   "Round off : -0.39"           (negative values)
//   "Meter Rent : 0.00"           (zero values)
//   "Total Units     450"         (whitespace-separated)
//   "KWH/A/I 11889 11074 815 570" (KSEB reading table rows)
function _extractNumericFields(text) {
  const result = {};
  if (!text) return result;

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  // ── Pass 1: detect KSEB-style reading table ─────────────────────────────────
  // Header line: "Unit   Curr   Prev   Cons   Avg" (any order, may have extras)
  // Data line:   "KWH/A/I  11889  11074  815  570"
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    const hasReadingHeader = /\bcurr\b/.test(lower) && /\bprev\b/.test(lower) && /\bcons\b/.test(lower);
    if (!hasReadingHeader) continue;

    // Parse column names from header (skip the first token "Unit" label)
    const headerTokens = lines[i].trim().split(/\s+/).map((h) => h.toLowerCase());
    const colNames = headerTokens.slice(1); // e.g. ['curr', 'prev', 'cons', 'avg']

    // Parse data rows immediately following the header
    for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
      const dataLine = lines[j].trim();
      // Data row starts with a unit-type token (letters/digits/slashes/parens) then space-separated numbers
      const dataMatch = dataLine.match(/^([A-Za-z0-9\/\(\)\-]+)\s+([\d\s,\.]+)$/);
      if (!dataMatch) continue;

      const unitType = dataMatch[1].toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
      const nums = dataMatch[2].trim().split(/\s+/).map((n) => parseFloat(n.replace(/,/g, '')));

      colNames.forEach((col, idx) => {
        if (idx < nums.length && Number.isFinite(nums[idx])) {
          const key = `${unitType}_${col}`;
          if (!(key in result)) result[key] = nums[idx];
        }
      });
    }
    break; // only one reading table expected
  }

  // ── Pass 2: detect "Cons. recorded on Changes" section ─────────────────────
  for (let i = 0; i < lines.length; i++) {
    if (!/cons\.\s*recorded|recorded\s*on\s*changes/i.test(lines[i])) continue;
    // Value is either on this line or the next data line
    for (let j = i; j < Math.min(i + 4, lines.length); j++) {
      const dataLine = lines[j].trim();
      // "KWH/A/I  648" or just "648"
      const m = dataLine.match(/(?:[A-Za-z0-9\/]+\s+)?([\d,]+(?:\.\d+)?)$/);
      if (m) {
        const num = parseFloat(m[1].replace(/,/g, ''));
        if (Number.isFinite(num) && !('cons_recorded_on_changes' in result)) {
          result['cons_recorded_on_changes'] = num;
          break;
        }
      }
    }
    break;
  }

  // ── Pass 3: colon / equals patterns ─────────────────────────────────────────
  for (const line of lines) {
    // "Label [:/=] Value"  — value can be negative (e.g. Round off : -0.39)
    const colonMatch = line.match(
      /^([A-Za-z][A-Za-z0-9 _/()\-\.]{0,60}?)\s*[:=]\s*(-?[0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:[A-Za-z%]*)?$/
    );
    if (colonMatch) {
      const rawKey = colonMatch[1].trim();
      const rawVal = colonMatch[2].replace(/,/g, '');
      const num    = parseFloat(rawVal);
      if (Number.isFinite(num) && rawKey.length >= 1) {
        const key = _toSnake(rawKey);
        if (key && !(key in result)) result[key] = num;
      }
      continue;
    }

    // "Label   Value [unit]"  (2+ spaces, single trailing number)
    const wsMatch = line.match(
      /^([A-Za-z][A-Za-z0-9 _/()\-\.]{2,60}?)\s{2,}(-?[0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:[A-Za-z%]*)?$/
    );
    if (wsMatch) {
      const rawKey = wsMatch[1].trim();
      const rawVal = wsMatch[2].replace(/,/g, '');
      const num    = parseFloat(rawVal);
      if (Number.isFinite(num) && rawKey.includes(' ')) {
        const key = _toSnake(rawKey);
        if (key && !(key in result)) result[key] = num;
      }
    }
  }

  return result;
}

function _toSnake(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
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

// ─── Private helpers ──────────────────────────────────────────────────────────

// Parse CSV or Excel buffer into an array of plain objects
async function _parseFile(file, sheetName) {
  const mimetype = file.mimetype || '';
  const isExcel  = mimetype.includes('spreadsheetml') ||
                   mimetype.includes('excel') ||
                   file.originalname?.match(/\.(xlsx|xls)$/i);

  if (isExcel) {
    const workbook = xlsx.read(file.buffer, { type: 'buffer' });
    const sheet    = sheetName
      ? workbook.Sheets[sheetName]
      : workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw new Error('Sheet not found in Excel file');
    return xlsx.utils.sheet_to_json(sheet, { defval: null });
  }

  // Default: CSV
  return csv().fromString(file.buffer.toString('utf-8'));
}

// Fuzzy-match user headers to required field names
// varNames: formula variable names (e.g. ['Emission', 'Revenue']) — empty for simple metrics
function _suggestMapping(headers, varNames = []) {
  const normalize = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

  const mapping = {};

  // Always suggest year + periodLabel
  const baseAliases = {
    year:        ['year', 'yr', 'fiscalyear', 'reportingyear', 'datayear'],
    periodLabel: ['periodlabel', 'period', 'date', 'month', 'quarter', 'time', 'perioddate', 'reportingperiod'],
  };
  for (const [field, candidates] of Object.entries(baseAliases)) {
    const match = headers.find((h) => candidates.includes(normalize(h)));
    if (match) mapping[field] = match;
  }

  if (varNames.length > 0) {
    // Formula metric: try to match each variable name against file headers
    for (const varName of varNames) {
      const normVar = normalize(varName);
      const match = headers.find(
        (h) => normalize(h) === normVar || normalize(h).includes(normVar) || normVar.includes(normalize(h))
      );
      if (match) mapping[varName] = match;
    }
  } else {
    // Simple metric: suggest primaryValue
    const primaryAliases = ['primaryvalue', 'value', 'amount', 'quantity', 'total',
                             'consumption', 'emission', 'data', 'measurement', 'reading'];
    const match = headers.find((h) => primaryAliases.includes(normalize(h)));
    if (match) mapping.primaryValue = match;
  }

  return mapping;
}

// True when the file headers already contain the exact required column names
function _isExactMatch(headers, varNames = []) {
  const set = new Set(headers);
  if (!set.has('year') || !(set.has('periodLabel') || set.has('period_label'))) return false;
  if (varNames.length > 0) return varNames.every((v) => set.has(v));
  return set.has('primaryValue');
}

// Remap a single row using user-supplied columnMapping.
// For formula metrics, varNames contains the variable names (e.g. ['Emission', 'Revenue']).
// columnMapping = { year: "UserYearCol", periodLabel: "UserDateCol",
//                   Emission: "UserEmCol", Revenue: "UserRevCol" }   ← formula metric
// columnMapping = { year: "UserYearCol", periodLabel: "UserDateCol",
//                   primaryValue: "UserValueCol" }                    ← simple metric
function _applyMapping(row, columnMapping, varNames = []) {
  const remapped = {};

  remapped.year        = row[columnMapping.year];
  remapped.periodLabel = row[columnMapping.periodLabel];

  if (varNames.length > 0) {
    // Formula metric — map each variable by its canonical name
    for (const varName of varNames) {
      if (columnMapping[varName]) {
        remapped[varName] = row[columnMapping[varName]];
      }
    }
  } else {
    // Simple metric — map to primaryValue
    remapped.primaryValue = row[columnMapping.primaryValue];
  }

  // Carry any extra custom field mappings
  if (columnMapping.extra && typeof columnMapping.extra === 'object') {
    for (const [canonical, srcCol] of Object.entries(columnMapping.extra)) {
      if (srcCol && row[srcCol] !== undefined) remapped[canonical] = row[srcCol];
    }
  }

  return remapped;
}

// Persist a batch of already-normalised rows
// Legacy synchronous version (kept for importMapped which still uses it)
async function _processRows(rows, { clientId, nodeId, mappingId, actor, inputType, req }) {
  const created  = [];
  const errors   = [];
  let processed  = 0;

  for (const row of rows) {
    try {
      const year        = parseInt(row.year, 10) || new Date().getFullYear();
      const periodLabel = row.periodLabel || row.period_label || String(year);

      const dataValues = {};
      for (const [k, v] of Object.entries(row)) {
        if (k === 'year' || k === 'periodLabel' || k === 'period_label') continue;
        if (v !== null && v !== '') dataValues[k] = isNaN(Number(v)) ? v : Number(v);
      }

      const result = await submissionService.create(
        { clientId, nodeId, mappingId, period: { year, periodLabel }, dataValues, inputType, submissionSource: 'system_import', submitImmediately: false },
        actor, { req }
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

// Job-aware version — updates the job object as each row is saved
async function _processRowsWithJob(rows, { clientId, nodeId, mappingId, actor, inputType, req }, job) {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const year        = parseInt(row.year, 10) || new Date().getFullYear();
      const periodLabel = row.periodLabel || row.period_label || String(year);

      const dataValues = {};
      for (const [k, v] of Object.entries(row)) {
        if (k === 'year' || k === 'periodLabel' || k === 'period_label') continue;
        if (v !== null && v !== '') dataValues[k] = isNaN(Number(v)) ? v : Number(v);
      }

      const result = await submissionService.create(
        { clientId, nodeId, mappingId, period: { year, periodLabel }, dataValues, inputType, submissionSource: 'system_import', submitImmediately: false },
        actor, { req }
      );

      if (result.error) {
        job.errors.push({ row: i + 1, error: result.error });
        job.failed++;
      } else {
        job.created++;
      }
    } catch (rowErr) {
      job.errors.push({ row: i + 1, error: rowErr.message });
      job.failed++;
    }
    job.processed = i + 1;
  }
}

module.exports = { importPreview, importMapped, importCsv, importExcel, getImportProgress, ocrScan, ocrExtract, ocrConfirm };
