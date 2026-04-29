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
};
