'use strict';

const workflowService = require('../services/workflowService');
const { canComment, canReply } = require('../utils/submissionPermissions');

// ── GET /:clientId/submissions/:submissionId/thread ───────────────────────────
async function getThread(req, res) {
  try {
    const { clientId, submissionId } = req.params;

    const result = await workflowService.getThread(submissionId, clientId);
    if (result.error) {
      return res.status(result.status || 404).json({ success: false, message: result.error });
    }

    return res.json({ success: true, data: result.thread });
  } catch (err) {
    console.error('[threadController.getThread]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── POST /:clientId/submissions/:submissionId/thread/comment ──────────────────
// Reviewer or approver adds a comment (does NOT change workflowStatus)
async function addComment(req, res) {
  try {
    const { clientId, submissionId } = req.params;
    const actor = req.user;
    const { text } = req.body || {};

    if (!text) {
      return res.status(400).json({ success: false, message: 'Comment text is required' });
    }

    const { reviewers, approvers, mapping } = await workflowService.resolveAssignees(
      { _id: submissionId, nodeId: req.body.nodeId, mappingId: req.body.mappingId, boundaryDocId: req.body.boundaryDocId }
    );

    // Load submission to get correct nodeId/mappingId
    const EsgDataEntry = require('../models/EsgDataEntry');
    const submission = await EsgDataEntry.findOne({ _id: submissionId, clientId, isDeleted: false });
    if (!submission) {
      return res.status(404).json({ success: false, message: 'Submission not found' });
    }

    const assignees = await workflowService.resolveAssignees(submission);

    if (!canComment(actor, assignees.mapping, assignees.reviewers, assignees.approvers, clientId)) {
      return res.status(403).json({ success: false, message: 'Only reviewers and approvers can add comments' });
    }

    // Determine message type based on actor role
    const type = actor.userType === 'approver' || actor.userType === 'consultant_admin'
      ? 'approver_note'
      : 'reviewer_followup';

    const result = await workflowService.addThreadMessage(submissionId, clientId, {
      type,
      authorId:   actor._id || actor.id,
      authorType: actor.userType,
      text,
      attachments: req.body?.attachments || [],
    });

    if (result.error) {
      return res.status(result.status || 400).json({ success: false, message: result.error });
    }

    return res.json({ success: true, data: result.message });
  } catch (err) {
    console.error('[threadController.addComment]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── POST /:clientId/submissions/:submissionId/thread/reply ────────────────────
// Contributor replies to a clarification (does NOT change workflowStatus — use /resubmit to resubmit)
async function reply(req, res) {
  try {
    const { clientId, submissionId } = req.params;
    const actor = req.user;
    const { text } = req.body || {};

    if (!text) {
      return res.status(400).json({ success: false, message: 'Reply text is required' });
    }

    const EsgDataEntry = require('../models/EsgDataEntry');
    const submission = await EsgDataEntry.findOne({ _id: submissionId, clientId, isDeleted: false });
    if (!submission) {
      return res.status(404).json({ success: false, message: 'Submission not found' });
    }

    const assignees = await workflowService.resolveAssignees(submission);

    if (!canReply(actor, assignees.mapping, clientId)) {
      return res.status(403).json({ success: false, message: 'Only contributors can reply' });
    }

    const result = await workflowService.addThreadMessage(submissionId, clientId, {
      type:       'contributor_reply',
      authorId:   actor._id || actor.id,
      authorType: actor.userType,
      text,
      attachments: req.body?.attachments || [],
    });

    if (result.error) {
      return res.status(result.status || 400).json({ success: false, message: result.error });
    }

    return res.json({ success: true, data: result.message });
  } catch (err) {
    console.error('[threadController.reply]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

module.exports = { getThread, addComment, reply };
