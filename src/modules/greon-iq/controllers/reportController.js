'use strict';

// ============================================================================
// reportController.js — Report preview and export endpoints
//
// POST /api/greon-iq/report/preview   — generate markdown report preview
// POST /api/greon-iq/report/export    — export as PDF / DOCX / Excel
// GET  /api/greon-iq/exports/:exportId — poll export job status
// ============================================================================

const { resolveClientScope }  = require('../services/clientScopeResolver');
const { buildAccessContext }  = require('../services/accessContextService');
const { classifyIntent }      = require('../services/intentRouterService');
const { isGreonIQEnabled }    = require('../services/quotaResolutionService');
const { checkQuota, deductQuota } = require('../services/quotaUsageService');
const { assembleReportData }  = require('../services/reportService');
const { generateExport, generateExportFromResponse, getExportJob } = require('../services/exportService');
const { toMarkdown }          = require('../exporters/markdownExporter');
const { writeAuditLog }       = require('../services/auditService');
const { getBaseCredits }      = require('../utils/quotaMathHelpers');
const { explainQuotaExhausted, explainGreonIQDisabled } = require('../utils/permissionExplainer');
const ChatSession                = require('../models/ChatSession');
const GreOnIQInteractionEvent    = require('../models/GreOnIQInteractionEvent');

// Resolve report context from either direct body fields or an existing session.
// Returns { question, intent, clientId, contextState, requestedSections } or an error object.
async function _resolveReportContext(user, body) {
  const { question, intent, clientId: bodyClientId, sessionId, sections } = body;

  // ── Case 1: sessionId provided — load context from session ──────────────
  if (sessionId) {
    const session = await ChatSession.findOne({ _id: sessionId, isActive: true }).lean();
    if (!session) {
      return { error: 'Session not found or expired.', code: 'SESSION_NOT_FOUND' };
    }
    const ctx          = session.contextState || {};
    const resolvedIntent = intent || ctx.lastIntent || ctx.lastDomain || 'emission_summary';
    const resolvedQ    = question || `Generate a ${resolvedIntent.replace(/_/g, ' ')} report`;
    const resolvedClient = bodyClientId || session.clientId;
    return {
      question:          resolvedQ,
      intent:            resolvedIntent,
      clientId:          resolvedClient,
      contextState:      ctx,
      requestedSections: sections || null,
    };
  }

  // ── Case 2: explicit question in body ────────────────────────────────────
  if (!question) {
    return { error: 'Provide either a sessionId or a question.', code: 'MISSING_QUESTION' };
  }
  return {
    question,
    intent:            intent || classifyIntent(question).intent,
    clientId:          bodyClientId,
    contextState:      {},
    requestedSections: sections || null,
  };
}

