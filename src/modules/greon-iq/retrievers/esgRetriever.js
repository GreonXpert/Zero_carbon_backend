'use strict';

// ============================================================================
// esgRetriever.js — Retrieves ESGLink data for GreOn IQ
//
// Routing is based on plan.domain (NOT section names — domain names never
// appear in the sections array; those are sub-section keys like 'overview',
// 'byMetric', 'view', 'nodes', etc.).
//
// Domain → primary data sources:
//   esg_boundary   → EsgLinkBoundary (nodes/edges) + EsgMetricNodeMapping
//   esg_summary    → EsgBoundarySummary + EsgDataEntry (fallback when summary empty)
//   esg_metrics    → EsgMetricNodeMapping + EsgMetric
//   esg_data_entry → EsgDataEntry
//
// NOTE: EsgLinkBoundary has encrypted `nodes` and `edges` fields.
//       Never project sub-fields of an encrypted Mixed field — fetch the whole
//       document and extract what is needed after decryption runs in post-hooks.
// ============================================================================

const EsgDataEntry        = require('../../../modules/esg-link/esgLink_core/data-collection/models/EsgDataEntry');
const EsgBoundarySummary  = require('../../../modules/esg-link/esgLink_core/summary/models/EsgBoundarySummary');
const EsgMetricNodeMapping= require('../../../modules/esg-link/esgLink_core/boundary/models/EsgMetricNodeMapping');
const EsgLinkBoundary     = require('../../../modules/esg-link/esgLink_core/boundary/models/EsgLinkBoundary');
const EsgMetric           = require('../../../modules/esg-link/esgLink_core/metric/models/EsgMetric');
const { safeFindMany, safeCount } = require('../utils/decryptSafeReader');
const { explainNoData, explainScopeRestrictions, explainTruncation } = require('../utils/exclusionExplainer');

// ── Helper: fetch boundary without sub-field projection on encrypted fields ──
async function fetchActiveBoundary(clientId) {
  // Do NOT project sub-fields of `nodes` or `edges` — those are encrypted
  // as a single Mixed blob. Projecting sub-paths on encrypted fields returns
  // empty results. Fetch the full document; decryption runs in post('findOne').
  return EsgLinkBoundary.findOne(
    { clientId, isActive: true, isDeleted: { $ne: true } }
  ).lean();
}

// ── Helper: safe summary of boundary nodes for the AI (no raw coordinates) ──
function summariseBoundaryNodes(boundary) {
  if (!boundary) return null;
  const nodes = Array.isArray(boundary.nodes) ? boundary.nodes : [];
  return {
    version:      boundary.version,
    setupMethod:  boundary.setupMethod,
    totalNodes:   nodes.length,
    nodeTypes:    [...new Set(nodes.map(n => n.type).filter(Boolean))],
    nodes: nodes.map(n => ({
      id:          n.id,
      label:       n.label,
      type:        n.type,
      department:  n.details?.department || null,
      location:    n.details?.location   || n.details?.locationLabel || null,
      country:     n.details?.country    || null,
      metricCount: Array.isArray(n.metricsDetails) ? n.metricsDetails.length : 0,
    })),
    createdAt:    boundary.createdAt,
  };
}

// ── Helper: explain why ESGLink data is absent ───────────────────────────────
async function _diagnoseEsgAbsence(clientId, domain) {
  const boundary = await EsgLinkBoundary.findOne(
    { clientId, isDeleted: { $ne: true } }
  ).select('isActive version setupMethod').lean();

  if (!boundary) {
    return `No ESGLink boundary has been set up for client ${clientId}. ` +
           `ESGLink must be configured before metrics, data entries, or summaries become available.`;
  }
  if (!boundary.isActive) {
    return `An ESGLink boundary exists for client ${clientId} but it is not active yet.`;
  }
  if (domain === 'esg_metrics') {
    return `An active ESGLink boundary exists for client ${clientId} but no metrics have been assigned to boundary nodes yet.`;
  }
  if (domain === 'esg_data_entry') {
    return `An active ESGLink boundary with metrics exists for client ${clientId} but no data entries have been submitted yet.`;
  }
  if (domain === 'esg_summary') {
    return `An active ESGLink boundary exists for client ${clientId} but no summary data has been computed yet. ` +
           `This is generated after metrics are assigned and data is collected.`;
  }
  return `No ${domain.replace('_', ' ')} data found for client ${clientId}.`;
}

