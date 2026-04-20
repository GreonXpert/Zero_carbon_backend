'use strict';

const EsgDataEntry       = require('../../data-collection/models/EsgDataEntry');
const EsgLinkBoundary    = require('../../boundary/models/EsgLinkBoundary');
const EsgBoundarySummary = require('../models/EsgBoundarySummary');
const EsgMetric          = require('../../metric/models/EsgMetric');
const { execute }        = require('../../rollup/utils/rollUpExecutor');

// ─── Bucket classification ────────────────────────────────────────────────────

function classifyEntry(entry) {
  const s = entry.workflowStatus;
  if (s === 'approved')  return 'approved';
  if (s === 'draft')     return 'draft';
  if (s === 'submitted') return 'draft';
  if (s === 'under_review') {
    const hasDecisions = Array.isArray(entry.approvalDecisions) && entry.approvalDecisions.length > 0;
    return hasDecisions ? 'approverPending' : 'reviewerPending';
  }
  if (s === 'clarification_requested') return 'reviewerPending';
  if (s === 'resubmitted')             return 'reviewerPending';
  return null; // superseded / rejected — excluded
}

// ─── Build a single summary layer ────────────────────────────────────────────

function buildLayer(entries, nodeMap) {
  const metricGroups = new Map();

  for (const entry of entries) {
    const nodeLabel = nodeMap.get(entry.nodeId) || entry.nodeId;
    const key = [
      (entry.metricId || '').toString(),
      entry.metricCode      || '',
      entry.metricName      || '',
      entry.esgCategory     || '',
      entry.subcategoryCode || '',
      entry.metricType      || '',
      entry.primaryUnit     || entry.unitOfMeasurement || '',
      entry.rollUpBehavior  || 'sum',
      entry.boundaryScope   || '',
    ].join('|');

    if (!metricGroups.has(key)) {
      metricGroups.set(key, {
        metricId:        entry.metricId,
        metricCode:      entry.metricCode      || '',
        metricName:      entry.metricName      || '',
        esgCategory:     entry.esgCategory     || '',
        subcategoryCode: entry.subcategoryCode || '',
        metricType:      entry.metricType      || '',
        primaryUnit:     entry.primaryUnit     || entry.unitOfMeasurement || '',
        rollUpBehavior:  entry.rollUpBehavior  || 'sum',
        boundaryScope:   entry.boundaryScope   || '',
        nodes:           new Map(),
      });
    }

    const group = metricGroups.get(key);
    // Last entry wins per node (latest for same mapping/period)
    group.nodes.set(entry.nodeId, {
      nodeId:    entry.nodeId,
      nodeLabel,
      value:     entry.calculatedValue != null ? entry.calculatedValue : 0,
      entryId:   entry._id,
      decidedAt: entry.updatedAt || entry.createdAt,
    });
  }

  const byMetric          = [];
  const byNodeMap         = new Map();
  const byCategoryMap     = new Map();
  const byScopeMap        = new Map(); // boundaryScope → { total, metrics[] }

  for (const group of metricGroups.values()) {
    const nodeValues = Array.from(group.nodes.values());
    const rawValues  = nodeValues.map((n) => n.value);
    const combined   = execute(group.rollUpBehavior, rawValues);

    byMetric.push({
      metricId:         group.metricId,
      metricCode:       group.metricCode,
      metricName:       group.metricName,
      esgCategory:      group.esgCategory,
      subcategoryCode:  group.subcategoryCode,
      metricType:       group.metricType,
      primaryUnit:      group.primaryUnit,
      rollUpBehavior:   group.rollUpBehavior,
      boundaryScope:    group.boundaryScope,
      combinedValue:    combined,
      contributingNodes: nodeValues.map((n) => ({
        nodeId:    n.nodeId,
        nodeLabel: n.nodeLabel,
        value:     n.value,
        entryId:   n.entryId,
        decidedAt: n.decidedAt,
      })),
      entryCount: nodeValues.length,
    });

    // ── byCategory accumulation ───────────────────────────────────────────
    if (group.esgCategory) {
      byCategoryMap.set(group.esgCategory, (byCategoryMap.get(group.esgCategory) || 0) + combined);
    }

    // ── byBoundaryScope accumulation ──────────────────────────────────────
    const scopeKey = group.boundaryScope || 'unspecified';
    if (!byScopeMap.has(scopeKey)) {
      byScopeMap.set(scopeKey, { total: 0, entryCount: 0, metrics: [] });
    }
    const scopeEntry = byScopeMap.get(scopeKey);
    scopeEntry.total      += combined;
    scopeEntry.entryCount += nodeValues.length;
    scopeEntry.metrics.push({
      metricId:        group.metricId,
      metricCode:      group.metricCode,
      metricName:      group.metricName,
      esgCategory:     group.esgCategory,
      subcategoryCode: group.subcategoryCode,
      combinedValue:   combined,
      primaryUnit:     group.primaryUnit,
    });

    // ── byNode accumulation ───────────────────────────────────────────────
    for (const n of nodeValues) {
      if (!byNodeMap.has(n.nodeId)) {
        byNodeMap.set(n.nodeId, { nodeId: n.nodeId, nodeLabel: n.nodeLabel, metrics: [] });
      }
      byNodeMap.get(n.nodeId).metrics.push({
        metricId:        group.metricId,
        metricCode:      group.metricCode,
        metricName:      group.metricName,
        esgCategory:     group.esgCategory,
        subcategoryCode: group.subcategoryCode,
        value:           n.value,
        unit:            group.primaryUnit,
        rollUpBehavior:  group.rollUpBehavior,
        boundaryScope:   group.boundaryScope,
        entryCount:      1,
      });
    }
  }

  const byCategory = Array.from(byCategoryMap.entries()).map(([esgCategory, total]) => ({
    esgCategory,
    total,
    entryCount: byMetric
      .filter((m) => m.esgCategory === esgCategory)
      .reduce((a, m) => a + m.entryCount, 0),
  }));

  const byBoundaryScope = Array.from(byScopeMap.entries()).map(([boundaryScope, data]) => ({
    boundaryScope,
    total:      data.total,
    entryCount: data.entryCount,
    metrics:    data.metrics,
  }));

  const totals = {
    E:       byCategoryMap.get('E') || 0,
    S:       byCategoryMap.get('S') || 0,
    G:       byCategoryMap.get('G') || 0,
    overall: Array.from(byCategoryMap.values()).reduce((a, b) => a + b, 0),
  };

  return { byMetric, byNode: Array.from(byNodeMap.values()), byCategory, byBoundaryScope, totals };
}

