'use strict';

// ============================================================================
// esgRetriever.js — Retrieves ESGLink data for GreOn IQ
//
// ESG data is scoped to what the user is assigned to via EsgMetricNodeMapping.
// contributor/reviewer/approver roles are scoped to their specific mappings.
// client_admin and above see all ESG data for the client.
//
// Sources:
//   - EsgDataEntry          → submitted metric values
//   - EsgBoundarySummary    → pre-computed boundary rollups
//   - EsgMetricNodeMapping  → mapping configuration
//   - EsgLinkBoundary       → active boundary document
//   - EsgMetric             → metric library metadata
// ============================================================================

const EsgDataEntry        = require('../../../modules/esg-link/esgLink_core/data-collection/models/EsgDataEntry');
const EsgBoundarySummary  = require('../../../modules/esg-link/esgLink_core/summary/models/EsgBoundarySummary');
const EsgMetricNodeMapping= require('../../../modules/esg-link/esgLink_core/boundary/models/EsgMetricNodeMapping');
const EsgLinkBoundary     = require('../../../modules/esg-link/esgLink_core/boundary/models/EsgLinkBoundary');
const EsgMetric           = require('../../../modules/esg-link/esgLink_core/metric/models/EsgMetric');
const { safeFindMany, safeFindOne } = require('../utils/decryptSafeReader');
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

  // ── User assignment scope (contributor/reviewer/approver) ─────────────────
  // nodeRestrictions.esgMappingIds is populated for restricted ESG roles
  const esgMappingIds  = accessContext.nodeRestrictions?.esgMappingIds  || null;
  const esgBoundaryIds = accessContext.nodeRestrictions?.esgBoundaryIds || null;

  const results = {};

  // ── Active boundary document ───────────────────────────────────────────────
  if (sections.includes('esg_boundary') || sections.includes('overview')) {
    const boundaryFilter = { clientId, isActive: true, isDeleted: { $ne: true } };
    const boundary = await safeFindOne(
      EsgLinkBoundary,
      boundaryFilter,
      { version: 1, setupMethod: 1, 'nodes._id': 1, 'nodes.nodeType': 1, 'nodes.label': 1, createdAt: 1 }
    );
    if (!boundary) exclusions.push(explainNoData('esg_boundary', dateRange));
    results.activeBoundary = boundary;
  }

  // ── Boundary summary (pre-computed rollups) ───────────────────────────────
  if (sections.includes('esg_summary') || sections.includes('overview')) {
    const summaryFilter = {
      clientId,
      ...(esgBoundaryIds?.length ? { boundaryDocId: { $in: esgBoundaryIds } } : {}),
    };
    if (dateRange?.startDate?.getFullYear?.()) {
      summaryFilter.periodYear = { $gte: dateRange.startDate.getFullYear() };
    }
    if (dateRange?.endDate?.getFullYear?.()) {
      summaryFilter.periodYear = {
        ...summaryFilter.periodYear,
        $lte: dateRange.endDate.getFullYear(),
      };
    }

    const { docs: summaries, totalFound: sTotal, wasTruncated: sTrunc } = await safeFindMany(
      EsgBoundarySummary,
      summaryFilter,
      { boundaryDocId: 1, periodYear: 1, totalEntries: 1, lastComputedAt: 1, approvedSummary: 1 },
      { sort: { periodYear: -1 } },
      maxRecords
    );

    if (sTrunc) exclusions.push(explainTruncation(sTotal, summaries.length));
    if (summaries.length === 0) exclusions.push(explainNoData('esg_summary', dateRange));
    results.boundarySummaries = { records: summaries, totalCount: sTotal };
  }

  // ── Metric node mappings ──────────────────────────────────────────────────
  if (sections.includes('esg_metrics') || sections.includes('mappings')) {
    const mappingFilter = {
      clientId,
      isDeleted: { $ne: true },
      ...(esgMappingIds?.length ? { _id: { $in: esgMappingIds } } : {}),
    };

    const { docs: mappings, totalFound: mTotal, wasTruncated: mTrunc } = await safeFindMany(
      EsgMetricNodeMapping,
      mappingFilter,
      {
        metricId: 1, boundaryNodeId: 1, boundaryDocId: 1, mappingStatus: 1,
        frequency: 1, boundaryScope: 1, approvalLevel: 1,
        contributors: 1, reviewers: 1, approvers: 1,
      },
      { sort: { createdAt: -1 } },
      maxRecords
    );

    if (mTrunc) exclusions.push(explainTruncation(mTotal, mappings.length));
    results.metricMappings = { records: mappings, totalCount: mTotal };
  }

  // ── ESG data entries ──────────────────────────────────────────────────────
  if (sections.includes('esg_data_entry') || sections.includes('entries')) {
    const entryFilter = {
      clientId,
      isDeleted: { $ne: true },
      ...dateFilter,
    };
    if (esgMappingIds?.length) entryFilter.mappingId = { $in: esgMappingIds.map(String) };
    if (filters.nodeIds?.length) entryFilter.nodeId  = { $in: filters.nodeIds };

    const { docs: entries, totalFound: eTotal, wasTruncated: eTrunc } = await safeFindMany(
      EsgDataEntry,
      entryFilter,
      {
        nodeId: 1, mappingId: 1, metricId: 1,
        'period.year': 1, 'period.periodLabel': 1,
        workflowStatus: 1, calculatedValue: 1, unitOfMeasurement: 1,
        submittedAt: 1, createdAt: 1,
      },
      { sort: { submittedAt: -1 } },
      maxRecords
    );

    if (eTrunc) exclusions.push(explainTruncation(eTotal, entries.length));
    if (entries.length === 0) exclusions.push(explainNoData('esg_data_entry', dateRange));

    results.dataEntries = {
      records:    sections.includes('esg_data_entry') ? entries : [],
      totalCount: eTotal,
      stats:      sections.includes('stats') ? _computeEntryStats(entries) : null,
    };
  }

  return {
    data:        results,
    exclusions,
    recordCount:
      (results.boundarySummaries?.totalCount  || 0) +
      (results.metricMappings?.totalCount     || 0) +
      (results.dataEntries?.totalCount        || 0),
  };
}

function _computeEntryStats(docs) {
  const byStatus = {};
  const byNode   = {};
  for (const d of docs) {
    byStatus[d.workflowStatus || 'unknown'] = (byStatus[d.workflowStatus || 'unknown'] || 0) + 1;
    if (d.nodeId) byNode[d.nodeId] = (byNode[d.nodeId] || 0) + 1;
  }
  return { byStatus, byNode, total: docs.length };
}

module.exports = { retrieve };
