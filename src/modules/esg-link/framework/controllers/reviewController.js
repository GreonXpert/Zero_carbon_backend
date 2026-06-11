'use strict';

const DisclosureAnswer   = require('../models/DisclosureAnswer.model');
const EsgReviewComment   = require('../models/ReviewComment.model');
const QuestionAssignment = require('../models/QuestionAssignment.model');
const { canReviewAnswer, canApproveAnswer } = require('../services/frameworkAccessService');
const { validateTransition }               = require('../services/workflowStateService');
const { emitEsgClientEvent, emitEsgUserEvent } = require('../../esgLink_core/summary/utils/esgSummarySocket');
const { logEventFireAndForget } = require('../../../../common/services/audit/auditLogService');

// ── Socket helpers ────────────────────────────────────────────────────────────

function _emitCommentAdded(answer, comment, targetUserIds = [], actor = null) {
  const payload = {
    answerId:    String(answer._id || answer.answerId || ''),
    questionId:  String(answer.questionId),
    clientId:    String(answer.clientId),
    comment: {
      _id:           String(comment._id),
      commentText:   comment.commentText,
      commentType:   comment.commentType,
      commentByRole: comment.commentByRole,
      // Embed userName so the frontend can display the name without a second DB lookup
      commentBy:     actor
        ? { _id: String(actor._id), userName: actor.userName, email: actor.email }
        : comment.commentBy,
      createdAt:     comment.createdAt,
    },
  };
  emitEsgClientEvent(String(answer.clientId), 'brsr:commentAdded', payload);
  targetUserIds.filter(Boolean).forEach((uid) =>
    emitEsgUserEvent(String(uid), 'brsr:commentAdded', payload)
  );
}

function _emitStatusChanged(answer, fromStatus, toStatus, actor, targetUserIds = []) {
  const payload = {
    answerId:      String(answer._id || answer.answerId || ''),
    questionId:    String(answer.questionId),
    clientId:      String(answer.clientId),
    fromStatus,
    toStatus,
    changedBy:     String(actor._id),
    changedByRole: actor.userType,
  };
  emitEsgClientEvent(String(answer.clientId), 'brsr:answerStatusChanged', payload);
  targetUserIds.filter(Boolean).forEach((uid) =>
    emitEsgUserEvent(String(uid), 'brsr:answerStatusChanged', payload)
  );
}

// ── Helper ────────────────────────────────────────────────────────────────────

const _transition = async (res, answerId, targetStatus, actor, extraUpdate = {}) => {
  const answer = await DisclosureAnswer.findById(answerId);
  if (!answer) { res.status(404).json({ message: 'Answer not found' }); return null; }

  const t = validateTransition(answer.status, targetStatus, actor.userType);
  if (!t.valid) { res.status(400).json({ message: t.reason }); return null; }

  Object.assign(answer, extraUpdate);
  answer.status    = targetStatus;
  answer.updatedBy = actor._id;
  await answer.save();
  return answer.toObject();
};

// ── Reviewer actions ──────────────────────────────────────────────────────────