// ─── Enrich entries with boundary metricsDetails metadata ────────────────────

function enrichEntriesFromBoundary(entries, boundary) {
  const mappingMeta = new Map();
  for (const node of boundary.nodes || []) {
    for (const md of node.metricsDetails || []) {
      if (!md._id) continue;
      mappingMeta.set(md._id.toString(), {
        metricId:       md.metricId,
        metricCode:     md.metricCode,
        metricName:     md.metricName,
        metricType:     md.metricType,
        rollUpBehavior: md.rollUpBehavior || 'sum',
        boundaryScope:  md.boundaryScope  || '',
      });
    }
  }

  return entries.map((entry) => {
    const meta = mappingMeta.get(entry.mappingId) || {};
    return {
      ...entry,
      metricId:       meta.metricId       || entry.metricId,
      metricCode:     meta.metricCode     || entry.metricCode,
      metricName:     meta.metricName     || entry.metricName,
      metricType:     meta.metricType     || entry.metricType,
      rollUpBehavior: meta.rollUpBehavior || 'sum',
      boundaryScope:  meta.boundaryScope  !== undefined ? meta.boundaryScope : (entry.boundaryScope || ''),
    };
  });
}

// ─── Enrich entries with esgCategory + subcategoryCode from EsgMetric library ─
// metricsDetails snapshots do NOT store esgCategory/subcategoryCode —
// we must look them up from the EsgMetric collection using metricId.

async function enrichEntriesFromMetricLibrary(entries) {
  // Collect unique metricIds
  const uniqueIds = [...new Set(
    entries.map((e) => e.metricId).filter(Boolean).map((id) => id.toString())
  )];
  if (uniqueIds.length === 0) return entries;

  const metrics = await EsgMetric.find(
    { _id: { $in: uniqueIds } },
    { esgCategory: 1, subcategoryCode: 1 }
  ).lean();

  const metricMeta = new Map(
    metrics.map((m) => [m._id.toString(), {
      esgCategory:     m.esgCategory     || '',
      subcategoryCode: m.subcategoryCode || '',
    }])
  );

  return entries.map((entry) => {
    const idStr = entry.metricId ? entry.metricId.toString() : '';
    const lib   = metricMeta.get(idStr) || {};
    return {
      ...entry,
      esgCategory:     lib.esgCategory     || entry.esgCategory     || '',
      subcategoryCode: lib.subcategoryCode || entry.subcategoryCode || '',
    };
  });
}

// ─── Core: compute and save ───────────────────────────────────────────────────