async function retrieve(plan, accessContext) {
  const { clientId, domain, dateRange, sections, filters, maxRecords } = plan;
  const exclusions = [];

  if (accessContext.isScopeRestricted) {
    exclusions.push(...explainScopeRestrictions(accessContext.nodeRestrictions));
  }

  // ── Date filter ───────────────────────────────────────────────────────────
  const dateFilter = {};
  if (dateRange?.startDate) dateFilter.createdAt = { $gte: dateRange.startDate };
  if (dateRange?.endDate)   dateFilter.createdAt = { ...dateFilter.createdAt, $lte: dateRange.endDate };

  // ── Scope from access restrictions (workflow roles scoped to their mappings)
  const esgMappingIds  = accessContext.nodeRestrictions?.esgMappingIds  || null;
  const esgBoundaryIds = accessContext.nodeRestrictions?.esgBoundaryIds || null;
  const nodeIdFilter   = filters.nodeIds?.length ? filters.nodeIds : null;

  const results  = {};
  let totalRecords = 0;

  // ────────────────────────────────────────────────────────────────────────────
  // DOMAIN: esg_boundary
  //   sections: ['view', 'nodes', 'assignments']
  // ────────────────────────────────────────────────────────────────────────────
  if (domain === 'esg_boundary') {
    const boundary = await fetchActiveBoundary(clientId);
    if (!boundary) {
      exclusions.push(await _diagnoseEsgAbsence(clientId, 'esg_boundary'));
    } else {
      results.boundary = summariseBoundaryNodes(boundary);

      // Fetch metric-node mappings when 'assignments' or 'nodes' section requested
      if (sections.includes('assignments') || sections.includes('nodes') || sections.includes('view')) {
        const mappingFilter = {
          clientId,
          isDeleted: { $ne: true },
          ...(esgMappingIds?.length ? { _id: { $in: esgMappingIds } } : {}),
        };
        const { docs: mappings, totalFound: mTotal, wasTruncated: mTrunc } = await safeFindMany(
          EsgMetricNodeMapping,
          mappingFilter,
          { boundaryNodeId: 1, metricId: 1, mappingStatus: 1, frequency: 1, boundaryScope: 1 },
          { sort: { createdAt: -1 } },
          maxRecords
        );
        if (mTrunc) exclusions.push(explainTruncation(mTotal, mappings.length));
        results.metricMappings = { records: mappings, totalCount: mTotal };
        totalRecords += mTotal;
      }

      totalRecords += results.boundary.totalNodes;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // DOMAIN: esg_summary
  //   sections: ['overview', 'byMetric', 'byNode', 'byCategory']
  // ────────────────────────────────────────────────────────────────────────────
  if (domain === 'esg_summary') {
    // Always include the boundary structure as context
    const boundary = await fetchActiveBoundary(clientId);
    if (!boundary) {
      exclusions.push(await _diagnoseEsgAbsence(clientId, 'esg_boundary'));
    } else {
      results.boundary = summariseBoundaryNodes(boundary);
    }

    // ── Pre-computed boundary summaries ──────────────────────────────────────
    const summaryFilter = {
      clientId,
      ...(esgBoundaryIds?.length ? { boundaryDocId: { $in: esgBoundaryIds } } : {}),
    };
    if (dateRange?.startDate) {
      const yr = dateRange.startDate.getFullYear?.() || new Date(dateRange.startDate).getFullYear();
      summaryFilter.periodYear = { $gte: yr };
    }
    if (dateRange?.endDate) {
      const yr = dateRange.endDate.getFullYear?.() || new Date(dateRange.endDate).getFullYear();
      summaryFilter.periodYear = { ...summaryFilter.periodYear, $lte: yr };
    }

    const { docs: summaries, totalFound: sTotal, wasTruncated: sTrunc } = await safeFindMany(
      EsgBoundarySummary,
      summaryFilter,
      {
        boundaryDocId: 1, periodYear: 1, periodKey: 1, periodType: 1,
        totalEntries:  1, lastComputedAt: 1,
        'approvedSummary.totals': 1,
        'approvedSummary.byCategory': 1,
        'approvedSummary.byMetric': 1,
        'approvedSummary.byNode': 1,
        'draftSummary.totals': 1,
        'draftSummary.byCategory': 1,
      },
      { sort: { periodYear: -1 } },
      maxRecords
    );
    if (sTrunc) exclusions.push(explainTruncation(sTotal, summaries.length));
    results.boundarySummaries = { records: summaries, totalCount: sTotal };
    totalRecords += sTotal;

    // ── Fallback: fetch raw data entries when pre-computed summary is empty ──
    // EsgBoundarySummary is computed by a background job and may not have run
    // yet even when data entries already exist. If it is empty, pull raw entries
    // so DeepSeek still has something to work with.
    if (summaries.length === 0) {
      const entryFilter = {
        clientId,
        isDeleted: { $ne: true },
        ...dateFilter,
        ...(esgMappingIds?.length ? { mappingId: { $in: esgMappingIds.map(String) } } : {}),
        ...(nodeIdFilter ? { nodeId: { $in: nodeIdFilter } } : {}),
      };
      const { docs: entries, totalFound: eTotal, wasTruncated: eTrunc } = await safeFindMany(
        EsgDataEntry,
        entryFilter,
        {
          nodeId: 1, metricId: 1,
          'period.year': 1, 'period.periodLabel': 1,
          workflowStatus: 1, calculatedValue: 1, unitOfMeasurement: 1,
          submittedAt: 1,
        },
        { sort: { submittedAt: -1 } },
        maxRecords
      );
      if (eTrunc)        exclusions.push(explainTruncation(eTotal, entries.length));
      if (entries.length === 0) exclusions.push(await _diagnoseEsgAbsence(clientId, 'esg_summary'));
      results.rawEntries = { records: entries, totalCount: eTotal };
      totalRecords += eTotal;

      // Inline stats to give DeepSeek something meaningful
      if (entries.length > 0) {
        results.inlineStats = _computeEntryStats(entries);
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // DOMAIN: esg_metrics
  //   sections: ['list', 'detail', 'mappings']
  // ────────────────────────────────────────────────────────────────────────────
  if (domain === 'esg_metrics') {
    const mappingFilter = {
      clientId,
      isDeleted: { $ne: true },
      ...(esgMappingIds?.length ? { _id: { $in: esgMappingIds } } : {}),
    };
    const { docs: mappings, totalFound: mTotal, wasTruncated: mTrunc } = await safeFindMany(
      EsgMetricNodeMapping,
      mappingFilter,
      {
        metricId: 1, boundaryNodeId: 1, boundaryDocId: 1,
        mappingStatus: 1, frequency: 1, boundaryScope: 1, approvalLevel: 1,
        contributors: 1, reviewers: 1, approvers: 1,
      },
      { sort: { createdAt: -1 } },
      maxRecords
    );
    if (mTrunc) exclusions.push(explainTruncation(mTotal, mappings.length));
    results.metricMappings = { records: mappings, totalCount: mTotal };
    totalRecords += mTotal;

    // Enrich with metric library details when 'detail' or 'list' section
    if (sections.includes('list') || sections.includes('detail')) {
      const metricIds = [...new Set(mappings.map(m => String(m.metricId)).filter(Boolean))];

      // Also fetch global metrics and client-scoped metrics for this client
      const metricFilter = metricIds.length > 0
        ? {
            publishedStatus: 'published',
            $or: [
              { _id: { $in: metricIds } },
              { isGlobal: true },
              { clientId, isGlobal: false },
            ],
          }
        : {
            publishedStatus: 'published',
            $or: [
              { isGlobal: true },
              { clientId, isGlobal: false },
            ],
          };

      const { docs: metrics, totalFound: metTotal, wasTruncated: metTrunc } = await safeFindMany(
        EsgMetric,
        metricFilter,
        {
          metricCode: 1, metricName: 1, esgCategory: 1, subcategoryCode: 1,
          metricType: 1, primaryUnit: 1, metricDescription: 1, isGlobal: 1,
        },
        { sort: { esgCategory: 1, metricCode: 1 } },
        maxRecords
      );
      if (metTrunc) exclusions.push(explainTruncation(metTotal, metrics.length));
      results.metricLibrary = { records: metrics, totalCount: metTotal };
      totalRecords += metTotal;
    }

    if (mTotal === 0) exclusions.push(await _diagnoseEsgAbsence(clientId, 'esg_metrics'));
  }

  // ────────────────────────────────────────────────────────────────────────────
  // DOMAIN: esg_data_entry
  //   sections: ['list', 'detail', 'workflow', 'approved', 'pending']
  // ────────────────────────────────────────────────────────────────────────────
  if (domain === 'esg_data_entry') {
    const entryFilter = {
      clientId,
      isDeleted: { $ne: true },
      ...dateFilter,
      ...(esgMappingIds?.length ? { mappingId: { $in: esgMappingIds.map(String) } } : {}),
      ...(nodeIdFilter ? { nodeId: { $in: nodeIdFilter } } : {}),
    };

    // Restrict to specific workflow statuses when section specifies it
    const STATUS_FILTERS = {
      approved: 'approved',
      pending:  'submitted',
    };
    const statusSection = sections.find(s => STATUS_FILTERS[s]);
    if (statusSection) {
      entryFilter.workflowStatus = STATUS_FILTERS[statusSection];
    }

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
    if (entries.length === 0) exclusions.push(await _diagnoseEsgAbsence(clientId, 'esg_data_entry'));

    results.dataEntries = {
      records:    entries,
      totalCount: eTotal,
      stats:      _computeEntryStats(entries),
    };
    totalRecords += eTotal;
  }

  return {
    data:        results,
    exclusions,
    recordCount: totalRecords,
  };
}

function _computeEntryStats(docs) {
  const byStatus   = {};
  const byNode     = {};
  const byCategory = {};
  for (const d of docs) {
    const st = d.workflowStatus || 'unknown';
    byStatus[st] = (byStatus[st] || 0) + 1;
    if (d.nodeId) byNode[d.nodeId] = (byNode[d.nodeId] || 0) + 1;
  }
  return { byStatus, byNode, total: docs.length };
}

module.exports = { retrieve };
