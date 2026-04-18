'use strict';

const EsgDataEntry        = require('../models/EsgDataEntry');
const workflowService     = require('../services/workflowService');

// ── GET /:clientId/review-queue ───────────────────────────────────────────────
async function getReviewQueue(req, res) {
  try {
    const { clientId } = req.params;
    const actor        = req.user;
    const accessCtx    = req.submissionAccessCtx;

    const query = {
      clientId,
      isDeleted:      false,
      workflowStatus: { $in: ['submitted', 'resubmitted'] },
    };

    // Restrict to assigned mappings for reviewer role
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
        .sort({ submittedAt: 1 }) // oldest first — review FIFO
        .skip(skip)
        .limit(limit),
      EsgDataEntry.countDocuments(query),
    ]);

    return res.json({ success: true, data: { submissions, total, page, limit } });
  } catch (err) {
    console.error('[reviewerController.getReviewQueue]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── POST /:clientId/submissions/:submissionId/clarify ─────────────────────────
async function requestClarification(req, res) {
  try {
    const { clientId, submissionId } = req.params;
    const actor = req.user;
    const { text, note } = req.body || {};

    if (!text) {
      return res.status(400).json({ success: false, message: 'Clarification text is required' });
    }

    const result = await workflowService.transition(
      submissionId,
      'clarification_requested',
      actor,
      {
        clientId,
        note,
        threadMessage: { text, attachments: req.body?.attachments || [] },
        req,
      }
    );

    if (result.error) {
      return res.status(result.status || 422).json({ success: false, message: result.error });
    }

    return res.json({
      success: true,
      data: {
        workflowStatus: result.doc.workflowStatus,
      },
      message: 'Clarification requested. Contributor has been notified.',
    });
  } catch (err) {
    console.error('[reviewerController.requestClarification]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── POST /:clientId/submissions/:submissionId/review-pass ─────────────────────
async function reviewPass(req, res) {
  try {
    const { clientId, submissionId } = req.params;
    const actor = req.user;
    const { note } = req.body || {};

    const result = await workflowService.transition(submissionId, 'under_review', actor, {
      clientId,
      note,
      req,
    });

    if (result.error) {
      return res.status(result.status || 422).json({ success: false, message: result.error });
    }

    return res.json({
      success: true,
      data: { workflowStatus: result.doc.workflowStatus },
      message: 'Submission passed to approvers',
    });
  } catch (err) {
    console.error('[reviewerController.reviewPass]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

module.exports = { getReviewQueue, requestClarification, reviewPass };
