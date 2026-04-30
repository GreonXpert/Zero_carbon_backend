'use strict';
/**
 * metricApprovalController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handlers for the super_admin approval queue for global metric changes.
 *
 * Endpoints (all super_admin only):
 *   GET  /metrics/approvals                      → listMetricApprovals
 *   GET  /metrics/approvals/:approvalId          → getMetricApproval
 *   POST /metrics/approvals/:approvalId/approve  → approveMetricChange
 *   POST /metrics/approvals/:approvalId/reject   → rejectMetricChange
 */

const mongoose        = require('mongoose');
const EsgMetricApproval = require('../models/EsgMetricApproval');
const { canApproveMetricChange } = require('../utils/metricPermissions');
const {
  executeApprovedAction,
  getPendingApprovals,
} = require('../services/metricApprovalService');
const { logEventFireAndForget } = require('../../../../../common/services/audit/auditLogService');

// ── Shared guard ───────────────────────────────────────────────────────────────

const _guardSuperAdmin = (user, res) => {
  const perm = canApproveMetricChange(user);
  if (perm.allowed) return false;
  res.status(403).json({ message: 'Permission denied', reason: perm.reason });
  return true;
};

// ── 1. listMetricApprovals ─────────────────────────────────────────────────────

const listMetricApprovals = async (req, res) => {
  try {
    const user = req.user;
    const isSuperAdmin      = user.userType === 'super_admin';
    const isConsultantAdmin = user.userType === 'consultant_admin';

    if (!isSuperAdmin && !isConsultantAdmin) {
      return res.status(403).json({ message: 'Permission denied', reason: 'Only super_admin or consultant_admin can view approval requests' });
    }

    const status     = req.query.status     || 'pending';
    const actionType = req.query.actionType || undefined;
    const page       = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit      = Math.min(100, parseInt(req.query.limit, 10) || 20);

    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({
        message: "status must be one of: pending, approved, rejected",
        code:    'INVALID_STATUS_FILTER',
      });
    }

    // consultant_admin sees only their own requests; super_admin sees all
    const requestedByFilter = isConsultantAdmin ? user._id : undefined;

    const { total, approvals } = await getPendingApprovals({ status, actionType, page, limit, requestedByFilter });

    return res.status(200).json({ total, page, limit, approvals });
  } catch (err) {
    console.error('[metricApprovalController] listMetricApprovals error:', err);
    return res.status(500).json({ message: 'Internal server error', code: 'SERVER_ERROR' });
  }
};

// ── 2. getMetricApproval ───────────────────────────────────────────────────────

const getMetricApproval = async (req, res) => {
  try {
    if (_guardSuperAdmin(req.user, res)) return;

    const { approvalId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(approvalId)) {
      return res.status(400).json({ message: 'Invalid approvalId', code: 'INVALID_ID' });
    }

    const approval = await EsgMetricApproval.findById(approvalId)
      .populate('requestedBy', 'name email userType')
      .populate('reviewedBy',  'name email userType')
      .populate('metricId',    'metricCode metricName esgCategory subcategoryCode publishedStatus version')
      .lean();

    if (!approval) {
      return res.status(404).json({ message: 'Approval request not found', code: 'APPROVAL_NOT_FOUND' });
    }

    return res.status(200).json({ approval });
  } catch (err) {
    console.error('[metricApprovalController] getMetricApproval error:', err);
    return res.status(500).json({ message: 'Internal server error', code: 'SERVER_ERROR' });
  }
};

// ── 3. approveMetricChange ─────────────────────────────────────────────────────

