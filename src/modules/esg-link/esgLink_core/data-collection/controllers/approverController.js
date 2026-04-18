'use strict';

const EsgDataEntry    = require('../models/EsgDataEntry');
const workflowService = require('../services/workflowService');

// ── GET /:clientId/approval-queue ─────────────────────────────────────────────
async function getApprovalQueue(req, res) {
  try {
    const { clientId } = req.params;
    const accessCtx    = req.submissionAccessCtx;

    const query = {
      clientId,
      isDeleted:      false,
      workflowStatus: 'under_review',
    };

    if (!accessCtx.isFullAccess && accessCtx.assignedMappingIds) {
      query.mappingId = { $in: Array.from(accessCtx.assignedMappingIds) };
    }

    if (req.query.nodeId) query.nodeId = req.query.nodeId;

    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip  = (page - 1) * limit;

    const [submissions, total] = await Promise.all([
      EsgDataEntry.find(query)
        .populate('submittedBy', 'userName email')
        .populate('metricId', 'metricName metricCode')
        .sort({ submittedAt: 1 })
        .skip(skip)
        .limit(limit),
      EsgDataEntry.countDocuments(query),
    ]);

    // Enrich with current approval percentage
    const enriched = submissions.map((s) => {
      const total    = s.approvalDecisions.length;
      const approved = s.approvalDecisions.filter((d) => d.decision === 'approved').length;
      const pct      = total > 0 ? Math.round((approved / total) * 100) : 0;
      return { ...s.toObject(), approvalPercentage: pct };
    });

    return res.json({ success: true, data: { submissions: enriched, total, page, limit } });
  } catch (err) {
    console.error('[approverController.getApprovalQueue]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── POST /:clientId/submissions/:submissionId/approve ─────────────────────────
async function approve(req, res) {
  try {
    const { clientId, submissionId } = req.params;
    const actor = req.user;
    const { note } = req.body || {};

    const result = await workflowService.recordApproverDecision(
      submissionId,
      actor._id || actor.id,
      'approved',
      note,
      { clientId, actor, req }
    );

    if (result.error) {
      return res.status(result.status || 422).json({ success: false, message: result.error });
    }

    const { approvalPct, finalStatus, consultantFastTrack } = result;

    const message =
      finalStatus === 'approved'
        ? `Approval threshold reached${consultantFastTrack ? ' (consultant fast-track)' : ''}. Submission approved.`
        : `Decision recorded. Waiting for additional approvers. Current approval: ${approvalPct.toFixed(0)}%`;

    return res.json({
      success: true,
      data: { approvalPercentage: Math.round(approvalPct), workflowStatus: finalStatus },
      message,
    });
  } catch (err) {
    console.error('[approverController.approve]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── POST /:clientId/submissions/:submissionId/reject ──────────────────────────
async function reject(req, res) {
  try {
    const { clientId, submissionId } = req.params;
    const actor = req.user;
    const { note } = req.body || {};

    if (!note) {
      return res.status(400).json({ success: false, message: 'Rejection note is required' });
    }

    const result = await workflowService.recordApproverDecision(
      submissionId,
      actor._id || actor.id,
      'rejected',
      note,
      { clientId, actor, req }
    );

    if (result.error) {
      return res.status(result.status || 422).json({ success: false, message: result.error });
    }

    const { rejectionPct, finalStatus } = result;
    const message =
      finalStatus === 'rejected'
        ? 'Rejection threshold reached. Submission rejected.'
        : `Rejection decision recorded. Current rejection: ${rejectionPct.toFixed(0)}%`;

    return res.json({
      success: true,
      data: { rejectionPercentage: Math.round(rejectionPct), workflowStatus: finalStatus },
      message,
    });
  } catch (err) {
    console.error('[approverController.reject]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

module.exports = { getApprovalQueue, approve, reject };
