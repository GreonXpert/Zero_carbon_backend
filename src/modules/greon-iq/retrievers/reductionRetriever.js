'use strict';

// ============================================================================
// reductionRetriever.js — Retrieves reduction data from EmissionSummary.reductionSummary
//
// Source: EmissionSummary.reductionSummary (pre-computed by reductionSummaryCalculationService)
// This contains rich KPIs, per-project breakdowns, methodology summaries,
// trend charts, category/scope/location splits, and top-sources analytics.
//
// The old approach of querying raw Reduction + NetReductionEntry models gave
// empty/incomplete data because those records hold project metadata only,
// not the aggregated net-reduction calculations.
// ============================================================================

const EmissionSummary = require('../../../modules/zero-carbon/calculation/EmissionSummary');
const { safeFindMany }  = require('../utils/decryptSafeReader');
const { explainNoData, explainScopeRestrictions, explainTruncation } = require('../utils/exclusionExplainer');

async function retrieve(plan, accessContext) {
  const { clientId, dateRange, maxRecords } = plan;
  const exclusions = [];

  if (accessContext.isScopeRestricted) {
    exclusions.push(...explainScopeRestrictions(accessContext.nodeRestrictions));
  }

  // Date filter aligned with EmissionSummary period fields
  const dateFilter = {};
  if (dateRange?.startDate) dateFilter['period.from'] = { $gte: dateRange.startDate };
  if (dateRange?.endDate)   dateFilter['period.to']   = { $lte: dateRange.endDate };

  const filter = {
    clientId,
    isDeleted: { $ne: true },
    ...dateFilter,
  };

  // reductionSummary is an encrypted blob — project the whole field so the
  // Mongoose encryption plugin can decrypt it in the post-find hook.
  const { docs, totalFound, wasTruncated } = await safeFindMany(
    EmissionSummary,
    filter,
    { clientId: 1, period: 1, reductionSummary: 1 },
    { sort: { 'period.from': -1, 'period.startDate': -1 } },
    maxRecords
  );

  if (wasTruncated) exclusions.push(explainTruncation(totalFound, docs.length));

  // Prefer the most recent document that has actual reduction entries
  const best =
    docs.find((d) => (d.reductionSummary?.entriesCount > 0) || (d.reductionSummary?.byProject?.length > 0))
    || docs[0]
    || null;

  if (!best || !best.reductionSummary) {
    exclusions.push(explainNoData('reduction', dateRange));
    return { data: {}, exclusions, recordCount: 0 };
  }

  const rs = best.reductionSummary;

  // Build the structured result — sanitize any encrypted sub-strings that
  // reductionSummaryCalculationService may have stored before encryption ran.
  const byProject = rs.byProject || [];

  const reductionSummary = {
    // ── Core KPIs ──────────────────────────────────────────────────────────
    totalNetReduction:             rs.totalNetReduction ?? 0,
    entriesCount:                  rs.entriesCount ?? 0,
    totalTargetEmissionReduction:  rs.calculationSummary?.totalTargetEmissionReduction ?? 0,
    achievementPercentage:         rs.calculationSummary?.achievementPercentage ?? 0,
    dataCompletenessPercentage:    rs.calculationSummary?.dataCompletenessPercentage ?? 0,

    // ── Per-project breakdown ──────────────────────────────────────────────
    byProject,

    // ── Breakdowns ────────────────────────────────────────────────────────
    byCategory:         _mapToObj(rs.byCategory),
    byScope:            _mapToObj(rs.byScope),
    byLocation:         _mapToObj(rs.byLocation),
    byProjectActivity:  _mapToObj(rs.byProjectActivity),
    byMethodology:      _mapToObj(rs.byMethodology),

    // ── Methodology summaries ─────────────────────────────────────────────
    m1Summary: rs.m1Summary || {},
    m2Summary: rs.m2Summary || {},
    m3Summary: rs.m3Summary || {},

    // ── Rich analytics (from calculationSummary) ──────────────────────────
    trendChart:               _sanitizeTrendChart(rs.calculationSummary?.trendChart, byProject),
    ghgMechanismSplit:        rs.calculationSummary?.ghgMechanismSplit        || {},
    topSources:               rs.calculationSummary?.topSources               || [],
    processProductAnalysis:   rs.calculationSummary?.processProductAnalysis   || [],
    periodComparison:         rs.calculationSummary?.periodComparison         || [],
    dataCompletenessByProject: rs.calculationSummary?.dataCompletenessByProject || [],
    categoryPriorities:       _sanitizeCategoryPriorities(
                                rs.calculationSummary?.categoryPriorities,
                                _mapToObj(rs.byCategory)
                              ),
    meta:   rs.calculationSummary?.meta || null,
    period: best.period,
  };

  // recordCount drives the "no data" guard in responseComposerService
  const recordCount = (rs.entriesCount || 0) + byProject.length || 1;

  return {
    data:        { reductionSummary },
    exclusions,
    recordCount,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _mapToObj(val) {
  if (!val) return {};
  if (val instanceof Map) return Object.fromEntries(val);
  return val;
}

// trendChart.*.projectName may contain encrypted strings ("v1:...").
// Replace them with names looked up from byProject.
function _sanitizeTrendChart(trendChart, byProject) {
  if (!trendChart) return { monthly: [], quarterly: [], yearly: [] };
  const nameById = {};
  for (const p of byProject) {
    if (p.projectId) nameById[p.projectId] = p.projectName;
  }
  const fix = (arr) => (arr || []).map((item) => ({
    ...item,
    projectName: nameById[item.projectId]
      || (String(item.projectName || '').startsWith('v1:') ? item.projectId || '—' : item.projectName),
  }));
  return {
    monthly:   fix(trendChart.monthly),
    quarterly: fix(trendChart.quarterly),
    yearly:    fix(trendChart.yearly),
  };
}

// categoryPriorities.category may be encrypted — fall back to byCategory keys.
function _sanitizeCategoryPriorities(priorities, byCategory) {
  if (!priorities?.length) return [];
  const validCategories = new Set(Object.keys(byCategory));
  return priorities.map((p) => ({
    ...p,
    category: validCategories.has(p.category)
      ? p.category
      : (String(p.category || '').startsWith('v1:') ? '—' : p.category),
  }));
}

module.exports = { retrieve };