const approveMetricChange = async (req, res) => {
  try {
    if (_guardSuperAdmin(req.user, res)) return;

    const { approvalId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(approvalId)) {
      return res.status(400).json({ message: 'Invalid approvalId', code: 'INVALID_ID' });
    }

    const approval = await EsgMetricApproval.findById(approvalId);
    if (!approval) {
      return res.status(404).json({ message: 'Approval request not found', code: 'APPROVAL_NOT_FOUND' });
    }
    if (approval.status !== 'pending') {
      return res.status(400).json({
        message: `Approval request is already '${approval.status}'. Only pending requests can be approved.`,
        code:    'ALREADY_REVIEWED',
      });
    }

    // Execute the deferred action
    let resultMetric;
    try {
      resultMetric = await executeApprovedAction(approval, req.user);
    } catch (execErr) {
      if (execErr.code === 'METRIC_NOT_FOUND') {
        return res.status(404).json({ message: execErr.message, code: 'METRIC_NOT_FOUND' });
      }
      throw execErr;
    }

    // Mark approval as approved
    approval.status     = 'approved';
    approval.reviewedBy = req.user._id;
    approval.reviewedAt = new Date();
    await approval.save();

    logEventFireAndForget({
      req,
      module:        'esg_metric',
      action:        'approve',
      subAction:     `metric_${approval.actionType}_approved`,
      entityType:    'EsgMetricApproval',
      entityId:      approval._id.toString(),
      clientId:      null,
      changeSummary: `super_admin approved '${approval.actionType}' request (approvalId: ${approval._id})`,
      metadata:      { actionType: approval.actionType, metricId: approval.metricId },
      severity:      'info',
      status:        'success',
    });

    const response = {
      message:    `Metric '${approval.actionType}' approved and executed successfully`,
      approvalId: approval._id,
      actionType: approval.actionType,
      reviewedAt: approval.reviewedAt,
    };

    if (resultMetric) {
      response.metric = {
        _id:             resultMetric._id,
        metricCode:      resultMetric.metricCode,
        metricName:      resultMetric.metricName,
        publishedStatus: resultMetric.publishedStatus,
        version:         resultMetric.version,
      };
    } else {
      // delete action — no metric to return
      response.note = 'Metric has been soft-deleted';
    }

    return res.status(200).json(response);
  } catch (err) {
    console.error('[metricApprovalController] approveMetricChange error:', err);
    return res.status(500).json({ message: 'Internal server error', code: 'SERVER_ERROR' });
  }
};

// ── 4. rejectMetricChange ──────────────────────────────────────────────────────

const rejectMetricChange = async (req, res) => {
  try {
    if (_guardSuperAdmin(req.user, res)) return;

    const { approvalId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(approvalId)) {
      return res.status(400).json({ message: 'Invalid approvalId', code: 'INVALID_ID' });
    }

    const { rejectionReason } = req.body;
    if (!rejectionReason || !rejectionReason.trim()) {
      return res.status(400).json({
        message: 'rejectionReason is required when rejecting a request',
        code:    'MISSING_REJECTION_REASON',
      });
    }

    const approval = await EsgMetricApproval.findById(approvalId);
    if (!approval) {
      return res.status(404).json({ message: 'Approval request not found', code: 'APPROVAL_NOT_FOUND' });
    }
    if (approval.status !== 'pending') {
      return res.status(400).json({
        message: `Approval request is already '${approval.status}'. Only pending requests can be rejected.`,
        code:    'ALREADY_REVIEWED',
      });
    }

    approval.status          = 'rejected';
    approval.reviewedBy      = req.user._id;
    approval.reviewedAt      = new Date();
    approval.rejectionReason = rejectionReason.trim();
    await approval.save();

    logEventFireAndForget({
      req,
      module:        'esg_metric',
      action:        'reject',
      subAction:     `metric_${approval.actionType}_rejected`,
      entityType:    'EsgMetricApproval',
      entityId:      approval._id.toString(),
      clientId:      null,
      changeSummary: `super_admin rejected '${approval.actionType}' request (approvalId: ${approval._id}): ${rejectionReason}`,
      metadata:      { actionType: approval.actionType, metricId: approval.metricId, rejectionReason },
      severity:      'warning',
      status:        'success',
    });

    return res.status(200).json({
      message:         `Metric '${approval.actionType}' request rejected`,
      approvalId:      approval._id,
      actionType:      approval.actionType,
      rejectionReason: approval.rejectionReason,
      reviewedAt:      approval.reviewedAt,
    });
  } catch (err) {
    console.error('[metricApprovalController] rejectMetricChange error:', err);
    return res.status(500).json({ message: 'Internal server error', code: 'SERVER_ERROR' });
  }
};

module.exports = {
  listMetricApprovals,
  getMetricApproval,
  approveMetricChange,
  rejectMetricChange,
};
