'use strict';

// ============================================================================
// dataEntryRetriever.js — Retrieves DataEntry and ProcessEmissionDataEntry data
//
// Applies node/scope restrictions for employee-level roles.
// Returns counts, stats, and safe record summaries (not full raw entries).
// ============================================================================

const DataEntry              = require('../../../modules/zero-carbon/organization/models/DataEntry');
const ProcessEmissionDataEntry = require('../../../modules/zero-carbon/organization/models/ProcessEmissionDataEntry');
const { safeFindMany, safeCount } = require('../utils/decryptSafeReader');
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

  // ── Scope filter ──────────────────────────────────────────────────────────
  const nodeFilter = {};
  if (filters.nodeIds?.length)          nodeFilter.nodeId          = { $in: filters.nodeIds };
  if (filters.scopeIdentifiers?.length) nodeFilter.scopeIdentifier = { $in: filters.scopeIdentifiers };

  const dataEntryFilter = {
    clientId,
    isDeleted: { $ne: true },
    ...dateFilter,
    ...nodeFilter,
  };

  const results = {};

  // ── DataEntry records ─────────────────────────────────────────────────────
  if (sections.includes('list') || sections.includes('stats')) {
    const { docs, totalFound, wasTruncated } = await safeFindMany(
      DataEntry,
      dataEntryFilter,
      { nodeId: 1, scopeIdentifier: 1, inputType: 1, status: 1, createdAt: 1 },
      { sort: { createdAt: -1 } },
      maxRecords
    );

    if (wasTruncated) exclusions.push(explainTruncation(totalFound, docs.length));
    if (docs.length === 0) exclusions.push(explainNoData('data_entry', dateRange));

    results.dataEntries = {
      records:    sections.includes('list') ? docs : [],
      totalCount: totalFound,
      stats:      sections.includes('stats') ? _computeStats(docs) : null,
    };
  }

  // ── ProcessEmissionDataEntry records ──────────────────────────────────────
  if (sections.includes('entries') || sections.includes('processEmissionEntries')) {
    const processFilter = { clientId, isDeleted: { $ne: true }, ...dateFilter };
    if (filters.processNodeIds?.length) processFilter.processNodeId = { $in: filters.processNodeIds };

    const { docs: processDocs, totalFound: pTotal, wasTruncated: pTrunc } = await safeFindMany(
      ProcessEmissionDataEntry,
      processFilter,
      { processNodeId: 1, status: 1, createdAt: 1 },
      { sort: { createdAt: -1 } },
      maxRecords
    );

    if (pTrunc) exclusions.push(explainTruncation(pTotal, processDocs.length));
    results.processEmissionEntries = { records: processDocs, totalCount: pTotal };
  }

  return {
    data:        results,
    exclusions,
    recordCount: (results.dataEntries?.totalCount || 0) + (results.processEmissionEntries?.totalCount || 0),
  };
}

function _computeStats(docs) {
  const byInputType = {};
  const byStatus    = {};
  for (const d of docs) {
    byInputType[d.inputType || 'unknown'] = (byInputType[d.inputType || 'unknown'] || 0) + 1;
    byStatus[d.status || 'unknown']       = (byStatus[d.status || 'unknown'] || 0) + 1;
  }
  return { byInputType, byStatus, total: docs.length };
}

module.exports = { retrieve };
