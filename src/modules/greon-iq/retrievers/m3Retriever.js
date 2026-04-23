'use strict';

// ============================================================================
// m3Retriever.js — Retrieves M3 Net Zero target records for GreOn IQ
// Replaces old sbtiRetriever.js — queries TargetMaster (new M3 schema)
// ============================================================================

const TargetMaster = require('../../zero-carbon/m3/models/TargetMaster');
const PathwayAnnual = require('../../zero-carbon/m3/models/PathwayAnnual');
const ProgressSnapshot = require('../../zero-carbon/m3/models/ProgressSnapshot');
const { safeFindMany } = require('../utils/decryptSafeReader');
const { explainNoData, explainTruncation } = require('../utils/exclusionExplainer');

async function retrieve(plan, accessContext) {
  const { clientId, dateRange, sections, maxRecords } = plan;
  const exclusions = [];

  const dateFilter = {};
  if (dateRange?.startDate) dateFilter.createdAt = { $gte: dateRange.startDate };
  if (dateRange?.endDate)   dateFilter.createdAt = { ...dateFilter.createdAt, $lte: dateRange.endDate };

  const filter = {
    clientId,
    isDeleted: { $ne: true },
    ...dateFilter,
  };

  const { docs: targets, totalFound, wasTruncated } = await safeFindMany(
    TargetMaster,
    filter,
    {
      target_code:        1,
      target_family:      1,
      framework_name:     1,
      method_name:        1,
      base_year:          1,
      target_year:        1,
      target_reduction_pct: 1,
      lifecycle_status:   1,
      approval_status:    1,
      scope_boundary:     1,
      createdAt:          1,
    },
    maxRecords || 10
  );

  if (!targets.length) {
    exclusions.push(explainNoData('M3 Net Zero Targets', 'no active targets found'));
    return { data: [], exclusions };
  }

  if (wasTruncated) {
    exclusions.push(explainTruncation('m3Targets', totalFound, maxRecords || 10));
  }

  // Enrich with pathway and latest progress for each target
  const enriched = await Promise.all(targets.map(async (t) => {
    const pathway = await PathwayAnnual.find({ target_id: t._id })
      .sort({ calendar_year: 1 })
      .limit(20)
      .lean();

    const latestProgress = await ProgressSnapshot.findOne({ target_id: t._id })
      .sort({ snapshot_date: -1 })
      .lean();

    return {
      ...t,
      pathway,
      latestProgress: latestProgress || null,
    };
  }));

  return { data: enriched, exclusions };
}

module.exports = { retrieve };
