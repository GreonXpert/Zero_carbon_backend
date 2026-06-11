'use strict';

// ============================================================================
// m3Retriever.js — Retrieves M3 Net Zero / SBTi target data for GreOn IQ
//
// sections (from moduleRegistry for decarbonization domain):
//   ['sbti', 'targets', 'progress']
//
// Returns targets enriched with annual pathway and latest progress snapshot.
// ============================================================================

const TargetMaster      = require('../../zero-carbon/m3/models/TargetMaster');
const PathwayAnnual     = require('../../zero-carbon/m3/models/PathwayAnnual');
const ProgressSnapshot  = require('../../zero-carbon/m3/models/ProgressSnapshot');
const { safeFindMany }  = require('../utils/decryptSafeReader');
const { explainNoData, explainTruncation } = require('../utils/exclusionExplainer');

async function retrieve(plan, accessContext) {
  const { clientId, dateRange, sections, maxRecords } = plan;
  const exclusions = [];

  const limit = maxRecords || 10;

  const dateFilter = {};
  if (dateRange?.startDate) dateFilter.createdAt = { $gte: dateRange.startDate };
  if (dateRange?.endDate)   dateFilter.createdAt = { ...dateFilter.createdAt, $lte: dateRange.endDate };

  const filter = {
    clientId,
    isDeleted: { $ne: true },
    ...dateFilter,
  };

  // ── Fetch target master records ───────────────────────────────────────────
  const { docs: targets, totalFound, wasTruncated } = await safeFindMany(
    TargetMaster,
    filter,
    {
      target_code:            1,
      target_family:          1,
      framework_name:         1,
      method_name:            1,
      base_year:              1,
      target_year:            1,
      target_reduction_pct:   1,
      lifecycle_status:       1,
      approval_status:        1,
      scope_boundary:         1,
      createdAt:              1,
    },
    { sort: { createdAt: -1 } },
    limit
  );

  if (targets.length === 0) {
    exclusions.push(explainNoData('decarbonization', dateRange));
    return { data: { targets: [], pathway: [], progress: [] }, exclusions, recordCount: 0 };
  }

  if (wasTruncated) {
    exclusions.push(explainTruncation(totalFound, targets.length));
  }

  // ── Enrich with pathway and progress ─────────────────────────────────────
  const enriched = await Promise.all(targets.map(async (t) => {
    const enrichedTarget = { ...t };

    // Annual pathway data (only if 'targets' or 'progress' section requested)
    if (sections.includes('targets') || sections.includes('progress') || sections.includes('sbti')) {
      const pathway = await PathwayAnnual.find({ target_id: t._id })
        .sort({ calendar_year: 1 })
        .limit(20)
        .lean();
      enrichedTarget.pathway = pathway;
    }

    // Latest progress snapshot (only if 'progress' section requested)
    if (sections.includes('progress')) {
      const latestProgress = await ProgressSnapshot.findOne({ target_id: t._id })
        .sort({ snapshot_date: -1 })
        .lean();
      enrichedTarget.latestProgress = latestProgress || null;
    }

    return enrichedTarget;
  }));

  return {
    data:        { targets: enriched },
    exclusions,
    recordCount: totalFound,
  };
}

module.exports = { retrieve };
