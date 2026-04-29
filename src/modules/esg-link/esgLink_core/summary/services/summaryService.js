'use strict';

const EsgDataEntry       = require('../../data-collection/models/EsgDataEntry');
const EsgLinkBoundary    = require('../../boundary/models/EsgLinkBoundary');
const EsgBoundarySummary = require('../models/EsgBoundarySummary');
const EsgMetric          = require('../../metric/models/EsgMetric');
const { execute }        = require('../../rollup/utils/rollUpExecutor');

// ─── Period resolution ────────────────────────────────────────────────────────

function parsePeriodLabelToDate(label) {
  if (!label) return null;
  const parts = label.split('-').map(Number);
  if (parts.length === 1) return new Date(parts[0], 0, 1);
  if (parts.length === 2) return new Date(parts[0], parts[1] - 1, 1);
  if (parts.length === 3) return new Date(parts[0], parts[1] - 1, parts[2]);
  return null;
}

function resolvePeriod({ periodType, year, month, date, fyStart, fyEnd }) {
  if (!periodType || periodType === 'year') {
    const y = year || new Date().getFullYear();
    return {
      periodType:  'year',
      periodKey:   String(y),
      periodYear:  y,
      periodStart: new Date(y, 0, 1),
      periodEnd:   new Date(y, 11, 31),
      dbFilter:    { 'period.year': y },
    };
  }
  if (periodType === 'month') {
    const label = `${year}-${String(month).padStart(2, '0')}`;
    return {
      periodType:  'month',
      periodKey:   label,
      periodYear:  year,
      periodStart: new Date(year, month - 1, 1),
      periodEnd:   new Date(year, month, 0),
      dbFilter:    { 'period.periodLabel': label },
    };
  }
  if (periodType === 'day') {
    const [y, m, d] = date.split('-').map(Number);
    return {
      periodType:  'day',
      periodKey:   date,
      periodYear:  y,
      periodStart: new Date(y, m - 1, d),
      periodEnd:   new Date(y, m - 1, d),
      dbFilter:    { 'period.periodLabel': date },
    };
  }
  if (periodType === 'financial_year') {
    const startDate = new Date(fyStart);
    const endDate   = new Date(fyEnd);
    const years = [...new Set([startDate.getFullYear(), endDate.getFullYear()])];
    return {
      periodType:  'financial_year',
      periodKey:   `${fyStart}_${fyEnd}`,
      periodYear:  startDate.getFullYear(),
      periodStart: startDate,
      periodEnd:   endDate,
      dbFilter:    { 'period.year': { $in: years } },
      jsFilter: (entry) => {
        const d = parsePeriodLabelToDate(entry.period.periodLabel);
        return d && d >= startDate && d <= endDate;
      },
    };
  }
  throw new Error(`Unknown periodType: ${periodType}`);
}

// Derive periodDef from a saved EsgDataEntry's period sub-document
function resolvePeriodFromEntry(period) {
  const label = (period && period.periodLabel) || '';
  const year  = (period && period.year) || new Date().getFullYear();
  const parts = label.split('-');
  if (parts.length === 3) return resolvePeriod({ periodType: 'day', date: label });
  if (parts.length === 2) return resolvePeriod({ periodType: 'month', year: parseInt(parts[0], 10), month: parseInt(parts[1], 10) });
  return resolvePeriod({ periodType: 'year', year });
}

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
  const byScopeMap        = new Map();

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

    if (group.esgCategory) {
      byCategoryMap.set(group.esgCategory, (byCategoryMap.get(group.esgCategory) || 0) + combined);
    }

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

async function enrichEntriesFromMetricLibrary(entries) {
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

async function computeAndSaveSummary(clientId, boundaryDocId, periodDef) {
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
    ...periodDef.dbFilter,
    isDeleted:      false,
    workflowStatus: { $nin: ['superseded', 'rejected'] },
  }).lean();

  // For financial_year: apply JS post-filter to scope entries to exact date range
  const filteredEntries = periodDef.jsFilter ? rawEntries.filter(periodDef.jsFilter) : rawEntries;

  // Step 1: enrich from boundary metricsDetails (code, name, type, rollUpBehavior)
  const boundaryEnriched = enrichEntriesFromBoundary(filteredEntries, boundary);

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
    {
      clientId,
      boundaryDocId,
      periodType: periodDef.periodType,
      periodKey:  periodDef.periodKey,
    },
    {
      $set: {
        periodYear:  periodDef.periodYear,
        periodStart: periodDef.periodStart,
        periodEnd:   periodDef.periodEnd,
        approvedSummary,
        reviewerPendingSummary,
        approverPendingSummary,
        draftSummary,
        lastComputedAt:        new Date(),
        computationDurationMs: Date.now() - start,
        totalEntries:          filteredEntries.length,
      },
    },
    { upsert: true, new: true }
  );

  return doc;
}

// ─── Financial year helper (April–March) ─────────────────────────────────────

