'use strict';

// ============================================================================
// emissionSummaryRetriever.js — Retrieves emission summary data for GreOn IQ
//
// Primary source: EmissionSummary model (pre-computed by CalculationSummary.js)
// Fallback: DataEntry counts if no summary exists for the period
//
// All queries filter by clientId + dateRange + allowed sections.
// Scope restrictions from accessContext are applied for restricted roles.
// ============================================================================

const EmissionSummary = require('../../../modules/zero-carbon/calculation/EmissionSummary');
const { safeFindMany, safeFindOne } = require('../utils/decryptSafeReader');
const { explainNoData, explainScopeRestrictions, explainTruncation } = require('../utils/exclusionExplainer');

/**
 * Retrieve emission summary data for a query plan.
 *
 * @param {object} plan        — from queryPlannerService
 * @param {object} accessContext
 * @returns {Promise<{ data: object, exclusions: string[], recordCount: number }>}
 */
async function retrieve(plan, accessContext) {
  const { clientId, dateRange, sections, filters, maxRecords } = plan;
  const exclusions = [];

  // ── Scope restriction exclusions ──────────────────────────────────────────
  if (accessContext.isScopeRestricted) {
    exclusions.push(...explainScopeRestrictions(accessContext.nodeRestrictions));
  }

  // ── Build date filter ─────────────────────────────────────────────────────
  const dateFilter = {};
  if (dateRange?.startDate) dateFilter['period.startDate'] = { $gte: dateRange.startDate };
  if (dateRange?.endDate)   dateFilter['period.endDate']   = { $lte: dateRange.endDate };

  // Try to find a matching summary document
  const summaryFilter = {
    clientId,
    isDeleted: { $ne: true },
    ...dateFilter,
  };

  // Build an inclusion-only projection (MongoDB forbids mixing 1 and 0)
  const projection = { clientId: 1, period: 1 };
  if (sections.includes('overview') || sections.includes('byScope') ||
      sections.includes('byCategory') || sections.includes('trends') ||
      sections.includes('metadata') || sections.includes('key_metrics') ||
      sections.includes('scope_analysis') || sections.includes('trend_analysis') ||
      sections.includes('executive_summary')) {
    projection.emissionSummary = 1;
    // Backward compat: old documents store these at root level before the
    // emissionSummary nesting was introduced. Include them so lean() returns them.
    projection.totalEmissions = 1;
    projection.byScope        = 1;
    projection.byCategory     = 1;
    projection.trends         = 1;
  }
  if (sections.includes('byNode')) {
    projection['reductionSummary.calculationSummary'] = 1;
  }

  const { docs: summaries, totalFound, wasTruncated } = await safeFindMany(
    EmissionSummary,
    summaryFilter,
    projection,
    { sort: { 'period.from': -1, 'period.startDate': -1 } },
    maxRecords
  );

  if (wasTruncated) {
    exclusions.push(explainTruncation(totalFound, summaries.length));
  }

  if (summaries.length === 0) {
    exclusions.push(explainNoData('emission_summary', dateRange));
  }

  // ── Section-level filtering ───────────────────────────────────────────────
  // For restricted roles, strip sections they cannot see.
  // Backward compat: prefer new nested emissionSummary.* fields; fall back to
  // root-level fields for documents created before the nesting was introduced.
  const filteredSummaries = summaries.map((s) => {
    const out = { period: s.period, clientId: s.clientId };
    if (s.emissionSummary || s.totalEmissions) {
      out.totalEmissions = s.emissionSummary?.totalEmissions ?? s.totalEmissions ?? null;
      out.metadata       = s.emissionSummary?.metadata       ?? null;
    }
    if (sections.includes('byScope')) {
      const byScope = s.emissionSummary?.byScope ?? s.byScope;
      if (byScope) out.byScope = byScope;
    }
    if (sections.includes('byCategory')) {
      const byCategory = s.emissionSummary?.byCategory ?? s.byCategory;
      if (byCategory) out.byCategory = byCategory;
    }
    if (sections.includes('byNode') && s.emissionSummary?.byNode) {
      // For scope-restricted roles, filter to allowed node IDs
      const nodeIds = accessContext.nodeRestrictions?.nodeIds;
      out.byNode = nodeIds?.length
        ? s.emissionSummary.byNode?.filter(
            (n) => nodeIds.includes(String(n.nodeId || n._id))
          )
        : s.emissionSummary.byNode;
    }
    if (sections.includes('trends')) {
      const trends = s.emissionSummary?.trends ?? s.trends;
      if (trends) out.trends = trends;
    }
    return out;
  });

  return {
    data:        { summaries: filteredSummaries },
    exclusions,
    recordCount: filteredSummaries.length,
  };
}

module.exports = { retrieve };
