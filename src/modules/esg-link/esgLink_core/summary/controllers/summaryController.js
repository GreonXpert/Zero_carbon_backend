'use strict';

const svc = require('../services/summaryService');

// ─── Period param resolution + validation ─────────────────────────────────────

function getPeriodParams(req) {
  const periodType = req.query.periodType || 'year';
  const year       = parseInt(req.query.year,  10) || new Date().getFullYear();
  const month      = parseInt(req.query.month, 10) || null;
  const date       = req.query.date    || null;
  const fyStart    = req.query.fyStart || null;
  const fyEnd      = req.query.fyEnd   || null;

  // Validate required params per periodType
  if (periodType === 'month' && (!month || month < 1 || month > 12)) {
    throw Object.assign(new Error('periodType=month requires ?month=1-12'), { status: 400 });
  }
  if (periodType === 'day' && !date) {
    throw Object.assign(new Error('periodType=day requires ?date=YYYY-MM-DD'), { status: 400 });
  }
  if (periodType === 'financial_year' && (!fyStart || !fyEnd)) {
    throw Object.assign(new Error('periodType=financial_year requires ?fyStart=YYYY-MM-DD&fyEnd=YYYY-MM-DD'), { status: 400 });
  }

  return svc.resolvePeriod({ periodType, year, month, date, fyStart, fyEnd });
}

function ok(res, data) {
  return res.json({ success: true, ...data });
}

function handleErr(res, err) {
  const status = err.status || 500;
  if (status === 500) {
    console.error('[ESG Summary] 500 error:', err.message);
    console.error(err.stack || err);
  }
  return res.status(status).json({ success: false, message: err.message });
}

// ─── Boundary summary ─────────────────────────────────────────────────────────

