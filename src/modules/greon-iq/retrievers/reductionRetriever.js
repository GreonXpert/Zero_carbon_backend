'use strict';

// ============================================================================
// reductionRetriever.js — Retrieves Reduction and NetReductionEntry data
//
// Scopes to projects the user is allowed to see.
// Returns project summaries, net reduction entries, and stats.
// ============================================================================

const Reduction         = require('../../../modules/zero-carbon/reduction/models/Reduction');
const NetReductionEntry = require('../../../modules/zero-carbon/reduction/models/NetReductionEntry');
const { safeFindMany }  = require('../utils/decryptSafeReader');
const { explainNoData, explainScopeRestrictions, explainTruncation } = require('../utils/exclusionExplainer');

async function retrieve(plan, accessContext) {
  const { clientId, dateRange, sections, filters, maxRecords } = plan;
  const exclusions = [];

  if (accessContext.isScopeRestricted) {
    exclusions.push(...explainScopeRestrictions(accessContext.nodeRestrictions));
  }

  // ── Date filter ───────────────────────────────────────────────────────────
  const dateFilter = {};
  if (dateRange?.startDate) dateFilter.createdAt = { $gte: dateRange.startDate };
  if (dateRange?.endDate)   dateFilter.createdAt = { ...dateFilter.createdAt, $lte: dateRange.endDate };

  // ── Project scope filter ──────────────────────────────────────────────────
  const projectFilter = {};
  if (filters.reductionProjectIds?.length) {
    projectFilter._id = { $in: filters.reductionProjectIds };
  }

  const results = {};

  // ── Reduction projects ────────────────────────────────────────────────────
  if (sections.includes('list') || sections.includes('stats') || sections.includes('overview')) {
    const reductionFilter = {
      clientId,
      isDeleted: { $ne: true },
      ...dateFilter,
      ...projectFilter,
    };

    const { docs, totalFound, wasTruncated } = await safeFindMany(
      Reduction,
      reductionFilter,
      { name: 1, status: 1, targetReduction: 1, actualReduction: 1, unit: 1, startDate: 1, endDate: 1, createdAt: 1 },
      { sort: { createdAt: -1 } },
      maxRecords
    );

    if (wasTruncated) exclusions.push(explainTruncation(totalFound, docs.length));
    if (docs.length === 0) exclusions.push(explainNoData('reduction', dateRange));

    results.reductionProjects = {
      records:    sections.includes('list') ? docs : [],
      totalCount: totalFound,
      stats:      sections.includes('stats') ? _computeProjectStats(docs) : null,
    };
  }

  // ── Net reduction entries ─────────────────────────────────────────────────
  if (sections.includes('entries') || sections.includes('netEntries')) {
    const netFilter = {
      clientId,
      isDeleted: { $ne: true },
      ...dateFilter,
    };
    if (filters.reductionProjectIds?.length) {
      netFilter.reductionId = { $in: filters.reductionProjectIds };
    }

    const { docs: netDocs, totalFound: netTotal, wasTruncated: netTrunc } = await safeFindMany(
      NetReductionEntry,
      netFilter,
      { reductionId: 1, period: 1, amount: 1, unit: 1, status: 1, createdAt: 1 },
      { sort: { createdAt: -1 } },
      maxRecords
    );

    if (netTrunc) exclusions.push(explainTruncation(netTotal, netDocs.length));
    results.netReductionEntries = { records: netDocs, totalCount: netTotal };
  }

  return {
    data:        results,
    exclusions,
    recordCount: (results.reductionProjects?.totalCount || 0) + (results.netReductionEntries?.totalCount || 0),
  };
}

function _computeProjectStats(docs) {
  const byStatus = {};
  let totalTarget = 0;
  let totalActual = 0;

  for (const d of docs) {
    byStatus[d.status || 'unknown'] = (byStatus[d.status || 'unknown'] || 0) + 1;
    if (typeof d.targetReduction === 'number') totalTarget += d.targetReduction;
    if (typeof d.actualReduction === 'number') totalActual += d.actualReduction;
  }

  return {
    byStatus,
    totalTargetReduction: totalTarget,
    totalActualReduction: totalActual,
    progressPercent: totalTarget > 0 ? Math.round((totalActual / totalTarget) * 100) : null,
    total: docs.length,
  };
}

module.exports = { retrieve };
