'use strict';

// ============================================================================
// sbtiRetriever.js — Retrieves SBTi target records for GreOn IQ
//
// SBTi targets are org-level commitments — no node/scope restriction applies.
// All roles with decarbonization access see the same target records.
// ============================================================================

const SbtiTarget       = require('../../../modules/zero-carbon/decarbonization/SbtiTarget');
const { safeFindMany } = require('../utils/decryptSafeReader');
const { explainNoData, explainTruncation } = require('../utils/exclusionExplainer');

async function retrieve(plan, accessContext) {
  const { clientId, dateRange, sections, maxRecords } = plan;
  const exclusions = [];

  // ── Date filter (baseline year or target year range) ──────────────────────
  const dateFilter = {};
  if (dateRange?.startDate) dateFilter.createdAt = { $gte: dateRange.startDate };
  if (dateRange?.endDate)   dateFilter.createdAt = { ...dateFilter.createdAt, $lte: dateRange.endDate };

  const sbtiFilter = {
    clientId,
    isDeleted: { $ne: true },
    ...dateFilter,
  };

  const { docs, totalFound, wasTruncated } = await safeFindMany(
    SbtiTarget,
    sbtiFilter,
    {
      targetType:      1,
      baselineYear:    1,
      targetYear:      1,
      reductionTarget: 1,
      scope:           1,
      status:          1,
      validationStatus:1,
      createdAt:       1,
    },
    { sort: { createdAt: -1 } },
    maxRecords
  );

  if (wasTruncated) exclusions.push(explainTruncation(totalFound, docs.length));
  if (docs.length === 0) exclusions.push(explainNoData('sbti_target', dateRange));

  const stats = sections.includes('stats') ? _computeSbtiStats(docs) : null;

  return {
    data: {
      sbtiTargets: {
        records:    sections.includes('list') ? docs : [],
        totalCount: totalFound,
        stats,
      },
    },
    exclusions,
    recordCount: totalFound,
  };
}

function _computeSbtiStats(docs) {
  const byStatus         = {};
  const byValidation     = {};
  const byScope          = {};

  for (const d of docs) {
    byStatus[d.status || 'unknown']               = (byStatus[d.status || 'unknown'] || 0) + 1;
    byValidation[d.validationStatus || 'unknown'] = (byValidation[d.validationStatus || 'unknown'] || 0) + 1;
    if (Array.isArray(d.scope)) {
      for (const s of d.scope) {
        byScope[s] = (byScope[s] || 0) + 1;
      }
    }
  }

  return { byStatus, byValidation, byScope, total: docs.length };
}

module.exports = { retrieve };
