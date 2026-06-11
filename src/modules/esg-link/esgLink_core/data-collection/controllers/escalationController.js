'use strict';

const EsgDataEntry    = require('../models/EsgDataEntry');
const EsgLinkBoundary = require('../../boundary/models/EsgLinkBoundary');
const { checkEsgReviewerApproverEscalations } = require('../../workflow/jobs/esgReviewerApproverEscalationChecker');

// ── GET /:clientId/escalations ────────────────────────────────────────────────
// Lists submissions currently flagged as escalated (isEscalated: true).
// Optional query: ?stage=review|approval, ?nodeId=...
async function getEscalationQueue(req, res) {
  try {
    const { clientId } = req.params;
    const accessCtx    = req.submissionAccessCtx;

    const query = {
      clientId,
      isDeleted:   false,
      isEscalated: true,
    };

    if (req.query.stage && ['review', 'approval'].includes(req.query.stage)) {
      query.escalationStage = req.query.stage;
    }
    if (req.query.nodeId && req.query.nodeId !== 'undefined') query.nodeId = req.query.nodeId;

    if (!accessCtx.isFullAccess && accessCtx.assignedMappingIds) {
      query.mappingId = { $in: Array.from(accessCtx.assignedMappingIds) };
    }

    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip  = (page - 1) * limit;

    const [[submissions, total], boundary] = await Promise.all([
      Promise.all([
        EsgDataEntry.find(query)
          .populate('submittedBy', 'userName email')
          .populate('metricId', 'metricName metricCode')
          .sort({ escalatedAt: -1 })
          .skip(skip)
          .limit(limit),
        EsgDataEntry.countDocuments(query),
      ]),
      EsgLinkBoundary.findOne({ clientId, isActive: true, isDeleted: false }).select('nodes slaConfig').lean(),
    ]);

    const nodeLabelMap = {};
    for (const node of boundary?.nodes || []) {
      nodeLabelMap[node.id] = node.label;
    }

    const enriched = submissions.map((s) => ({
      ...s.toObject(),
      metricDetails:   { metricName: s.metricId?.metricName || '', metricCode: s.metricId?.metricCode || '' },
      nodeDetails:     { label: nodeLabelMap[s.nodeId] || s.nodeId || '' },
      contributorName: s.submittedBy?.userName || s.submittedBy?.email || '',
    }));

    return res.json({
      success: true,
      data: {
        submissions: enriched,
        total,
        page,
        limit,
        slaConfig: boundary?.slaConfig || {},
      },
    });
  } catch (err) {
    console.error('[escalationController.getEscalationQueue]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── POST /:clientId/escalations/run-check ─────────────────────────────────────
// Manually runs the SLA escalation check for this client (bypasses the daily
// cron — useful for testing/admin troubleshooting). Restricted to full-access
// roles (super_admin / consultant_admin / consultant).
async function runEscalationCheck(req, res) {
  try {
    const { clientId } = req.params;
    const accessCtx    = req.submissionAccessCtx;

    if (!accessCtx.isFullAccess) {
      return res.status(403).json({ success: false, message: 'Not authorized to run escalation checks' });
    }

    const result = await checkEsgReviewerApproverEscalations({ clientId });

    return res.json({
      success: true,
      data: result,
      message: `Checked ${result.checked} submission(s); escalated ${result.escalated}.`,
    });
  } catch (err) {
    console.error('[escalationController.runEscalationCheck]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

module.exports = { getEscalationQueue, runEscalationCheck };
