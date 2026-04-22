'use strict';

// ============================================================================
// queryController.js — POST /api/greon-iq/query
//
// Implements all 10 permission gates, orchestrates retrieval, composes the
// DeepSeek response, deducts quota credits, and writes the audit log.
//
// Gates (in order):
//   1  auth middleware          — JWT validated upstream in greonIQRoutes
//   2  greonIQEnabled           — quotaResolutionService.isGreonIQEnabled()
//   3  quota check              — quotaUsageService.checkQuota()
//   4  clientScopeResolver      — which client is active
//   5  intentRouterService      — classify domain
//   6  moduleRegistry lookup    — product + module info
//   7  product gate             — user.accessibleModules includes product
//   8  module access checklist  — accessControls / esgAccessControls
//   9  section access           — sectionRegistry per role
//  10  scope filter             — node/scope/project restriction for employees
// ============================================================================

const { resolveClientScope }     = require('../services/clientScopeResolver');
const { buildAccessContext }     = require('../services/accessContextService');
const { classifyIntent, resolveAmbiguousIntent } = require('../services/intentRouterService');
const { buildQueryPlan }         = require('../services/queryPlannerService');
const { compose }                = require('../services/responseComposerService');
const { isGreonIQEnabled }       = require('../services/quotaResolutionService');
const { checkQuota, deductQuota }= require('../services/quotaUsageService');
const { saveMessage, getOrCreateSession, updateContextState } = require('../services/chatSessionService');
const { writeAuditLog }          = require('../services/auditService');
const { getBaseCredits }         = require('../utils/quotaMathHelpers');
const { explainQuotaExhausted, explainGreonIQDisabled } = require('../utils/permissionExplainer');
const { DENIAL_MESSAGES }        = require('../registry/promptRegistry');

// ── Retriever map ─────────────────────────────────────────────────────────────
const RETRIEVERS = {
  emissionSummaryRetriever: require('../retrievers/emissionSummaryRetriever'),
  dataEntryRetriever:       require('../retrievers/dataEntryRetriever'),
  reductionRetriever:       require('../retrievers/reductionRetriever'),
  sbtiRetriever:            require('../retrievers/sbtiRetriever'),
  esgRetriever:             require('../retrievers/esgRetriever'),
  vectorRetriever:          require('../retrievers/vectorRetriever'),
};

