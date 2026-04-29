'use strict';

const DisclosureAnswer  = require('../models/DisclosureAnswer.model');
const EsgReviewComment  = require('../models/ReviewComment.model');
const { canReviewAnswer, canApproveAnswer } = require('../services/frameworkAccessService');
const { validateTransition }               = require('../services/workflowStateService');

// ── Helper ────────────────────────────────────────────────────────────────────

const _transition = async (res, answerId, targetStatus, actor, extraUpdate = {}) => {
  const answer = await DisclosureAnswer.findById(answerId);
  if (!answer) return res.status(404).json({ message: 'Answer not found' });

  const t = validateTransition(answer.status, targetStatus, actor.userType);
  if (!t.valid) return res.status(400).json({ message: t.reason });

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

    const answer = await _transition(res, req.params.answerId, 'reviewer_approved', req.user, {
      reviewedAt: new Date(),
      reviewerId: req.user._id,
    });
    if (!answer) return; // response already sent

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

    answer.status    = 'reviewer_changes_requested';
    answer.updatedBy = req.user._id;
    await answer.save();

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

    const answer = await _transition(res, req.params.answerId, 'submitted_to_approver', req.user);
    if (!answer) return;

    return res.status(200).json({ success: true, message: 'Answer submitted to approver', data: answer });
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

    answer.status    = 'contributor_clarification_required';
    answer.updatedBy = req.user._id;
    await answer.save();

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

    const answer = await DisclosureAnswer.findById(req.params.answerId);
    if (!answer) return res.status(404).json({ message: 'Answer not found' });

    const t = validateTransition(answer.status, 'approver_query_to_reviewer', req.user.userType);
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
      commentType:   'approver_query',
      status:        'open',
    });

    answer.status    = 'approver_query_to_reviewer';
    answer.updatedBy = req.user._id;
    await answer.save();

    return res.status(200).json({ success: true, message: 'Query sent to reviewer', data: answer });
  } catch (err) {
    console.error('[reviewController] approverQuery:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const approverApprove = async (req, res) => {
  try {
    const perm = canApproveAnswer(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const answer = await _transition(res, req.params.answerId, 'final_approved', req.user, {
      approvedAt: new Date(),
      approverId: req.user._id,
    });
    if (!answer) return;

    return res.status(200).json({ success: true, message: 'Answer final-approved', data: answer });
  } catch (err) {
    console.error('[reviewController] approverApprove:', err);
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

    return res.status(201).json({ success: true, message: 'Reply added', data: reply });
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
      .populate('commentBy', 'name email')
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
  replyToComment,
  resolveComment,
  listComments,
};
