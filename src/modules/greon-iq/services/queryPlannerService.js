'use strict';

// ============================================================================
// queryPlannerService.js — Converts intent + access context into a query plan
//
// Produces a deterministic, permission-safe plan object that all retrievers
// and the response composer operate from. The plan is logged in ChatAuditLog.
//
// The plan contains NO sensitive values — only safe filter keys and ranges.
//
// MAX_CONTEXT_RECORDS limits how many records are passed to DeepSeek to
// avoid exceeding the model's context window.
// ============================================================================

const { getModuleInfo }           = require('../registry/moduleRegistry');
const { resolveAllowedSections }  = require('../registry/sectionRegistry');
const { validateDomainAccess }    = require('./accessContextService');
const { detectDateExpression,
        resolveDateRange }        = require('./dateRangePlanner');

const MAX_CONTEXT_RECORDS = 50; // configurable here — no code change needed elsewhere

/**
 * Build a query plan from intent classification + access context.
 *
 * @param {object} params
 * @param {string} params.intent          — from intentRouterService
 * @param {string} params.question        — original user question
 * @param {object} params.accessContext   — from accessContextService
 * @param {object|null} params.contextState — session context (for follow-ups)
 * @returns {{ plan: object }|{ error: string, code: string }}
 */
function buildQueryPlan({ intent, question, accessContext, contextState }) {

  // ── Handle out_of_system early ────────────────────────────────────────────
  if (intent === 'out_of_system') {
    return {
      plan: {
        intent:       'out_of_system',
        clientId:     accessContext.clientId,
        product:      null,
        domain:       null,
        sections:     [],
        retriever:    null,
        dateRange:    null,
        filters:      {},
        outputMode:   'plain',
        maxRecords:   0,
        permissionsApplied: { nodeRestrictions: null },
        supportsCharts:  false,
        supportsTables:  false,
        supportsReports: false,
      },
    };
  }

  // ── Handle ambiguous (use context or return prompt) ───────────────────────
  if (intent === 'ambiguous') {
    return {
      error: 'I could not determine which data domain your question refers to. ' +
             'Could you please clarify — for example, are you asking about emission summaries, ' +
             'reduction projects, ESG data entries, or something else?',
      code:  'INTENT_AMBIGUOUS',
    };
  }

  // ── Special: report intent — reuse last known domain from context ─────────
  let effectiveIntent = intent;
  if (intent === 'report') {
    effectiveIntent = contextState?.lastIntent || 'emission_summary';
  }

  // ── Look up domain in module registry ────────────────────────────────────
  const moduleInfo = getModuleInfo(effectiveIntent);
  if (!moduleInfo) {
    return { error: 'Unknown data domain.', code: 'UNKNOWN_DOMAIN' };
  }

  // ── Validate domain access (Gates 7 + 8) ─────────────────────────────────
  const access = validateDomainAccess(accessContext, moduleInfo);
  if (!access.allowed) {
    return { error: access.reason, code: 'PERMISSION_DENIED' };
  }

  // ── Resolve allowed sections (Gate 9) ─────────────────────────────────────
  const allowedSections = resolveAllowedSections(
    accessContext.userType,
    effectiveIntent,
    moduleInfo.sections
  );

  if (!allowedSections) {
    return {
      error: `Your role does not have access to the '${effectiveIntent}' domain.`,
      code:  'SECTION_DENIED',
    };
  }

  // ── Resolve date range ────────────────────────────────────────────────────
  let dateRange = null;
  const detectedExpr = detectDateExpression(question);
  if (detectedExpr) {
    dateRange = resolveDateRange(detectedExpr);
  } else if (contextState?.lastDateRange?.startDate) {
    // Fall back to session's last resolved date range
    dateRange = { ...contextState.lastDateRange, label: `${contextState.lastDateRange.label} (from context)` };
  }
  // No date in question and no session context → leave null so the
  // retriever falls back to the most recent available records.

  // ── Determine output mode ──────────────────────────────────────────────────
  let outputMode = 'plain';
  if (intent === 'report') {
    outputMode = 'report';
  } else if (moduleInfo.supportsCharts && /\b(chart|graph|visual|plot)\b/i.test(question)) {
    outputMode = 'chart';
  } else if (moduleInfo.supportsTables && /\b(table|breakdown|list|all|show me)\b/i.test(question)) {
    outputMode = 'table';
  } else if (moduleInfo.crossModule) {
    outputMode = 'cross_module';
  }

  // ── Build filters (Gate 10 — scope restrictions for restricted roles) ──────
  const filters = {};
  const { nodeRestrictions } = accessContext;

  if (nodeRestrictions) {
    if (nodeRestrictions.nodeIds.length > 0)
      filters.nodeIds = nodeRestrictions.nodeIds;
    if (nodeRestrictions.scopeIdentifiers.length > 0)
      filters.scopeIdentifiers = nodeRestrictions.scopeIdentifiers;
    if (nodeRestrictions.processNodeIds.length > 0)
      filters.processNodeIds = nodeRestrictions.processNodeIds;
    if (nodeRestrictions.reductionProjectIds.length > 0)
      filters.reductionProjectIds = nodeRestrictions.reductionProjectIds;
  }

  return {
    plan: {
      intent:       effectiveIntent,
      originalIntent: intent,
      clientId:     accessContext.clientId,
      product:      moduleInfo.product,
      domain:       effectiveIntent,
      sections:     allowedSections,
      retriever:    moduleInfo.retriever,
      dateRange,
      filters,
      outputMode,
      maxRecords:   MAX_CONTEXT_RECORDS,
      permissionsApplied: {
        userType:         accessContext.userType,
        nodeRestrictions: nodeRestrictions || null,
        isScopeRestricted: accessContext.isScopeRestricted,
      },
      supportsCharts:  moduleInfo.supportsCharts,
      supportsTables:  moduleInfo.supportsTables,
      supportsReports: moduleInfo.supportsReports,
    },
  };
}

module.exports = { buildQueryPlan, MAX_CONTEXT_RECORDS };
