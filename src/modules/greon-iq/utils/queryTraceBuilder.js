'use strict';

// ============================================================================
// queryTraceBuilder.js — Builds the safe trace object returned in every response
//
// The trace is included in API responses for transparency and debugging.
// It must NOT contain any sensitive values (no keys, no encrypted data,
// no raw filter values that expose internal IDs to unauthorized contexts).
// ============================================================================

/**
 * Build the trace object from a resolved query plan.
 * @param {object} plan  — from queryPlannerService.buildQueryPlan()
 * @returns {object}
 */
function buildTrace(plan) {
  if (!plan) return null;

  return {
    clientId:     plan.clientId,
    intent:       plan.intent,
    product:      plan.product,
    modulesUsed:  plan.domain ? [plan.domain] : [],
    dateRange:    plan.dateRange
      ? {
          label:     plan.dateRange.label,
          startDate: plan.dateRange.startDate?.toISOString?.() || null,
          endDate:   plan.dateRange.endDate?.toISOString?.()   || null,
        }
      : null,
    outputMode:   plan.outputMode,
    sectionsUsed: plan.sections || [],
    // Scope restrictions are noted by type, not raw IDs (to avoid exposing internal IDs)
    scopeFiltered: plan.permissionsApplied?.isScopeRestricted || false,
  };
}

/**
 * Build a minimal audit-safe plan snapshot for ChatAuditLog.
 * Strips node IDs and scope identifiers from the plan before storing.
 * @param {object} plan
 * @returns {object}
 */
function buildAuditPlanSnapshot(plan) {
  if (!plan) return null;
  return {
    intent:       plan.intent,
    product:      plan.product,
    domain:       plan.domain,
    outputMode:   plan.outputMode,
    dateRange:    plan.dateRange
      ? { label: plan.dateRange.label }
      : null,
    retriever:    plan.retriever,
    // Do NOT include raw filter IDs in audit snapshot
    filtersApplied: {
      hasNodeFilter:    !!(plan.filters?.nodeIds?.length),
      hasScopeFilter:   !!(plan.filters?.scopeIdentifiers?.length),
      hasProjectFilter: !!(plan.filters?.reductionProjectIds?.length),
    },
  };
}

module.exports = { buildTrace, buildAuditPlanSnapshot };