async function computeAndSaveSummary(clientId, boundaryDocId, periodYear) {
  const start = Date.now();

  const boundary = await EsgLinkBoundary.findOne({ _id: boundaryDocId, clientId, isDeleted: false });
  if (!boundary) return null;

  const nodeMap = new Map();
  for (const node of boundary.nodes || []) {
    nodeMap.set(node.id, node.label || node.id);
  }

  const rawEntries = await EsgDataEntry.find({
    clientId,
    boundaryDocId,
    'period.year': periodYear,
    isDeleted:     false,
    workflowStatus: { $nin: ['superseded', 'rejected'] },
  }).lean();

  // Step 1: enrich from boundary metricsDetails (code, name, type, rollUpBehavior)
  const boundaryEnriched = enrichEntriesFromBoundary(rawEntries, boundary);

  // Step 2: enrich esgCategory + subcategoryCode from EsgMetric library
  const entries = await enrichEntriesFromMetricLibrary(boundaryEnriched);

  const buckets = { approved: [], reviewerPending: [], approverPending: [], draft: [] };
  for (const entry of entries) {
    const bucket = classifyEntry(entry);
    if (bucket) buckets[bucket].push(entry);
  }

  const approvedSummary        = buildLayer(buckets.approved,        nodeMap);
  const reviewerPendingSummary = buildLayer(buckets.reviewerPending, nodeMap);
  const approverPendingSummary = buildLayer(buckets.approverPending, nodeMap);
  const draftSummary           = buildLayer(buckets.draft,           nodeMap);

  const doc = await EsgBoundarySummary.findOneAndUpdate(
    { clientId, boundaryDocId, periodYear },
    {
      $set: {
        approvedSummary,
        reviewerPendingSummary,
        approverPendingSummary,
        draftSummary,
        lastComputedAt:        new Date(),
        computationDurationMs: Date.now() - start,
        totalEntries:          entries.length,
      },
    },
    { upsert: true, new: true }
  );

  return doc;
}

// ─── Fire-and-forget ─────────────────────────────────────────────────────────

function triggerSummaryRefresh(clientId, boundaryDocId, periodYear) {
  setImmediate(async () => {
    try {
      await computeAndSaveSummary(clientId, boundaryDocId, periodYear);
    } catch (err) {
      console.error('[ESG Summary] refresh error:', err.message);
    }
  });
}

// ─── Cached read ─────────────────────────────────────────────────────────────

async function getCachedSummary(clientId, boundaryDocId, periodYear, { forceRefresh = false } = {}) {
  if (forceRefresh) return computeAndSaveSummary(clientId, boundaryDocId, periodYear);
  const doc = await EsgBoundarySummary.findOne({ clientId, boundaryDocId, periodYear }).lean();
  if (!doc) return computeAndSaveSummary(clientId, boundaryDocId, periodYear);
  return doc;
}

// ─── Role-scoped summary ─────────────────────────────────────────────────────

async function getSummaryForUser(user, clientId, boundaryDocId, periodYear, options = {}) {
  const { forceRefresh = false, allowedLayers = ['approved'] } = options;
  const summaryDoc = await getCachedSummary(clientId, boundaryDocId, periodYear, { forceRefresh });
  if (!summaryDoc) return null;

  const result = {
    clientId,
    boundaryDocId,
    periodYear,
    lastComputedAt: summaryDoc.lastComputedAt,
    totalEntries:   summaryDoc.totalEntries,
  };

  if (allowedLayers.includes('approved'))         result.approvedSummary        = summaryDoc.approvedSummary;
  if (allowedLayers.includes('reviewer_pending')) result.reviewerPendingSummary = summaryDoc.reviewerPendingSummary;
  if (allowedLayers.includes('approver_pending')) result.approverPendingSummary = summaryDoc.approverPendingSummary;
  if (allowedLayers.includes('draft'))            result.draftSummary           = summaryDoc.draftSummary;

  return result;
}

// ─── Hierarchy summary ────────────────────────────────────────────────────────

async function getHierarchySummary(clientId, boundaryDocId, periodYear, options = {}) {
  const summaryDoc = await getCachedSummary(clientId, boundaryDocId, periodYear, options);
  if (!summaryDoc) return null;

  const boundary = await EsgLinkBoundary.findOne({ _id: boundaryDocId, clientId, isDeleted: false }).lean();
  if (!boundary) return null;

  const nodeMetaMap = new Map();
  for (const node of boundary.nodes || []) {
    nodeMetaMap.set(node.id, { id: node.id, label: node.label, type: node.type });
  }

  const approvedByNode = (summaryDoc.approvedSummary || {}).byNode || [];
  const hierarchy = approvedByNode.map((nodeSummary) => ({
    node:    nodeMetaMap.get(nodeSummary.nodeId) || { id: nodeSummary.nodeId },
    metrics: nodeSummary.metrics || [],
  }));

  return {
    clientId,
    boundaryDocId,
    periodYear,
    lastComputedAt: summaryDoc.lastComputedAt,
    hierarchy,
    overallTotals:  (summaryDoc.approvedSummary || {}).totals || {},
  };
}

