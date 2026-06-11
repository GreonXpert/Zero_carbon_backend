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
//
// PERMISSION DENIALS inside this function are returned as restrictionMessage
// (not error) so the controller can surface them as in-chat messages
// (HTTP 200 restricted:true) rather than HTTP 4xx responses.
// ============================================================================

const { getModuleInfo }           = require('../registry/moduleRegistry');
const { resolveAllowedSections }  = require('../registry/sectionRegistry');
const { validateDomainAccess }    = require('./accessContextService');
const { detectDateExpression,
        resolveDateRange }        = require('./dateRangePlanner');

const MAX_CONTEXT_RECORDS = 50;

// Assessment level hierarchy — a client at level X may also access lower levels
const ASSESSMENT_HIERARCHY = ['organization', 'process', 'reduction', 'decarbonization', 'net_zero'];

/**
 * Check whether the client's assessment level covers the domain's requirement.
 *
 * @param {object} accessContext
 * @param {object} moduleInfo
 * @returns {{ allowed: boolean, reason?: string }}
 */
function validateAssessmentLevel(accessContext, moduleInfo) {
  const required = moduleInfo.requiredAssessmentLevel;
  if (!required) return { allowed: true }; // ESGLink domains — no level gate

  // Unrestricted roles (super_admin, consultant_admin, consultant, client_admin)
  // can see all data regardless of the client's subscription level.
  if (accessContext.isUnrestricted) return { allowed: true };

  const clientLevel = accessContext.clientAssessmentLevel;
  if (!clientLevel) {
    return {
      allowed: false,
      reason:  `This client has not completed an assessment. The '${required}' assessment level is required to answer questions about ${moduleInfo.accessModule || required} data.`,
    };
  }

  const clientIdx   = ASSESSMENT_HIERARCHY.indexOf(clientLevel);
  const requiredIdx = ASSESSMENT_HIERARCHY.indexOf(required);

  if (clientIdx === -1 || requiredIdx === -1) {
    // Unknown level strings — fail open for unrestricted, fail closed otherwise
    return { allowed: true };
  }

  if (clientIdx < requiredIdx) {
    const clientLabel   = clientLevel.charAt(0).toUpperCase() + clientLevel.slice(1);
    const requiredLabel = required.charAt(0).toUpperCase() + required.slice(1);
    return {
      allowed: false,
      reason:  `This client's subscription covers up to the **${clientLabel}** assessment level. ` +
               `Questions about ${moduleInfo.accessModule || required} data require the **${requiredLabel}** level. ` +
               `Please contact your administrator to upgrade the subscription.`,
    };
  }

  return { allowed: true };
}

/**
 * Build a query plan from intent classification + access context.
 *
 * @param {object} params
 * @param {string} params.intent          — from intentRouterService
 * @param {string} params.question        — original user question
 * @param {object} params.accessContext   — from accessContextService
 * @param {object|null} params.contextState — session context (for follow-ups)
 * @returns {{ plan: object }|{ restrictionMessage: string, restrictionCode: string }|{ error: string, code: string }}
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

  // ── Handle ambiguous — return as in-chat restriction (not HTTP 400) ────────
  if (intent === 'ambiguous') {
    return {
      restrictionMessage:
        'I could not determine which data domain your question refers to. ' +
        'Could you please clarify — for example, are you asking about emission summaries, ' +
        'reduction projects, ESG data entries, or something else?',
      restrictionCode: 'INTENT_AMBIGUOUS',
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
    return {
      restrictionMessage: 'Unknown data domain. Please rephrase your question.',
      restrictionCode:    'UNKNOWN_DOMAIN',
    };
  }

  // ── Validate domain access (Gates 7 + 8) — in-chat restriction ───────────
  const access = validateDomainAccess(accessContext, moduleInfo);
  if (!access.allowed) {
    return {
      restrictionMessage: access.reason,
      restrictionCode:    'PERMISSION_DENIED',
      attemptedDomain:    effectiveIntent,
    };
  }

  // ── Validate assessment level (Gate 9a) — in-chat restriction ────────────
  const levelCheck = validateAssessmentLevel(accessContext, moduleInfo);
  if (!levelCheck.allowed) {
    return {
      restrictionMessage: levelCheck.reason,
      restrictionCode:    'ASSESSMENT_LEVEL_INSUFFICIENT',
      attemptedDomain:    effectiveIntent,
    };
  }

  // ── Resolve allowed sections (Gate 9) ─────────────────────────────────────
  const allowedSections = resolveAllowedSections(
    accessContext.userType,
    effectiveIntent,
    moduleInfo.sections
  );

  if (!allowedSections) {
    return {
      restrictionMessage: `Your role does not have access to the '${effectiveIntent}' domain.`,
      restrictionCode:    'SECTION_DENIED',
      attemptedDomain:    effectiveIntent,
    };
  }

  // ── Resolve date range ────────────────────────────────────────────────────
  let dateRange = null;
  const detectedExpr = detectDateExpression(question);
  if (detectedExpr) {
    dateRange = resolveDateRange(detectedExpr);
  } else if (contextState?.lastDateRange?.startDate) {
    dateRange = { ...contextState.lastDateRange, label: `${contextState.lastDateRange.label} (from context)` };
  }

  // ── Determine output mode ──────────────────────────────────────────────────
  // Detect explicit "no chart / text only" requests BEFORE checking for "graph"
  // keyword — "not in graph" contains "graph" but the intent is text-only.
  const _noChartRequest = /\b(not?\s+in\s+(graph|chart)s?|no\s+(graph|chart)s?|without\s+(graph|chart)s?|text[- ]only|(in\s+)?text\s+(not|only)|don'?t\s+(show|use|give|want)\s+(graph|chart)s?)\b/i.test(question);

  let outputMode = 'plain';
  let suppressCharts = _noChartRequest; // user explicitly said no chart
  if (intent === 'report') {
    outputMode = 'report';
  } else if (!_noChartRequest && moduleInfo.supportsCharts && /\b(chart|graph|visual|plot)\b/i.test(question)) {
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
      suppressCharts,
      maxRecords:   MAX_CONTEXT_RECORDS,
      permissionsApplied: {
        userType:          accessContext.userType,
        nodeRestrictions:  nodeRestrictions || null,
        isScopeRestricted: accessContext.isScopeRestricted,
      },
      supportsCharts:  moduleInfo.supportsCharts,
      supportsTables:  moduleInfo.supportsTables,
      supportsReports: moduleInfo.supportsReports,
    },
  };
}

module.exports = { buildQueryPlan, MAX_CONTEXT_RECORDS };