async function getBoundarySummary(req, res) {
  try {
    const { clientId, boundaryId } = req.params;
    const periodDef    = getPeriodParams(req);
    const forceRefresh = req.query.refresh === 'true';
    const { allowedLayers } = req.esgSummaryCtx;

    const data = await svc.getSummaryForUser(req.user, clientId, boundaryId, periodDef, { forceRefresh, allowedLayers });
    if (!data) return res.status(404).json({ success: false, message: 'Boundary or summary not found' });
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

// ─── Hierarchy summary ────────────────────────────────────────────────────────

async function getHierarchySummary(req, res) {
  try {
    const { clientId, boundaryId } = req.params;
    const periodDef    = getPeriodParams(req);
    const forceRefresh = req.query.refresh === 'true';

    const data = await svc.getHierarchySummary(clientId, boundaryId, periodDef, { forceRefresh });
    if (!data) return res.status(404).json({ success: false, message: 'Boundary or summary not found' });
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

// ─── Dashboard summary ────────────────────────────────────────────────────────

async function getDashboardSummary(req, res) {
  try {
    const { clientId } = req.params;
    const periodDef    = getPeriodParams(req);
    const data = await svc.getDashboardSummary(clientId, periodDef);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

// ─── Reviewer pending ─────────────────────────────────────────────────────────

async function getReviewerPendingSummary(req, res) {
  try {
    const { clientId } = req.params;
    const periodDef    = getPeriodParams(req);
    const { role, isFullAccess, userId } = req.esgSummaryCtx;

    if (isFullAccess) {
      const EsgDataEntry = require('../../data-collection/models/EsgDataEntry');
      const raw = await EsgDataEntry.find({
        clientId,
        ...periodDef.dbFilter,
        workflowStatus: { $in: ['submitted', 'clarification_requested', 'resubmitted'] },
        isDeleted: false,
      }).lean();
      const entries = periodDef.jsFilter ? raw.filter(periodDef.jsFilter) : raw;
      return ok(res, { data: {
        clientId,
        periodType:     periodDef.periodType,
        periodKey:      periodDef.periodKey,
        periodYear:     periodDef.periodYear,
        periodStart:    periodDef.periodStart,
        periodEnd:      periodDef.periodEnd,
        pendingEntries: entries,
        count:          entries.length,
      }});
    }

    if (role !== 'reviewer') {
      return res.status(403).json({ success: false, message: 'Only reviewers can access reviewer-pending summary' });
    }
    const data = await svc.getReviewerPendingForReviewer(userId, clientId, periodDef);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

// ─── Approver pending ─────────────────────────────────────────────────────────

async function getApproverPendingSummary(req, res) {
  try {
    const { clientId } = req.params;
    const periodDef    = getPeriodParams(req);
    const { role, isFullAccess, userId } = req.esgSummaryCtx;

    if (isFullAccess) {
      const EsgDataEntry = require('../../data-collection/models/EsgDataEntry');
      const raw = await EsgDataEntry.find({
        clientId,
        ...periodDef.dbFilter,
        workflowStatus:    'under_review',
        approvalDecisions: { $exists: true, $not: { $size: 0 } },
        isDeleted:         false,
      }).lean();
      const entries = periodDef.jsFilter ? raw.filter(periodDef.jsFilter) : raw;
      return ok(res, { data: {
        clientId,
        periodType:     periodDef.periodType,
        periodKey:      periodDef.periodKey,
        periodYear:     periodDef.periodYear,
        periodStart:    periodDef.periodStart,
        periodEnd:      periodDef.periodEnd,
        pendingEntries: entries,
        count:          entries.length,
      }});
    }

    if (role !== 'approver') {
      return res.status(403).json({ success: false, message: 'Only approvers can access approver-pending summary' });
    }
    const data = await svc.getApproverPendingForApprover(userId, clientId, periodDef);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

// ─── My-view ──────────────────────────────────────────────────────────────────

async function getMyViewSummary(req, res) {
  try {
    const { clientId } = req.params;
    const periodDef    = getPeriodParams(req);
    const data = await svc.getMyViewSummary(req.user, clientId, periodDef);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

// ─── Manual single-period refresh ────────────────────────────────────────────

async function refreshSummary(req, res) {
  try {
    const { clientId, boundaryId } = req.params;
    const { isFullAccess } = req.esgSummaryCtx;

    if (!isFullAccess) {
      return res.status(403).json({ success: false, message: 'Only admin or consultant can trigger manual refresh' });
    }

    const periodDef = getPeriodParams(req);
    const doc = await svc.computeAndSaveSummary(clientId, boundaryId, periodDef);
    if (!doc) return res.status(404).json({ success: false, message: 'Boundary not found' });

    if (global.broadcastEsgSummaryUpdate) {
      global.broadcastEsgSummaryUpdate(clientId, boundaryId, 'full_refresh', {
        periodKey:  periodDef.periodKey,
        periodType: periodDef.periodType,
        periodYear: periodDef.periodYear,
      });
    }

    return ok(res, { data: {
      periodType:     periodDef.periodType,
      periodKey:      periodDef.periodKey,
      lastComputedAt: doc.lastComputedAt,
      totalEntries:   doc.totalEntries,
    }});
  } catch (err) { return handleErr(res, err); }
}

// ─── Refresh all 4 period types for every period in the boundary ──────────────

async function refreshAllPeriods(req, res) {
  try {
    const { clientId, boundaryId } = req.params;
    const { isFullAccess } = req.esgSummaryCtx;

    if (!isFullAccess) {
      return res.status(403).json({ success: false, message: 'Only admin or consultant can trigger refresh-all' });
    }

    const results = await svc.refreshAllBoundaryPeriods(clientId, boundaryId);

    if (global.broadcastEsgSummaryUpdate) {
      global.broadcastEsgSummaryUpdate(clientId, boundaryId, 'full_refresh', { allPeriods: true });
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed    = results.filter((r) => !r.success).length;

    return ok(res, { data: { results, succeeded, failed } });
  } catch (err) { return handleErr(res, err); }
}

// ─── List all available period summaries for a boundary ──────────────────────

async function getAvailablePeriods(req, res) {
  try {
    const { clientId, boundaryId } = req.params;
    const data = await svc.getAvailablePeriods(clientId, boundaryId);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

// =============================================================================
// GROUP 1 — Portfolio
// =============================================================================

async function getPortfolioDashboard(req, res) {
  try {
    const data = await svc.getPortfolioDashboard(req.user);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

async function getClientHealthSummary(req, res) {
  try {
    const data = await svc.getClientHealthSummary(req.user);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

// =============================================================================
// GROUP 2 — Period Comparison & Trends
// =============================================================================

async function comparePeriodsForClient(req, res) {
  try {
    const { clientId } = req.params;
    // periods is a JSON array of period param objects in the query string
    let periodsArray = [];
    try { periodsArray = JSON.parse(req.query.periods || '[]'); } catch { periodsArray = []; }
    if (!periodsArray.length) {
      return res.status(400).json({ success: false, message: 'periods query param is required (JSON array)' });
    }
    const facilityId = req.query.facilityId || null;
    const data = await svc.comparePeriodsForClient(clientId, periodsArray, req.user, { boundaryId: facilityId });
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

async function getTrendForClient(req, res) {
  try {
    const { clientId }  = req.params;
    const category      = req.query.category || 'overall';
    const periodType    = req.query.periodType || 'year';
    const count         = parseInt(req.query.count, 10) || 12;
    const data = await svc.getTrendForClient(clientId, category, periodType, count);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

async function listAllClientPeriods(req, res) {
  try {
    const { clientId } = req.params;
    const data = await svc.listAllClientPeriods(clientId);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

// =============================================================================
// GROUP 3 — Category & Top/Bottom
// =============================================================================

async function getCategoryBreakdown(req, res) {
  try {
    const { clientId } = req.params;
    const periodDef    = getPeriodParams(req);
    const data = await svc.getCategoryBreakdown(clientId, periodDef);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

async function getTopBottomMetrics(req, res) {
  try {
    const { clientId } = req.params;
    const periodDef    = getPeriodParams(req);
    const n            = parseInt(req.query.n, 10) || 5;
    const data = await svc.getTopBottomMetrics(clientId, periodDef, n);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

// =============================================================================
// GROUP 4 — Coverage & Data Quality
// =============================================================================

async function getMetricCoverage(req, res) {
  try {
    const { clientId } = req.params;
    const periodDef    = getPeriodParams(req);
    const data = await svc.getMetricCoverage(clientId, periodDef);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

async function getDataQualityStats(req, res) {
  try {
    const { clientId } = req.params;
    const periodDef    = getPeriodParams(req);
    const data = await svc.getDataQualityStats(clientId, periodDef);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

async function getMissingMetrics(req, res) {
  try {
    const { clientId } = req.params;
    const periodDef    = getPeriodParams(req);
    const data = await svc.getMissingMetrics(clientId, periodDef);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

// =============================================================================
// GROUP 5 — Workflow Analytics
// =============================================================================

async function getWorkflowStatusCounts(req, res) {
  try {
    const { clientId } = req.params;
    const periodDef    = getPeriodParams(req);
    const data = await svc.getWorkflowStatusCounts(clientId, periodDef);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

async function getWorkflowAging(req, res) {
  try {
    const { clientId } = req.params;
    const periodDef    = getPeriodParams(req);
    const data = await svc.getWorkflowAging(clientId, periodDef);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

// =============================================================================
// GROUP 6 — Reviewer Dashboard
// =============================================================================

async function getReviewerQueue(req, res) {
  try {
    const { clientId }              = req.params;
    const { role, isFullAccess, userId } = req.esgSummaryCtx;
    const periodDef                 = getPeriodParams(req);

    // null = "all users" when full-access admin doesn't specify a userId
    const targetUserId = isFullAccess ? (req.query.userId || null) : userId;
    if (!isFullAccess && role !== 'reviewer') {
      return res.status(403).json({ success: false, message: 'Reviewer access required' });
    }
    const data = await svc.getReviewerQueue(targetUserId, clientId, periodDef);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

async function getReviewerStats(req, res) {
  try {
    const { clientId }              = req.params;
    const { role, isFullAccess, userId } = req.esgSummaryCtx;

    // null = "all users" when full-access admin doesn't specify a userId
    const targetUserId = isFullAccess ? (req.query.userId || null) : userId;
    if (!isFullAccess && role !== 'reviewer') {
      return res.status(403).json({ success: false, message: 'Reviewer access required' });
    }
    const data = await svc.getReviewerStats(targetUserId, clientId);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

async function getReviewerAgingQueue(req, res) {
  try {
    const { clientId }              = req.params;
    const { role, isFullAccess, userId } = req.esgSummaryCtx;
    const periodDef                 = getPeriodParams(req);

    // null = "all users" when full-access admin doesn't specify a userId
    const targetUserId = isFullAccess ? (req.query.userId || null) : userId;
    if (!isFullAccess && role !== 'reviewer') {
      return res.status(403).json({ success: false, message: 'Reviewer access required' });
    }
    const data = await svc.getReviewerAgingQueue(targetUserId, clientId, periodDef);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

// =============================================================================
// GROUP 7 — Approver Dashboard
// =============================================================================

async function getApproverQueue(req, res) {
  try {
    const { clientId }              = req.params;
    const { role, isFullAccess, userId } = req.esgSummaryCtx;
    const periodDef                 = getPeriodParams(req);

    // null = "all users" when full-access admin doesn't specify a userId
    const targetUserId = isFullAccess ? (req.query.userId || null) : userId;
    if (!isFullAccess && role !== 'approver') {
      return res.status(403).json({ success: false, message: 'Approver access required' });
    }
    const data = await svc.getApproverQueue(targetUserId, clientId, periodDef);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

async function getApproverStats(req, res) {
  try {
    const { clientId }              = req.params;
    const { role, isFullAccess, userId } = req.esgSummaryCtx;

    // null = "all users" when full-access admin doesn't specify a userId
    const targetUserId = isFullAccess ? (req.query.userId || null) : userId;
    if (!isFullAccess && role !== 'approver') {
      return res.status(403).json({ success: false, message: 'Approver access required' });
    }
    const data = await svc.getApproverStats(targetUserId, clientId);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

async function getApproverDecisionHistory(req, res) {
  try {
    const { clientId }              = req.params;
    const { role, isFullAccess, userId } = req.esgSummaryCtx;
    const periodDef                 = getPeriodParams(req);

    // null = "all users" when full-access admin doesn't specify a userId
    const targetUserId = isFullAccess ? (req.query.userId || null) : userId;
    if (!isFullAccess && role !== 'approver') {
      return res.status(403).json({ success: false, message: 'Approver access required' });
    }
    const data = await svc.getApproverDecisionHistory(targetUserId, clientId, periodDef);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

// =============================================================================
// GROUP 8 — Contributor Dashboard
// =============================================================================

async function getContributorSubmissions(req, res) {
  try {
    const { clientId }              = req.params;
    const { role, isFullAccess, userId } = req.esgSummaryCtx;
    // Build an updatedAt date-range filter from the selected year (if any).
    // We intentionally do NOT use period.year because the contributor's data
    // may represent historical fiscal years; we filter by when they submitted it.
    const year = parseInt(req.query.year, 10) || null;
    const updatedAtFilter = year
      ? { updatedAt: { $gte: new Date(year, 0, 1), $lt: new Date(year + 1, 0, 1) } }
      : {};

    // null = "all users" when full-access admin doesn't specify a userId
    const targetUserId = isFullAccess ? (req.query.userId || null) : userId;
    if (!isFullAccess && role !== 'contributor') {
      return res.status(403).json({ success: false, message: 'Contributor access required' });
    }
    const data = await svc.getContributorSubmissions(targetUserId, clientId, updatedAtFilter);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

async function getContributorCoverage(req, res) {
  try {
    const { clientId }              = req.params;
    const { role, isFullAccess, userId } = req.esgSummaryCtx;
    // Same updatedAt-based filter for coverage so counts stay consistent with submissions view
    const year = parseInt(req.query.year, 10) || null;
    const updatedAtFilter = year
      ? { updatedAt: { $gte: new Date(year, 0, 1), $lt: new Date(year + 1, 0, 1) } }
      : {};

    // null = "all users" when full-access admin doesn't specify a userId
    const targetUserId = isFullAccess ? (req.query.userId || null) : userId;
    if (!isFullAccess && role !== 'contributor') {
      return res.status(403).json({ success: false, message: 'Contributor access required' });
    }
    const data = await svc.getContributorCoverage(targetUserId, clientId, updatedAtFilter);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

async function getContributorPendingActions(req, res) {
  try {
    const { clientId }              = req.params;
    const { role, isFullAccess, userId } = req.esgSummaryCtx;

    // null = "all users" when full-access admin doesn't specify a userId
    const targetUserId = isFullAccess ? (req.query.userId || null) : userId;
    if (!isFullAccess && role !== 'contributor') {
      return res.status(403).json({ success: false, message: 'Contributor access required' });
    }
    const data = await svc.getContributorPendingActions(targetUserId, clientId);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

// =============================================================================
// GROUP 9 — Boundary Comparison
// =============================================================================

async function compareBoundaries(req, res) {
  try {
    const { clientId } = req.params;
    const periodDef    = getPeriodParams(req);
    let boundaryIds    = [];
    try { boundaryIds = JSON.parse(req.query.boundaryIds || '[]'); } catch { boundaryIds = []; }
    const data = await svc.compareBoundaries(clientId, periodDef, boundaryIds);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

// =============================================================================
// GROUP 10 — Scorecard & Report-Readiness
// =============================================================================

async function getEsgScorecard(req, res) {
  try {
    const { clientId } = req.params;
    const periodDef    = getPeriodParams(req);
    const data = await svc.getEsgScorecard(clientId, periodDef);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

async function getReportReadiness(req, res) {
  try {
    const { clientId } = req.params;
    const periodDef    = getPeriodParams(req);
    const data = await svc.getReportReadiness(clientId, periodDef);
    return ok(res, { data });
  } catch (err) { return handleErr(res, err); }
}

module.exports = {
  getBoundarySummary,
  getHierarchySummary,
  getDashboardSummary,
  getReviewerPendingSummary,
  getApproverPendingSummary,
  getMyViewSummary,
  refreshSummary,
  refreshAllPeriods,
  getAvailablePeriods,
  // Group 1
  getPortfolioDashboard,
  getClientHealthSummary,
  // Group 2
  comparePeriodsForClient,
  getTrendForClient,
  listAllClientPeriods,
  // Group 3
  getCategoryBreakdown,
  getTopBottomMetrics,
  // Group 4
  getMetricCoverage,
  getDataQualityStats,
  getMissingMetrics,
  // Group 5
  getWorkflowStatusCounts,
  getWorkflowAging,
  // Group 6
  getReviewerQueue,
  getReviewerStats,
  getReviewerAgingQueue,
  // Group 7
  getApproverQueue,
  getApproverStats,
  getApproverDecisionHistory,
  // Group 8
  getContributorSubmissions,
  getContributorCoverage,
  getContributorPendingActions,
  // Group 9
  compareBoundaries,
  // Group 10
  getEsgScorecard,
  getReportReadiness,
};