// ─── Dashboard summary ────────────────────────────────────────────────────────

async function getDashboardSummary(clientId, periodYear) {
  const boundaries = await EsgLinkBoundary.find({ clientId, isActive: true, isDeleted: false }).select('_id').lean();

  const results = [];
  for (const b of boundaries) {
    const summaryDoc = await getCachedSummary(clientId, b._id, periodYear);
    if (summaryDoc) {
      results.push({
        boundaryDocId:         b._id,
        approvedTotals:        (summaryDoc.approvedSummary        || {}).totals || {},
        reviewerPendingTotals: (summaryDoc.reviewerPendingSummary || {}).totals || {},
        approverPendingTotals: (summaryDoc.approverPendingSummary || {}).totals || {},
        lastComputedAt:        summaryDoc.lastComputedAt,
      });
    }
  }

  const combined = { E: 0, S: 0, G: 0, overall: 0 };
  for (const r of results) {
    for (const k of ['E', 'S', 'G', 'overall']) combined[k] += (r.approvedTotals[k] || 0);
  }

  return { clientId, periodYear, boundaries: results, combinedApprovedTotals: combined };
}

// ─── Reviewer pending (own assignments) ──────────────────────────────────────

async function getReviewerPendingForReviewer(userId, clientId, periodYear) {
  const userIdStr  = userId.toString();
  const boundaries = await EsgLinkBoundary.find({ clientId, isActive: true, isDeleted: false }).lean();
  const assignedMappingIds = new Set();

  for (const boundary of boundaries) {
    for (const node of boundary.nodes || []) {
      const nodeReviewerIds = (node.nodeReviewerIds || []).map((id) => id.toString());
      for (const md of node.metricsDetails || []) {
        const reviewers = md.inheritNodeReviewers
          ? nodeReviewerIds
          : (md.reviewers || []).map((id) => id.toString());
        if (reviewers.includes(userIdStr)) {
          assignedMappingIds.add(md._id ? md._id.toString() : '');
        }
      }
    }
  }

  const pendingEntries = await EsgDataEntry.find({
    clientId,
    'period.year':  periodYear,
    workflowStatus: { $in: ['submitted', 'clarification_requested', 'resubmitted'] },
    isDeleted:      false,
    mappingId:      { $in: Array.from(assignedMappingIds) },
  }).lean();

  return { clientId, periodYear, assignedPendingEntries: pendingEntries, count: pendingEntries.length };
}

// ─── Approver pending (own assignments) ──────────────────────────────────────

async function getApproverPendingForApprover(userId, clientId, periodYear) {
  const userIdStr  = userId.toString();
  const boundaries = await EsgLinkBoundary.find({ clientId, isActive: true, isDeleted: false }).lean();
  const assignedMappingIds = new Set();

  for (const boundary of boundaries) {
    for (const node of boundary.nodes || []) {
      const nodeApproverIds = (node.nodeApproverIds || []).map((id) => id.toString());
      for (const md of node.metricsDetails || []) {
        const approvers = md.inheritNodeApprovers
          ? nodeApproverIds
          : (md.approvers || []).map((id) => id.toString());
        if (approvers.includes(userIdStr)) {
          assignedMappingIds.add(md._id ? md._id.toString() : '');
        }
      }
    }
  }

  const pendingEntries = await EsgDataEntry.find({
    clientId,
    'period.year':                    periodYear,
    workflowStatus:                   'under_review',
    'approvalDecisions.approverId':   userId,
    'approvalDecisions.decision':     'pending',
    isDeleted:                        false,
    mappingId:                        { $in: Array.from(assignedMappingIds) },
  }).lean();

  return { clientId, periodYear, assignedPendingEntries: pendingEntries, count: pendingEntries.length };
}

// ─── My-view (role-scoped) ────────────────────────────────────────────────────

async function getMyViewSummary(user, clientId, periodYear) {
  const userId = (user._id || user.id).toString();
  const role   = user.userType;

  if (role === 'reviewer')    return getReviewerPendingForReviewer(userId, clientId, periodYear);
  if (role === 'approver')    return getApproverPendingForApprover(userId, clientId, periodYear);
  if (role === 'contributor') {
    const myEntries = await EsgDataEntry.find({
      clientId, 'period.year': periodYear, submittedBy: userId, isDeleted: false,
    }).lean();
    return { clientId, periodYear, myEntries, count: myEntries.length };
  }
  return getDashboardSummary(clientId, periodYear);
}

module.exports = {
  computeAndSaveSummary,
  triggerSummaryRefresh,
  getCachedSummary,
  getSummaryForUser,
  getHierarchySummary,
  getDashboardSummary,
  getReviewerPendingForReviewer,
  getApproverPendingForApprover,
  getMyViewSummary,
};
