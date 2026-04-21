'use strict';

// ============================================================================
// exportService.js — Orchestrates report export to PDF / DOCX / Excel
//
// generateExport(reportData, format, opts)
//   — existing path: reportData from assembleReportData() (sections-based)
//
// generateExportFromResponse(queryResponse, format, opts)
//   — new path: accepts raw chat query response JSON from the frontend
//     opts must include `user` (User document with profileImage.url)
// ============================================================================

const ChatExportJob           = require('../models/ChatExportJob');
const { toMarkdown }          = require('../exporters/markdownExporter');
const { toPdf, toPdfFromQueryResponse } = require('../exporters/pdfExporter');
const { toDocx }              = require('../exporters/docxExporter');
const { toExcel }             = require('../exporters/excelExporter');
const { getBaseCredits }      = require('../utils/quotaMathHelpers');
const { deductQuota }         = require('./quotaUsageService');

const FORMAT_MIME = {
  pdf:  'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

// ── Existing export (report-format) ──────────────────────────────────────────

/**
 * Generate an export from assembled reportData.
 *
 * @param {object} reportData   — from reportService.assembleReportData()
 * @param {string} format       — 'pdf' | 'docx' | 'xlsx'
 * @param {object} opts         — { userId, clientId, sessionId?, enabledCheck }
 */
async function generateExport(reportData, format, opts) {
  if (!FORMAT_MIME[format]) {
    throw Object.assign(new Error(`Unsupported export format: ${format}`), { code: 'INVALID_FORMAT' });
  }

  const job = await ChatExportJob.create({
    userId:    opts.userId,
    clientId:  opts.clientId,
    sessionId: opts.sessionId || null,
    format,
    status:    'processing',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  let buffer;
  try {
    if (format === 'pdf')       buffer = await toPdf(reportData, opts.user);
    else if (format === 'docx') buffer = await toDocx(reportData);
    else                        buffer = await toExcel(reportData);

    job.status = 'completed';
    await job.save();
  } catch (err) {
    job.status       = 'failed';
    job.errorMessage = err.message;
    await job.save();
    throw err;
  }

  const exportAction = format === 'pdf' ? 'export_pdf' : format === 'docx' ? 'export_docx' : 'export_excel';
  const baseCredits  = getBaseCredits(exportAction);
  const deductResult = await deductQuota(opts.userId, opts.clientId, {
    sessionId:    opts.sessionId,
    actionType:   exportAction,
    baseCredits,
    tokensIn:     0,
    tokensOut:    0,
    enabledCheck: opts.enabledCheck,
  });

  job.creditsCharged = deductResult.totalCredits;
  await job.save();

  const filename = `greon-iq-report-${Date.now()}.${format === 'xlsx' ? 'xlsx' : format}`;

  return {
    jobId:          String(job._id),
    buffer,
    mimeType:       FORMAT_MIME[format],
    filename,
    creditsCharged: deductResult.totalCredits,
  };
}

// ── New export (query-response format) ───────────────────────────────────────

/**
 * Convert a chat query response to the legacy reportData shape
 * so that docx/xlsx exporters can reuse the same path.
 */
function _toReportDataShape(qr) {
  const trace = qr.trace || {};
  return {
    meta: {
      title:      'GreOn IQ Report',
      clientName: trace.clientId || '—',
      period:     (trace.dateRange && trace.dateRange.label) || '—',
      domain:     trace.intent || '—',
    },
    sections: [{
      heading:   'Analysis',
      narrative: qr.answer || '',
      tables:    qr.tables || [],
    }],
    exclusions:        qr.exclusions        || [],
    followupQuestions: qr.followupQuestions || [],
    _recordCount:      qr.recordCount       || 0,
  };
}

/**
 * Generate an export directly from a chat query response object.
 *
 * @param {object} queryResponse  — the full JSON response from POST /api/greon-iq/query
 * @param {string} format         — 'pdf' | 'docx' | 'xlsx'
 * @param {object} opts           — { userId, clientId, sessionId?, enabledCheck, user }
 *   opts.user  — User document (mongoose); profileImage.url is used for the PDF logo
 */
async function generateExportFromResponse(queryResponse, format, opts) {
  if (!FORMAT_MIME[format]) {
    throw Object.assign(new Error(`Unsupported export format: ${format}`), { code: 'INVALID_FORMAT' });
  }

  const job = await ChatExportJob.create({
    userId:    opts.userId,
    clientId:  opts.clientId,
    sessionId: opts.sessionId || null,
    format,
    status:    'processing',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  let buffer;
  try {
    if (format === 'pdf') {
      buffer = await toPdfFromQueryResponse(queryResponse, opts.user);
    } else {
      // docx / xlsx reuse existing path via shape conversion
      const reportData = _toReportDataShape(queryResponse);
      buffer = format === 'docx' ? await toDocx(reportData) : await toExcel(reportData);
    }

    job.status = 'completed';
    await job.save();
  } catch (err) {
    job.status       = 'failed';
    job.errorMessage = err.message;
    await job.save();
    throw err;
  }

  const exportAction = format === 'pdf' ? 'export_pdf' : format === 'docx' ? 'export_docx' : 'export_excel';
  const baseCredits  = getBaseCredits(exportAction);
  const deductResult = await deductQuota(opts.userId, opts.clientId, {
    sessionId:    opts.sessionId,
    actionType:   exportAction,
    baseCredits,
    tokensIn:     0,
    tokensOut:    0,
    enabledCheck: opts.enabledCheck,
  });

  job.creditsCharged = deductResult.totalCredits;
  await job.save();

  const filename = `greon-iq-report-${Date.now()}.${format === 'xlsx' ? 'xlsx' : format}`;

  return {
    jobId:          String(job._id),
    buffer,
    mimeType:       FORMAT_MIME[format],
    filename,
    creditsCharged: deductResult.totalCredits,
  };
}

// ── Export job status ─────────────────────────────────────────────────────────

async function getExportJob(exportId, userId) {
  const job = await ChatExportJob.findById(exportId).lean();
  if (!job) return null;
  return {
    jobId:     String(job._id),
    format:    job.format,
    status:    job.status,
    expiresAt: job.expiresAt,
  };
}

module.exports = { generateExport, generateExportFromResponse, getExportJob };