function getFinancialYearForDate(d) {
  if (!d) return null;
  const month = d.getMonth() + 1; // 1–12
  const year  = d.getFullYear();
  const fyStartYear = month >= 4 ? year : year - 1;
  const fyEndYear   = fyStartYear + 1;
  const fyStart = `${fyStartYear}-04-01`;
  const fyEnd   = `${fyEndYear}-03-31`;
  return resolvePeriod({ periodType: 'financial_year', fyStart, fyEnd });
}

// Build all 4 periodDefs from an entry's period sub-document
function resolveAllPeriodsFromEntry(period) {
  const label = (period && period.periodLabel) || '';
  const year  = (period && period.year) || new Date().getFullYear();
  const parts = label.split('-');

  const periods = [];

  // 1. Always: yearly
  periods.push(resolvePeriod({ periodType: 'year', year }));

  // 2. Monthly (if periodLabel has at least year+month)
  if (parts.length >= 2) {
    periods.push(resolvePeriod({
      periodType: 'month',
      year:  parseInt(parts[0], 10),
      month: parseInt(parts[1], 10),
    }));
  }

  // 3. Daily (if periodLabel has year+month+day)
  if (parts.length === 3) {
    periods.push(resolvePeriod({ periodType: 'day', date: label }));
  }

  // 4. Financial year (April–March) for the representative date
  const representativeDate = parsePeriodLabelToDate(label) || new Date(year, 0, 1);
  const fyDef = getFinancialYearForDate(representativeDate);
  if (fyDef) periods.push(fyDef);

  return periods;
}

// ─── Fire-and-forget ─────────────────────────────────────────────────────────

function triggerSummaryRefresh(clientId, boundaryDocId, periodDef) {
  setImmediate(async () => {
    try {
      await computeAndSaveSummary(clientId, boundaryDocId, periodDef);
    } catch (err) {
      console.error('[ESG Summary] refresh error:', err.message);
    }
  });
}

// Trigger all 4 period-type summaries in one fire-and-forget call
function triggerAllPeriodSummaryRefresh(clientId, boundaryDocId, period) {
  const allPeriods = resolveAllPeriodsFromEntry(period);
  setImmediate(async () => {
    for (const periodDef of allPeriods) {
      try {
        await computeAndSaveSummary(clientId, boundaryDocId, periodDef);
      } catch (err) {
        console.error(`[ESG Summary] refresh error (${periodDef.periodType}:${periodDef.periodKey}):`, err.message);
      }
    }
  });
}

// ─── Cached read ─────────────────────────────────────────────────────────────

async function getCachedSummary(clientId, boundaryDocId, periodDef, { forceRefresh = false } = {}) {
  if (forceRefresh) return computeAndSaveSummary(clientId, boundaryDocId, periodDef);
  const doc = await EsgBoundarySummary.findOne({
    clientId,
    boundaryDocId,
    periodType: periodDef.periodType,
    periodKey:  periodDef.periodKey,
  }).lean();
  if (!doc) return computeAndSaveSummary(clientId, boundaryDocId, periodDef);
  return doc;
}

// ─── Role-scoped summary ─────────────────────────────────────────────────────