// POST /api/greon-iq/report/preview
async function preview(req, res) {
  const startTime = Date.now();
  const user      = req.user;

  let reportCtx;
  try {
    reportCtx = await _resolveReportContext(user, req.body || {});
  } catch (e) {
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
  if (reportCtx.error) {
    return res.status(400).json({ success: false, code: reportCtx.code, message: reportCtx.error });
  }

  const { question, intent: resolvedIntent, clientId: bodyClientId, contextState, requestedSections } = reportCtx;

  try {
    const scopeResult = await resolveClientScope(user, bodyClientId);
    if (scopeResult.error) {
      return res.status(400).json({ success: false, code: scopeResult.code, message: scopeResult.error });
    }
    const { clientId } = scopeResult;

    const UNLIMITED = ['super_admin', 'consultant_admin'];
    const enabledCheck = UNLIMITED.includes(String(user.userType || ''))
      ? { enabled: true, isUnlimited: true, allocation: null, monthlyLimit: null, weeklyLimit: null, dailyLimit: null }
      : await isGreonIQEnabled(user, clientId);

    if (!enabledCheck.enabled) {
      return res.status(403).json({ success: false, code: 'GREON_IQ_DISABLED', message: explainGreonIQDisabled() });
    }

    const quotaCheck = await checkQuota(user._id, clientId, enabledCheck);
    if (!quotaCheck.allowed) {
      return res.status(429).json({
        success: false, code: 'QUOTA_EXHAUSTED',
        message: explainQuotaExhausted(quotaCheck.period, quotaCheck.resetAt),
        resetAt: quotaCheck.resetAt, historyAccessAllowed: true,
      });
    }

    const accessContext = await buildAccessContext(user, clientId);

    const reportData   = await assembleReportData({
      intent:            resolvedIntent,
      question,
      accessContext,
      contextState,
      requestedSections,
    });
    const markdownText = toMarkdown(reportData);

    // Deduct report_preview credits
    const baseCredits = getBaseCredits('report_preview');
    const deductResult= await deductQuota(user._id, clientId, {
      actionType: 'report_preview', baseCredits,
      tokensIn:   reportData._aiUsage?.prompt_tokens    || 0,
      tokensOut:  reportData._aiUsage?.completion_tokens|| 0,
      enabledCheck,
    });

    await writeAuditLog({
      userId: user._id, userType: user.userType, clientId,
      question, normalizedIntent: resolvedIntent, detectedProduct: reportData.meta.domain,
      modulesUsed: [reportData._plan?.domain],
      recordsTouchedCount: reportData._recordCount,
      excludedDomains: reportData.exclusions,
      durationMs: Date.now() - startTime,
      quotaConsumed: deductResult.totalCredits,
      status: 'success',
    });

    return res.status(200).json({
      success:         true,
      markdown:        markdownText,
      meta:            reportData.meta,
      exclusions:      reportData.exclusions,
      followupQuestions: reportData.followupQuestions,
      quotaConsumed:   deductResult.totalCredits,
      exportFormats:   ['pdf', 'docx', 'xlsx'],
    });
  } catch (err) {
    console.error('[GreOnIQ] report preview error:', err.message);
    if (err.code === 'PERMISSION_DENIED' || err.code === 'MODULE_ACCESS_DENIED') {
      return res.status(403).json({ success: false, code: err.code, message: err.message });
    }
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

// POST /api/greon-iq/report/export
async function exportReport(req, res) {
  const user   = req.user;
  const format = req.body?.format || 'pdf';

  if (!['pdf', 'docx', 'xlsx'].includes(format)) {
    return res.status(400).json({ success: false, code: 'INVALID_FORMAT', message: 'format must be pdf, docx, or xlsx.' });
  }

  let reportCtx;
  try {
    reportCtx = await _resolveReportContext(user, req.body || {});
  } catch (e) {
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
  if (reportCtx.error) {
    return res.status(400).json({ success: false, code: reportCtx.code, message: reportCtx.error });
  }

  const { question, intent: resolvedIntent, clientId: bodyClientId, contextState, requestedSections } = reportCtx;

  try {
    const scopeResult = await resolveClientScope(user, bodyClientId);
    if (scopeResult.error) {
      return res.status(400).json({ success: false, code: scopeResult.code, message: scopeResult.error });
    }
    const { clientId } = scopeResult;

    const UNLIMITED = ['super_admin', 'consultant_admin'];
    const enabledCheck = UNLIMITED.includes(String(user.userType || ''))
      ? { enabled: true, isUnlimited: true, allocation: null, monthlyLimit: null, weeklyLimit: null, dailyLimit: null }
      : await isGreonIQEnabled(user, clientId);

    if (!enabledCheck.enabled) {
      return res.status(403).json({ success: false, code: 'GREON_IQ_DISABLED', message: explainGreonIQDisabled() });
    }

    const quotaCheck = await checkQuota(user._id, clientId, enabledCheck);
    if (!quotaCheck.allowed) {
      return res.status(429).json({
        success: false, code: 'QUOTA_EXHAUSTED',
        message: explainQuotaExhausted(quotaCheck.period, quotaCheck.resetAt),
        resetAt: quotaCheck.resetAt, historyAccessAllowed: true,
      });
    }

    const accessContext = await buildAccessContext(user, clientId);
    const reportData    = await assembleReportData({
      intent: resolvedIntent, question, accessContext, contextState, requestedSections,
    });

    const result = await generateExport(reportData, format, {
      userId: user._id, clientId, enabledCheck, user,
    });

    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('X-GreOnIQ-JobId',         result.jobId);
    res.setHeader('X-GreOnIQ-Credits',        String(result.creditsCharged));
    return res.status(200).send(result.buffer);
  } catch (err) {
    console.error('[GreOnIQ] report export error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

// GET /api/greon-iq/exports/:exportId
async function getExport(req, res) {
  try {
    const job = await getExportJob(req.params.exportId, String(req.user._id));
    if (!job) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    }
    return res.status(200).json({ success: true, ...job });
  } catch (err) {
    console.error('[GreOnIQ] getExport error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

// POST /api/greon-iq/chat/export-response
async function exportFromResponse(req, res) {
  const user = req.user;
  const { queryResponse, format = 'pdf' } = req.body || {};

  if (!queryResponse || typeof queryResponse !== 'object') {
    return res.status(400).json({
      success: false,
      code: 'MISSING_RESPONSE',
      message: 'queryResponse is required.',
    });
  }
  if (!['pdf', 'docx', 'xlsx'].includes(format)) {
    return res.status(400).json({ success: false, code: 'INVALID_FORMAT', message: 'format must be pdf, docx, or xlsx.' });
  }

  // Resolve clientId from trace or explicit body field
  const clientId = (queryResponse.trace && queryResponse.trace.clientId) || req.body.clientId;

  try {
    const scopeResult = await resolveClientScope(user, clientId);
    if (scopeResult.error) {
      return res.status(400).json({ success: false, code: scopeResult.code, message: scopeResult.error });
    }
    const resolvedClientId = scopeResult.clientId;

    const UNLIMITED = ['super_admin', 'consultant_admin'];
    const enabledCheck = UNLIMITED.includes(String(user.userType || ''))
      ? { enabled: true, isUnlimited: true, allocation: null, monthlyLimit: null, weeklyLimit: null, dailyLimit: null }
      : await isGreonIQEnabled(user, resolvedClientId);

    if (!enabledCheck.enabled) {
      return res.status(403).json({ success: false, code: 'GREON_IQ_DISABLED', message: explainGreonIQDisabled() });
    }

    const quotaCheck = await checkQuota(user._id, resolvedClientId, enabledCheck);
    if (!quotaCheck.allowed) {
      return res.status(429).json({
        success: false, code: 'QUOTA_EXHAUSTED',
        message: explainQuotaExhausted(quotaCheck.period, quotaCheck.resetAt),
        resetAt: quotaCheck.resetAt, historyAccessAllowed: true,
      });
    }

    const result = await generateExportFromResponse(queryResponse, format, {
      userId:    user._id,
      clientId:  resolvedClientId,
      sessionId: queryResponse.sessionId || null,
      enabledCheck,
      user,
    });

    // ── Record interaction event (non-fatal) ──────────────────────────────
    try {
      const sessionId = queryResponse.sessionId || queryResponse._id || null;
      if (sessionId) {
        await GreOnIQInteractionEvent.create({
          userId:       user._id,
          clientId:     resolvedClientId,
          sessionId,
          messageId:    null,
          eventType:    'export',
          exportFormat: format,
        });
      }
    } catch (evtErr) {
      console.error('[GreOnIQ] export event write error (non-fatal):', evtErr.message);
    }

    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('X-GreOnIQ-JobId',    result.jobId);
    res.setHeader('X-GreOnIQ-Credits',  String(result.creditsCharged));
    return res.status(200).send(result.buffer);
  } catch (err) {
    console.error('[GreOnIQ] exportFromResponse error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

module.exports = { preview, exportReport, getExport, exportFromResponse };