async function query(req, res) {
  const startTime = Date.now();
  const user      = req.user;
  const body      = req.body || {};
  const question  = (body.question || '').trim();
  const sessionId = body.sessionId || null;

  if (!question) {
    return res.status(400).json({ success: false, code: 'MISSING_QUESTION', message: 'question is required.' });
  }

  let auditPayload = {
    userId:       user._id,
    userType:     user.userType,
    clientId:     null,
    question,
    status:       'invalid_request',
    durationMs:   0,
    quotaConsumed: 0,
  };

  try {
    // ── Gate 4: Resolve active client ────────────────────────────────────────
    const scopeResult = await resolveClientScope(user, body.clientId);
    if (scopeResult.error) {
      return res.status(400).json({ success: false, code: scopeResult.code, message: scopeResult.error });
    }
    const { clientId } = scopeResult;
    auditPayload.clientId = clientId;

    // ── Gate 2: greonIQEnabled ───────────────────────────────────────────────
    // super_admin and consultant_admin are always unlimited — bypass the DB check
    // entirely so their access is never accidentally gated by quota records.
    const UNLIMITED = ['super_admin', 'consultant_admin'];
    const enabledCheck = UNLIMITED.includes(String(user.userType || ''))
      ? { enabled: true, isUnlimited: true, allocation: null, monthlyLimit: null, weeklyLimit: null, dailyLimit: null }
      : await isGreonIQEnabled(user, clientId);

    if (!enabledCheck.enabled) {
      auditPayload.status = 'greon_iq_disabled';
      await writeAuditLog(auditPayload);
      return res.status(403).json({
        success: false,
        code:    'GREON_IQ_DISABLED',
        message: explainGreonIQDisabled(),
      });
    }

    // ── Gate 3: Quota check ──────────────────────────────────────────────────
    const quotaCheck = await checkQuota(user._id, clientId, enabledCheck);
    if (!quotaCheck.allowed) {
      auditPayload.status = 'quota_exhausted';
      await writeAuditLog(auditPayload);
      return res.status(429).json({
        success:              false,
        code:                 'QUOTA_EXHAUSTED',
        message:              explainQuotaExhausted(quotaCheck.period, quotaCheck.resetAt),
        resetAt:              quotaCheck.resetAt,
        historyAccessAllowed: true,
      });
    }

    // ── Build access context (Gates 7–10 inputs) ─────────────────────────────
    const accessContext = await buildAccessContext(user, clientId);

    // ── Gate 5: Intent classification ────────────────────────────────────────
    const session = sessionId
      ? await getOrCreateSession(user._id, clientId, sessionId)
      : await getOrCreateSession(user._id, clientId);

    const contextState  = session?.contextState || {};
    const { intent, confidence } = classifyIntent(question);

    let resolvedIntent = intent;
    if (intent === 'ambiguous') {
      resolvedIntent = resolveAmbiguousIntent(question, contextState) || 'ambiguous';
    }

    if (resolvedIntent === 'out_of_system') {
      auditPayload.normalizedIntent = 'out_of_system';
      auditPayload.status           = 'out_of_system';
      await writeAuditLog(auditPayload);
      return res.status(200).json({
        success:        false,
        code:           'OUT_OF_SYSTEM',
        message:        DENIAL_MESSAGES.out_of_system,
        quotaConsumed:  0,
      });
    }

    if (resolvedIntent === 'ambiguous') {
      return res.status(400).json({
        success:  false,
        code:     'AMBIGUOUS_QUESTION',
        message:  'Your question is ambiguous. Please specify a domain (e.g., emissions, ESG, reduction targets).',
        suggestions: [
          'Ask about your emission summary or Scope 1/2/3 data',
          'Ask about ESG metric entries or boundary summary',
          'Ask about reduction projects or SBTi targets',
        ],
      });
    }

    // ── Gates 6-10: Query planning ────────────────────────────────────────────
    const planResult = await buildQueryPlan({
      intent:    resolvedIntent,
      question,
      accessContext,
      contextState,
    });

    if (planResult.error) {
      auditPayload.normalizedIntent = resolvedIntent;
      auditPayload.status           = 'permission_denied';
      await writeAuditLog(auditPayload);
      return res.status(403).json({
        success:  false,
        code:     planResult.code || 'PERMISSION_DENIED',
        message:  planResult.error,
      });
    }

    const plan = { ...planResult.plan, originalQuestion: question };

    // ── Retrieval ─────────────────────────────────────────────────────────────
    const retrieverKey = plan.retriever;
    const retriever    = RETRIEVERS[retrieverKey];
    if (!retriever) {
      return res.status(500).json({ success: false, code: 'RETRIEVER_NOT_FOUND', message: 'Internal configuration error.' });
    }

    const retrievalResult = await retriever.retrieve(plan, accessContext);

    // ── Response composition (calls DeepSeek) ────────────────────────────────
    const composed = await compose(plan, retrievalResult, accessContext);

    // ── Credit deduction ──────────────────────────────────────────────────────
    const baseCredits  = getBaseCredits(plan.outputMode === 'report' ? 'report_preview' : _creditKey(plan));
    const tokensIn     = composed._aiMeta?.tokensIn  || 0;
    const tokensOut    = composed._aiMeta?.tokensOut || 0;
    const deductResult = await deductQuota(user._id, clientId, {
      sessionId:   session._id,
      actionType:  plan.outputMode === 'report' ? 'report_preview' : _creditKey(plan),
      baseCredits,
      tokensIn,
      tokensOut,
      enabledCheck,
    });

    auditPayload = {
      ...auditPayload,
      normalizedIntent:    resolvedIntent,
      detectedProduct:     plan.product,
      queryPlan:           _safeAuditPlan(plan),
      modulesUsed:         [plan.domain],
      recordsTouchedCount: retrievalResult.recordCount,
      excludedDomains:     composed.exclusions,
      aiRequestMeta:       { model: composed._aiMeta?.model, durationMs: Date.now() - startTime },
      aiResponseMeta:      { tokensIn, tokensOut },
      durationMs:          Date.now() - startTime,
      quotaConsumed:       deductResult.totalCredits || baseCredits,
      status:              'success',
    };
    await writeAuditLog(auditPayload);

    // ── Persist message to session ────────────────────────────────────────────
    await saveMessage(session._id, {
      userId:           user._id,
      clientId,
      userQuestion:     question,
      answer:           composed.answer,
      outputMode:       composed.outputMode,
      tables:           composed.tables,
      charts:           composed.charts,
      exclusions:       composed.exclusions,
      followupQuestions:composed.followupQuestions,
      quotaUsed:        deductResult.totalCredits || baseCredits,
      aiMeta:           composed._aiMeta,
      trace:            composed.trace,
    });

    // ── Save context so follow-up questions can resolve their intent ──────────
    await updateContextState(session._id, {
      lastIntent:    resolvedIntent,
      lastDomain:    plan.domain,
      lastProduct:   plan.product,
      lastDateRange: plan.dateRange || null,
    }).catch(() => {});

    // ── API response ──────────────────────────────────────────────────────────
    const { _aiMeta, _aiError, ...publicComposed } = composed;
    return res.status(200).json({
      success: true,
      sessionId: session._id,
      ...publicComposed,
      quotaConsumed: deductResult.totalCredits || baseCredits,
      tokensIn,
      tokensOut,
    });

  } catch (err) {
    auditPayload.durationMs = Date.now() - startTime;
    auditPayload.status     = 'provider_error';
    await writeAuditLog(auditPayload).catch(() => {});
    console.error('[GreOnIQ] query error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' });
  }
}

function _creditKey(plan) {
  if (plan.supportsCharts && plan.supportsTables) return 'qa_chart_table';
  if (plan.supportsTables)                        return 'qa_table';
  if (plan.crossModule)                           return 'cross_module';
  return 'simple_qa';
}

function _safeAuditPlan(plan) {
  return {
    intent:     plan.intent,
    product:    plan.product,
    domain:     plan.domain,
    outputMode: plan.outputMode,
    dateRange:  plan.dateRange ? { label: plan.dateRange.label } : null,
    filtersApplied: {
      hasNodeFilter:    !!(plan.filters?.nodeIds?.length),
      hasScopeFilter:   !!(plan.filters?.scopeIdentifiers?.length),
      hasProjectFilter: !!(plan.filters?.reductionProjectIds?.length),
    },
  };
}

module.exports = { query };
