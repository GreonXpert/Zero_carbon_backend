'use strict';

const svc = require('../services/summaryService');

function getPeriodYear(req) {
  const y = parseInt(req.query.year, 10);
  return isNaN(y) ? new Date().getFullYear() : y;
}

function ok(res, data) {
  return res.json({ success: true, ...data });
}

async function getBoundarySummary(req, res) {
  try {
    const { clientId, boundaryId } = req.params;
    const periodYear   = getPeriodYear(req);
    const { allowedLayers } = req.esgSummaryCtx;
    const forceRefresh = req.query.refresh === 'true';

    const data = await svc.getSummaryForUser(req.user, clientId, boundaryId, periodYear, { forceRefresh, allowedLayers });
    if (!data) return res.status(404).json({ success: false, message: 'Boundary or summary not found' });
    return ok(res, { data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

async function getHierarchySummary(req, res) {
  try {
    const { clientId, boundaryId } = req.params;
    const periodYear   = getPeriodYear(req);
    const forceRefresh = req.query.refresh === 'true';

    const data = await svc.getHierarchySummary(clientId, boundaryId, periodYear, { forceRefresh });
    if (!data) return res.status(404).json({ success: false, message: 'Boundary or summary not found' });
    return ok(res, { data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

async function getDashboardSummary(req, res) {
  try {
    const { clientId } = req.params;
    const periodYear   = getPeriodYear(req);
    const data = await svc.getDashboardSummary(clientId, periodYear);
    return ok(res, { data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

async function getReviewerPendingSummary(req, res) {
  try {
    const { clientId } = req.params;
    const periodYear   = getPeriodYear(req);
    const { role, isFullAccess, userId } = req.esgSummaryCtx;

    if (isFullAccess) {
      const EsgDataEntry = require('../../data-collection/models/EsgDataEntry');
      const entries = await EsgDataEntry.find({
        clientId, 'period.year': periodYear,
        workflowStatus: { $in: ['submitted', 'clarification_requested', 'resubmitted'] },
        isDeleted: false,
      }).lean();
      return ok(res, { data: { clientId, periodYear, pendingEntries: entries, count: entries.length } });
    }

    if (role !== 'reviewer') {
      return res.status(403).json({ success: false, message: 'Only reviewers can access reviewer-pending summary' });
    }
    const data = await svc.getReviewerPendingForReviewer(userId, clientId, periodYear);
    return ok(res, { data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

async function getApproverPendingSummary(req, res) {
  try {
    const { clientId } = req.params;
    const periodYear   = getPeriodYear(req);
    const { role, isFullAccess, userId } = req.esgSummaryCtx;

    if (isFullAccess) {
      const EsgDataEntry = require('../../data-collection/models/EsgDataEntry');
      const entries = await EsgDataEntry.find({
        clientId, 'period.year': periodYear,
        workflowStatus:    'under_review',
        approvalDecisions: { $exists: true, $not: { $size: 0 } },
        isDeleted:         false,
      }).lean();
      return ok(res, { data: { clientId, periodYear, pendingEntries: entries, count: entries.length } });
    }

    if (role !== 'approver') {
      return res.status(403).json({ success: false, message: 'Only approvers can access approver-pending summary' });
    }
    const data = await svc.getApproverPendingForApprover(userId, clientId, periodYear);
    return ok(res, { data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

async function getMyViewSummary(req, res) {
  try {
    const { clientId } = req.params;
    const periodYear   = getPeriodYear(req);
    const data = await svc.getMyViewSummary(req.user, clientId, periodYear);
    return ok(res, { data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

async function refreshSummary(req, res) {
  try {
    const { clientId, boundaryId } = req.params;
    const { isFullAccess } = req.esgSummaryCtx;

    if (!isFullAccess) {
      return res.status(403).json({ success: false, message: 'Only admin or consultant can trigger manual refresh' });
    }

    const periodYear = getPeriodYear(req);
    const doc = await svc.computeAndSaveSummary(clientId, boundaryId, periodYear);
    if (!doc) return res.status(404).json({ success: false, message: 'Boundary not found' });

    if (global.broadcastEsgSummaryUpdate) {
      global.broadcastEsgSummaryUpdate(clientId, boundaryId, 'full_refresh', { periodYear });
    }

    return ok(res, { data: { lastComputedAt: doc.lastComputedAt, totalEntries: doc.totalEntries } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = {
  getBoundarySummary,
  getHierarchySummary,
  getDashboardSummary,
  getReviewerPendingSummary,
  getApproverPendingSummary,
  getMyViewSummary,
  refreshSummary,
};