async function getSummaryForUser(user, clientId, boundaryDocId, periodDef, options = {}) {
  const { forceRefresh = false, allowedLayers = ['approved'] } = options;
  const summaryDoc = await getCachedSummary(clientId, boundaryDocId, periodDef, { forceRefresh });
  if (!summaryDoc) return null;

  const result = {
    clientId,
    boundaryDocId,
    periodType:  periodDef.periodType,
    periodKey:   periodDef.periodKey,
    periodYear:  periodDef.periodYear,
    periodStart: periodDef.periodStart,
    periodEnd:   periodDef.periodEnd,
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

async function getHierarchySummary(clientId, boundaryDocId, periodDef, options = {}) {
  const summaryDoc = await getCachedSummary(clientId, boundaryDocId, periodDef, options);
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
    periodType:  periodDef.periodType,
    periodKey:   periodDef.periodKey,
    periodYear:  periodDef.periodYear,
    periodStart: periodDef.periodStart,
    periodEnd:   periodDef.periodEnd,
    lastComputedAt: summaryDoc.lastComputedAt,
    hierarchy,
    overallTotals:  (summaryDoc.approvedSummary || {}).totals || {},
  };
}

// ─── Dashboard summary ────────────────────────────────────────────────────────

async function getDashboardSummary(clientId, periodDef) {
  const boundaries = await EsgLinkBoundary.find({ clientId, isActive: true, isDeleted: false }).select('_id').lean();

  const results = [];
  for (const b of boundaries) {
    const summaryDoc = await getCachedSummary(clientId, b._id, periodDef);
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

  return {
    clientId,
    periodType:  periodDef.periodType,
    periodKey:   periodDef.periodKey,
    periodYear:  periodDef.periodYear,
    periodStart: periodDef.periodStart,
    periodEnd:   periodDef.periodEnd,
    boundaries: results,
    combinedApprovedTotals: combined,
  };
}

// ─── Reviewer pending (own assignments) ──────────────────────────────────────

async function getReviewerPendingForReviewer(userId, clientId, periodDef) {
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

  const rawEntries = await EsgDataEntry.find({
    clientId,
    ...periodDef.dbFilter,
    workflowStatus: { $in: ['submitted', 'clarification_requested', 'resubmitted'] },
    isDeleted:      false,
    mappingId:      { $in: Array.from(assignedMappingIds) },
  }).lean();

  const pendingEntries = periodDef.jsFilter ? rawEntries.filter(periodDef.jsFilter) : rawEntries;

  return {
    clientId,
    periodType:  periodDef.periodType,
    periodKey:   periodDef.periodKey,
    periodYear:  periodDef.periodYear,
    assignedPendingEntries: pendingEntries,
    count: pendingEntries.length,
  };
}

// ─── Approver pending (own assignments) ──────────────────────────────────────

async function getApproverPendingForApprover(userId, clientId, periodDef) {
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

  const rawEntries = await EsgDataEntry.find({
    clientId,
    ...periodDef.dbFilter,
    workflowStatus:                   'under_review',
    'approvalDecisions.approverId':   userId,
    'approvalDecisions.decision':     'pending',
    isDeleted:                        false,
    mappingId:                        { $in: Array.from(assignedMappingIds) },
  }).lean();

  const pendingEntries = periodDef.jsFilter ? rawEntries.filter(periodDef.jsFilter) : rawEntries;

  return {
    clientId,
    periodType:  periodDef.periodType,
    periodKey:   periodDef.periodKey,
    periodYear:  periodDef.periodYear,
    assignedPendingEntries: pendingEntries,
    count: pendingEntries.length,
  };
}

// ─── My-view (role-scoped) ────────────────────────────────────────────────────

async function getMyViewSummary(user, clientId, periodDef) {
  const userId = (user._id || user.id).toString();
  const role   = user.userType;

  if (role === 'reviewer')    return getReviewerPendingForReviewer(userId, clientId, periodDef);
  if (role === 'approver')    return getApproverPendingForApprover(userId, clientId, periodDef);
  if (role === 'contributor') {
    const rawEntries = await EsgDataEntry.find({
      clientId,
      ...periodDef.dbFilter,
      submittedBy: userId,
      isDeleted:   false,
    }).lean();
    const myEntries = periodDef.jsFilter ? rawEntries.filter(periodDef.jsFilter) : rawEntries;
    return {
      clientId,
      periodType: periodDef.periodType,
      periodKey:  periodDef.periodKey,
      periodYear: periodDef.periodYear,
      myEntries,
      count: myEntries.length,
    };
  }
  return getDashboardSummary(clientId, periodDef);
}

// ─── Available periods for a boundary ────────────────────────────────────────

async function getAvailablePeriods(clientId, boundaryDocId) {
  const docs = await EsgBoundarySummary.find(
    { clientId, boundaryDocId },
    { periodType: 1, periodKey: 1, periodYear: 1, periodStart: 1, periodEnd: 1, lastComputedAt: 1, totalEntries: 1 }
  ).sort({ periodType: 1, periodKey: 1 }).lean();

  return docs.map((d) => ({
    periodType:     d.periodType,
    periodKey:      d.periodKey,
    periodYear:     d.periodYear,
    periodStart:    d.periodStart,
    periodEnd:      d.periodEnd,
    lastComputedAt: d.lastComputedAt,
    totalEntries:   d.totalEntries,
  }));
}

// ─── Refresh all 4 period types for every period found in EsgDataEntry ───────

async function refreshAllBoundaryPeriods(clientId, boundaryDocId) {
  // Collect every unique (periodLabel, periodYear) pair that has data
  const combos = await EsgDataEntry.aggregate([
    {
      $match: {
        clientId,
        boundaryDocId,
        isDeleted:      false,
        workflowStatus: { $nin: ['superseded', 'rejected'] },
      },
    },
    {
      $group: {
        _id: {
          periodLabel: '$period.periodLabel',
          periodYear:  '$period.year',
        },
      },
    },
  ]);

  const results = [];
  const seen    = new Set(); // avoid duplicate periodDef keys

  for (const combo of combos) {
    const period  = { year: combo._id.periodYear, periodLabel: combo._id.periodLabel || '' };
    const allDefs = resolveAllPeriodsFromEntry(period);

    for (const periodDef of allDefs) {
      const dedupKey = `${periodDef.periodType}:${periodDef.periodKey}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      try {
        await computeAndSaveSummary(clientId, boundaryDocId, periodDef);
        results.push({ periodType: periodDef.periodType, periodKey: periodDef.periodKey, success: true });
      } catch (err) {
        results.push({ periodType: periodDef.periodType, periodKey: periodDef.periodKey, success: false, error: err.message });
      }
    }
  }

  return results;
}

module.exports = {
  resolvePeriod,
  resolvePeriodFromEntry,
  resolveAllPeriodsFromEntry,
  computeAndSaveSummary,
  triggerSummaryRefresh,
  triggerAllPeriodSummaryRefresh,
  getCachedSummary,
  getSummaryForUser,
  getHierarchySummary,
  getDashboardSummary,
  getAvailablePeriods,
  refreshAllBoundaryPeriods,
  getReviewerPendingForReviewer,
  getApproverPendingForApprover,
  getMyViewSummary,
};