const reviewerComment = async (req, res) => {
  try {
    const perm = canReviewAnswer(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { answerId } = req.params;
    const { commentText, commentType, commentTo, commentToRole } = req.body;
    if (!commentText) return res.status(400).json({ message: 'commentText is required' });

    const answer = await DisclosureAnswer.findById(answerId).lean();
    if (!answer) return res.status(404).json({ message: 'Answer not found' });

    const comment = await EsgReviewComment.create({
      answerId,
      questionId:    answer.questionId,
      clientId:      answer.clientId,
      periodId:      answer.periodId,
      frameworkId:   answer.frameworkId,
      frameworkCode: answer.frameworkCode,
      commentBy:     req.user._id,
      commentByRole: req.user.userType,
      commentTo:     commentTo     || null,
      commentToRole: commentToRole || null,
      commentText,
      commentType:   commentType   || 'reviewer_comment',
      status:        'open',
    });

    _emitCommentAdded(answer, comment, [answer.contributorId, commentTo], req.user);

    return res.status(201).json({ success: true, message: 'Comment added', data: comment });
  } catch (err) {
    console.error('[reviewController] reviewerComment:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const reviewerApprove = async (req, res) => {
  try {
    const perm = canReviewAnswer(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const fromStatus = (await DisclosureAnswer.findById(req.params.answerId, 'status').lean())?.status;
    const answer = await _transition(res, req.params.answerId, 'reviewer_approved', req.user, {
      reviewedAt: new Date(),
      reviewerId: req.user._id,
    });
    if (!answer) return; // response already sent

    _emitStatusChanged(answer, fromStatus, 'reviewer_approved', req.user, [answer.contributorId]);

    return res.status(200).json({ success: true, message: 'Answer reviewer-approved', data: answer });
  } catch (err) {
    console.error('[reviewController] reviewerApprove:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const reviewerRequestChanges = async (req, res) => {
  try {
    const perm = canReviewAnswer(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { commentText } = req.body;
    if (!commentText) return res.status(400).json({ message: 'commentText is required' });

    const answer = await DisclosureAnswer.findById(req.params.answerId);
    if (!answer) return res.status(404).json({ message: 'Answer not found' });

    const t = validateTransition(answer.status, 'reviewer_changes_requested', req.user.userType);
    if (!t.valid) return res.status(400).json({ message: t.reason });

    await EsgReviewComment.create({
      answerId:      answer._id,
      questionId:    answer.questionId,
      clientId:      answer.clientId,
      periodId:      answer.periodId,
      frameworkId:   answer.frameworkId,
      frameworkCode: answer.frameworkCode,
      commentBy:     req.user._id,
      commentByRole: req.user.userType,
      commentText,
      commentType:   'reviewer_comment',
      status:        'open',
    });

    const prevStatus = answer.status;
    answer.status    = 'reviewer_changes_requested';
    answer.updatedBy = req.user._id;
    await answer.save();

    _emitCommentAdded(answer, { _id: answer._id, commentText, commentType: 'reviewer_comment', commentByRole: req.user.userType, commentBy: req.user._id, createdAt: new Date() }, [answer.contributorId], req.user);
    _emitStatusChanged(answer, prevStatus, 'reviewer_changes_requested', req.user, [answer.contributorId]);

    return res.status(200).json({ success: true, message: 'Changes requested from contributor', data: answer });
  } catch (err) {
    console.error('[reviewController] reviewerRequestChanges:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const submitToApprover = async (req, res) => {
  try {
    const perm = canReviewAnswer(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const answer = await DisclosureAnswer.findById(req.params.answerId);
    if (!answer) return res.status(404).json({ message: 'Answer not found' });

    const fromSt = answer.status;

    // If reviewer is responding to an approver query or acknowledging contributor
    // clarification, first move through reviewer_response_pending before landing
    // on submitted_to_approver
    if (['approver_query_to_reviewer', 'contributor_clarification_submitted'].includes(answer.status)) {
      const t1 = validateTransition(answer.status, 'reviewer_response_pending', req.user.userType);
      if (!t1.valid) return res.status(400).json({ message: t1.reason });
      answer.status = 'reviewer_response_pending';
    }

    const t2 = validateTransition(answer.status, 'submitted_to_approver', req.user.userType);
    if (!t2.valid) return res.status(400).json({ message: t2.reason });

    // Stamp reviewerId / approverId from the linked assignment so the approver
    // can query their queue directly by answer.approverId
    if (!answer.reviewerId || !answer.approverId) {
      const assignment = await QuestionAssignment.findOne(
        { clientId: answer.clientId, periodId: answer.periodId, questionId: answer.questionId },
        { reviewerId: 1, approverId: 1 }
      ).lean();
      if (assignment) {
        if (!answer.reviewerId && assignment.reviewerId) answer.reviewerId = assignment.reviewerId;
        if (!answer.approverId && assignment.approverId) answer.approverId = assignment.approverId;
      }
    }

    answer.status    = 'submitted_to_approver';
    answer.updatedBy = req.user._id;
    await answer.save();

    const answerObj = answer.toObject();
    _emitStatusChanged(answerObj, fromSt, 'submitted_to_approver', req.user, [answer.approverId]);

    return res.status(200).json({ success: true, message: 'Answer submitted to approver', data: answerObj });
  } catch (err) {
    console.error('[reviewController] submitToApprover:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const requestContributorClarification = async (req, res) => {
  try {
    const perm = canReviewAnswer(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { commentText } = req.body;
    if (!commentText) return res.status(400).json({ message: 'commentText is required' });

    const answer = await DisclosureAnswer.findById(req.params.answerId);
    if (!answer) return res.status(404).json({ message: 'Answer not found' });

    const t = validateTransition(answer.status, 'contributor_clarification_required', req.user.userType);
    if (!t.valid) return res.status(400).json({ message: t.reason });

    await EsgReviewComment.create({
      answerId:      answer._id,
      questionId:    answer.questionId,
      clientId:      answer.clientId,
      periodId:      answer.periodId,
      frameworkId:   answer.frameworkId,
      frameworkCode: answer.frameworkCode,
      commentBy:     req.user._id,
      commentByRole: req.user.userType,
      commentText,
      commentType:   'reviewer_comment',
      status:        'open',
    });

    const prevSt = answer.status;
    answer.status    = 'contributor_clarification_required';
    answer.updatedBy = req.user._id;
    await answer.save();

    _emitCommentAdded(answer, { _id: answer._id, commentText, commentType: 'reviewer_comment', commentByRole: req.user.userType, commentBy: req.user._id, createdAt: new Date() }, [answer.contributorId], req.user);
    _emitStatusChanged(answer, prevSt, 'contributor_clarification_required', req.user, [answer.contributorId]);

    return res.status(200).json({ success: true, message: 'Clarification requested from contributor', data: answer });
  } catch (err) {
    console.error('[reviewController] requestContributorClarification:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// ── Approver actions ──────────────────────────────────────────────────────────

const approverQuery = async (req, res) => {
  try {
    const perm = canApproveAnswer(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { commentText } = req.body;
    if (!commentText) return res.status(400).json({ message: 'commentText is required' });

    const answer = await DisclosureAnswer.findById(req.params.answerId).lean();
    if (!answer) return res.status(404).json({ message: 'Answer not found' });

    // Query is treated as a comment — it does NOT change the answer status.
    // This allows the approver to post questions to the reviewer while
    // still being able to Final Approve at any time.
    const comment = await EsgReviewComment.create({
      answerId:      answer._id,
      questionId:    answer.questionId,
      clientId:      answer.clientId,
      periodId:      answer.periodId,
      frameworkId:   answer.frameworkId,
      frameworkCode: answer.frameworkCode,
      commentBy:     req.user._id,
      commentByRole: req.user.userType,
      commentText,
      commentType:   'approver_query',
      status:        'open',
    });

    // Notify reviewer about the new query comment
    _emitCommentAdded(answer, comment, [answer.reviewerId], req.user);

    return res.status(201).json({ success: true, message: 'Query sent to reviewer', data: comment });
  } catch (err) {
    console.error('[reviewController] approverQuery:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const approverApprove = async (req, res) => {
  try {
    const perm = canApproveAnswer(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const fromStF = (await DisclosureAnswer.findById(req.params.answerId, 'status').lean())?.status;
    const answer = await _transition(res, req.params.answerId, 'final_approved', req.user, {
      approvedAt: new Date(),
      approverId: req.user._id,
    });
    if (!answer) return;

    _emitStatusChanged(answer, fromStF, 'final_approved', req.user, [answer.contributorId, answer.reviewerId]);

    return res.status(200).json({ success: true, message: 'Answer final-approved', data: answer });
  } catch (err) {
    console.error('[reviewController] approverApprove:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const approverDecline = async (req, res) => {
  try {
    const perm = canApproveAnswer(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { declineReason } = req.body;
    if (!declineReason || !declineReason.trim()) {
      return res.status(400).json({ message: 'declineReason is required' });
    }

    const fromStatus = (await DisclosureAnswer.findById(req.params.answerId, 'status').lean())?.status;

    const answer = await _transition(res, req.params.answerId, 'approver_declined', req.user, {
      declinedAt: new Date(),
    });
    if (!answer) return;

    // Record decline reason as a comment so it is visible in the thread
    await EsgReviewComment.create({
      answerId:      answer._id,
      questionId:    answer.questionId,
      clientId:      answer.clientId,
      periodId:      answer.periodId,
      frameworkId:   answer.frameworkId,
      frameworkCode: answer.frameworkCode,
      commentBy:     req.user._id,
      commentByRole: req.user.userType,
      commentText:   declineReason.trim(),
      commentType:   'approver_decline',
      status:        'open',
    });

    // Audit trail
    logEventFireAndForget({
      req,
      actor:         req.user,
      module:        'esg_link',
      action:        'other',
      subAction:     'approver_declined',
      entityType:    'DisclosureAnswer',
      entityId:      String(answer._id),
      clientId:      answer.clientId,
      changeSummary: `Approver declined answer ${answer.questionCode || answer._id}. Reason: "${declineReason.trim()}". Process reset — contributor must restart from the beginning.`,
      metadata: {
        fromStatus,
        toStatus:      'approver_declined',
        declineReason: declineReason.trim(),
        questionCode:  answer.questionCode,
        questionId:    String(answer.questionId),
      },
    });

    _emitStatusChanged(answer, fromStatus, 'approver_declined', req.user, [
      answer.contributorId,
      answer.assignedContributor,
      answer.reviewerId,
    ]);

    return res.status(200).json({
      success: true,
      message: 'Answer declined. Contributor must restart the process from the beginning.',
      data:    answer,
    });
  } catch (err) {
    console.error('[reviewController] approverDecline:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// ── Comment thread actions ────────────────────────────────────────────────────

const replyToComment = async (req, res) => {
  try {
    const { commentId } = req.params;
    const parent = await EsgReviewComment.findById(commentId).lean();
    if (!parent) return res.status(404).json({ message: 'Comment not found' });

    const { commentText, commentType } = req.body;
    if (!commentText) return res.status(400).json({ message: 'commentText is required' });

    const reply = await EsgReviewComment.create({
      answerId:       parent.answerId,
      questionId:     parent.questionId,
      clientId:       parent.clientId,
      periodId:       parent.periodId,
      frameworkId:    parent.frameworkId,
      frameworkCode:  parent.frameworkCode,
      commentBy:      req.user._id,
      commentByRole:  req.user.userType,
      commentText,
      commentType:    commentType || 'contributor_reply',
      parentCommentId: commentId,
      status:          'open',
    });

    _emitCommentAdded(parent, reply, [parent.commentBy], req.user);

    // When a contributor replies to a clarification-required answer, auto-transition
    // the answer status to contributor_clarification_submitted so the reviewer can act.
    let answerStatus = null;
    const contributorRoles = ['contributor', 'consultant', 'client_admin', 'consultant_admin'];
    if (parent.answerId && contributorRoles.includes(req.user.userType)) {
      const answer = await DisclosureAnswer.findById(parent.answerId);
      if (answer && answer.status === 'contributor_clarification_required') {
        const t = validateTransition(answer.status, 'contributor_clarification_submitted', req.user.userType);
        if (t.valid) {
          const prevSt = answer.status;
          answer.status    = 'contributor_clarification_submitted';
          answer.updatedBy = req.user._id;
          await answer.save();
          answerStatus = 'contributor_clarification_submitted';
          _emitStatusChanged(answer.toObject(), prevSt, 'contributor_clarification_submitted', req.user, [answer.reviewerId]);
        }
      }
    }

    return res.status(201).json({ success: true, message: 'Reply added', data: reply, answerStatus });
  } catch (err) {
    console.error('[reviewController] replyToComment:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const resolveComment = async (req, res) => {
  try {
    const { commentId } = req.params;
    const comment = await EsgReviewComment.findByIdAndUpdate(
      commentId,
      { $set: { status: 'resolved', resolvedAt: new Date() } },
      { new: true }
    );
    if (!comment) return res.status(404).json({ message: 'Comment not found' });

    emitEsgClientEvent(String(comment.clientId), 'brsr:commentResolved', {
      commentId: String(comment._id),
      answerId:  String(comment.answerId),
      clientId:  String(comment.clientId),
    });

    return res.status(200).json({ success: true, message: 'Comment resolved', data: comment });
  } catch (err) {
    console.error('[reviewController] resolveComment:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const listComments = async (req, res) => {
  try {
    const { answerId } = req.params;
    const answer = await DisclosureAnswer.findById(answerId, 'clientId').lean();
    if (!answer) return res.status(404).json({ message: 'Answer not found' });

    const comments = await EsgReviewComment.find({ answerId })
      .populate('commentBy', 'userName email')
      .sort({ createdAt: 1 })
      .lean();

    return res.status(200).json({ success: true, count: comments.length, data: comments });
  } catch (err) {
    console.error('[reviewController] listComments:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

module.exports = {
  reviewerComment,
  reviewerApprove,
  reviewerRequestChanges,
  submitToApprover,
  requestContributorClarification,
  approverQuery,
  approverApprove,
  approverDecline,
  replyToComment,
  resolveComment,
  listComments,
};
