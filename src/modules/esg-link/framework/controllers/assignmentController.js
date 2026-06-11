'use strict';

const QuestionAssignment    = require('../models/QuestionAssignment.model');
const DisclosureAnswer      = require('../models/DisclosureAnswer.model');
const EsgFrameworkQuestion  = require('../models/FrameworkQuestion.model');
const QuestionMetricMapping = require('../models/QuestionMetricMapping.model');
const ReviewComment         = require('../models/ReviewComment.model');
const { canAssignQuestion, canViewClientBrsr } = require('../services/frameworkAccessService');
const { getMyQuestions }  = require('../services/assignmentResolverService');
const { emitEsgUserEvent, emitEsgClientEvent } = require('../../esgLink_core/summary/utils/esgSummarySocket');

// Fields to include when populating the questionId reference on assignments
const QUESTION_POPULATE =
  'questionCode questionTitle questionText sectionCode principleCode indicatorType displayOrder ' +
  'status answerMode answerComponentType answerSchema frameworkId ' +
  'linkedMetricIds linkedMetricCodes autoAnswerAllowed manualAnswerAllowed linkedBoundaryRequired';

// Fetch and attach framework-level metric mappings (with metric details) to an array of assignments
async function enrichWithMetricMappings(assignments) {
  if (!assignments.length) return assignments;
  const questionIds = [...new Set(
    assignments.map((a) => String(a.questionId?._id || a.questionId)).filter(Boolean)
  )];
  const mappings = await QuestionMetricMapping.find({
    questionId: { $in: questionIds },
    clientId:   null,
    active:     true,
  })
    .populate('metricId', 'metricCode metricName esgCategory primaryUnit')
    .lean();

  const byQuestion = {};
  for (const m of mappings) {
    const qId = String(m.questionId);
    if (!byQuestion[qId]) byQuestion[qId] = [];
    byQuestion[qId].push(m);
  }

  return assignments.map((a) => {
    const qId = String(a.questionId?._id || a.questionId);
    return { ...a, metricMappings: byQuestion[qId] || [] };
  });
}

// Statuses where the approver needs to take action (or has acted)
const APPROVER_RELEVANT_STATUSES = [
  'submitted_to_approver',
  'approver_query_to_reviewer',
  'reviewer_response_pending',
  'final_approved',
];

// Attach answerId, answerStatus, and openCommentCount to an array of assignment objects
async function enrichWithAnswers(assignments, clientId, periodId) {
  if (!assignments.length) return assignments;
  const questionIds = assignments.map((a) => a.questionId?._id || a.questionId).filter(Boolean);
  const answers = await DisclosureAnswer.find(
    { clientId, periodId, questionId: { $in: questionIds } },
    { _id: 1, questionId: 1, status: 1 }
  ).lean();
  const answerMap = {};
  for (const a of answers) answerMap[String(a.questionId)] = a;

  const answerIds = answers.map((a) => a._id);
  const commentCounts = answerIds.length
    ? await ReviewComment.aggregate([
        { $match: { answerId: { $in: answerIds }, status: { $ne: 'resolved' } } },
        { $group: { _id: '$answerId', count: { $sum: 1 } } },
      ])
    : [];
  const commentMap = {};
  for (const c of commentCounts) commentMap[String(c._id)] = c.count;

  return assignments.map((a) => {
    const qId = String(a.questionId?._id || a.questionId);
    const ans = answerMap[qId];
    return {
      ...a,
      answerId:         ans ? ans._id : null,
      answerStatus:     ans ? ans.status : 'not_started',
      openCommentCount: ans ? (commentMap[String(ans._id)] || 0) : 0,
    };
  });
}

// ── helpers ───────────────────────────────────────────────────────────────────

function emitAssignmentEvent(event, assignment) {
  const { _id, clientId, contributorId, reviewerId, approverId } = assignment;
  const payload = { assignmentId: String(_id), clientId: String(clientId), assignment };

  if (contributorId) emitEsgUserEvent(String(contributorId), event, payload);
  if (reviewerId)    emitEsgUserEvent(String(reviewerId),    event, payload);
  if (approverId)    emitEsgUserEvent(String(approverId),    event, payload);

  emitEsgClientEvent(String(clientId), 'assignment:listChanged', { clientId: String(clientId) });
}

// ── Create ────────────────────────────────────────────────────────────────────

const createAssignment = async (req, res) => {
  try {
    const { clientId } = req.params;
    const perm = await canAssignQuestion(req.user, clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const {
      periodId, frameworkId, frameworkCode, questionId, questionCode,
      contributorId, reviewerId, approverId, dueDate, priority,
      assignmentType, metricIds,
    } = req.body;

    if (!periodId)      return res.status(400).json({ message: 'periodId is required' });
    if (!frameworkId)   return res.status(400).json({ message: 'frameworkId is required' });
    if (!frameworkCode) return res.status(400).json({ message: 'frameworkCode is required' });
    if (!questionId)    return res.status(400).json({ message: 'questionId is required' });
    if (!questionCode)  return res.status(400).json({ message: 'questionCode is required' });

    const assignment = await QuestionAssignment.create({
      clientId,
      periodId,
      frameworkId,
      frameworkCode:  frameworkCode.toUpperCase(),
      questionId,
      questionCode,
      contributorId:  contributorId  || null,
      reviewerId:     reviewerId     || null,
      approverId:     approverId     || null,
      assignedBy:     req.user._id,
      dueDate:        dueDate        || null,
      priority:       priority       || 'medium',
      assignmentType: assignmentType || 'manual',
      metricIds:      metricIds      || [],
      status:         'assigned',
    });

    emitAssignmentEvent('assignment:created', assignment);

    return res.status(201).json({ success: true, message: 'Assignment created', data: assignment });
  } catch (err) {
    console.error('[assignmentController] createAssignment:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// ── List ──────────────────────────────────────────────────────────────────────

const listAssignments = async (req, res) => {
  try {
    const { clientId } = req.params;
    const perm = await canViewClientBrsr(req.user, clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { periodId, frameworkCode, questionId, contributorId, reviewerId, approverId, status, priority } = req.query;
    const query = { clientId };
    if (periodId)      query.periodId      = periodId;
    if (frameworkCode) query.frameworkCode = frameworkCode.toUpperCase();
    if (questionId)    query.questionId    = questionId;
    if (contributorId) query.contributorId = contributorId;
    if (reviewerId)    query.reviewerId    = reviewerId;
    if (approverId)    query.approverId    = approverId;
    if (status)        query.status        = status;
    if (priority)      query.priority      = priority;

    const raw = await QuestionAssignment.find(query)
      .populate('contributorId', 'userName email')
      .populate('reviewerId',    'userName email')
      .populate('approverId',    'userName email')
      .populate('questionId',    QUESTION_POPULATE)
      .sort({ createdAt: -1 })
      .lean();

    const assignments = await enrichWithMetricMappings(raw);

    return res.status(200).json({ success: true, count: assignments.length, data: assignments });
  } catch (err) {
    console.error('[assignmentController] listAssignments:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// ── My Questions (role-aware) ─────────────────────────────────────────────────

const getMyAssignedQuestions = async (req, res) => {
  try {
    const { clientId } = req.params;
    const perm = await canViewClientBrsr(req.user, clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { periodId, frameworkCode } = req.query;
    if (!periodId) return res.status(400).json({ message: 'periodId query param is required' });

    const userId   = req.user._id;
    const userType = req.user.userType;

    // Contributor: use existing service (handles metric-based assignments too)
    if (userType === 'contributor') {
      const questions = await getMyQuestions(userId, clientId, periodId, frameworkCode);
      return res.status(200).json({ success: true, count: questions.length, data: questions });
    }

    // Reviewer: assignments where reviewerId === me
    if (userType === 'reviewer') {
      const query = { clientId, periodId, reviewerId: userId };
      if (frameworkCode) query.frameworkCode = frameworkCode.toUpperCase();
      const raw = await QuestionAssignment.find(query)
        .populate('questionId',    QUESTION_POPULATE)
        .populate('contributorId', 'userName email')
        .sort({ createdAt: -1 })
        .lean();
      const withAnswers = await enrichWithAnswers(raw, clientId, periodId);
      const data = await enrichWithMetricMappings(withAnswers);
      return res.status(200).json({ success: true, count: data.length, data });
    }

    // Approver: build list from answer STATUS (source of truth) rather than assignment.approverId
    // This handles: (a) explicit assignment.approverId, (b) answer.approverId set by submitToApprover,
    // (c) assignment.approverId = null (any approver for the client can handle it).
    if (userType === 'approver') {
      const fc = frameworkCode ? frameworkCode.toUpperCase() : undefined;

      // ── Step 1: find all answers in approver-relevant statuses for this client/period
      const answerQuery = { clientId, periodId, status: { $in: APPROVER_RELEVANT_STATUSES } };
      if (fc) answerQuery.frameworkCode = fc;
      const allPendingAnswers = await DisclosureAnswer.find(answerQuery).lean();

      if (!allPendingAnswers.length) {
        return res.status(200).json({ success: true, count: 0, data: [] });
      }

      // ── Step 2: fetch assignments for those questions
      const questionIds = allPendingAnswers.map((a) => a.questionId);
      const allAssignments = await QuestionAssignment.find({
        clientId, periodId, questionId: { $in: questionIds },
      })
        .populate('questionId',    QUESTION_POPULATE)
        .populate('contributorId', 'userName email')
        .lean();

      // ── Step 3: build answer-by-questionId map for quick lookup
      const answerByQ = {};
      for (const ans of allPendingAnswers) answerByQ[String(ans.questionId)] = ans;

      // ── Step 4: keep only assignments this approver should see
      //   • assignment.approverId === userId   (explicitly assigned)
      //   • answer.approverId     === userId   (set during submitToApprover)
      //   • assignment.approverId === null      (unassigned → any approver handles it)
      const userIdStr = String(userId);
      const relevantAssignments = allAssignments.filter((asgn) => {
        const qId         = String(asgn.questionId?._id || asgn.questionId);
        const ans         = answerByQ[qId];
        const aApprover   = asgn.approverId  ? String(asgn.approverId)  : null;
        const ansApprover = ans?.approverId  ? String(ans.approverId)   : null;
        return aApprover === userIdStr || ansApprover === userIdStr || aApprover === null;
      });

      // ── Step 5: handle questions that have an answer but NO assignment
      const handledQIds = new Set(
        relevantAssignments.map((a) => String(a.questionId?._id || a.questionId))
      );
      const orphanAnswers = allPendingAnswers.filter(
        (ans) => !handledQIds.has(String(ans.questionId))
      );

      let orphanItems = [];
      if (orphanAnswers.length) {
        const orphanQIds = orphanAnswers.map((a) => a.questionId);
        const qs = await EsgFrameworkQuestion.find(
          { _id: { $in: orphanQIds } },
          QUESTION_POPULATE
        ).lean();
        orphanItems = qs.map((q) => ({ _id: null, questionId: q, contributorId: null }));
      }

      const raw        = [...relevantAssignments, ...orphanItems];
      const withAnswers = await enrichWithAnswers(raw, clientId, periodId);
      const data        = await enrichWithMetricMappings(withAnswers);
      return res.status(200).json({ success: true, count: data.length, data });
    }

    // Consultant / admin: return all for the client+period
    const query = { clientId, periodId };
    if (frameworkCode) query.frameworkCode = frameworkCode.toUpperCase();
    const raw = await QuestionAssignment.find(query)
      .populate('questionId',    QUESTION_POPULATE)
      .populate('contributorId', 'userName email')
      .populate('reviewerId',    'userName email')
      .populate('approverId',    'userName email')
      .sort({ createdAt: -1 })
      .lean();
    const withAnswers = await enrichWithAnswers(raw, clientId, periodId);
    const data        = await enrichWithMetricMappings(withAnswers);
    return res.status(200).json({ success: true, count: data.length, data });
  } catch (err) {
    console.error('[assignmentController] getMyAssignedQuestions:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// ── Update ────────────────────────────────────────────────────────────────────

const updateAssignment = async (req, res) => {
  try {
    const { assignmentId } = req.params;
    const assignment = await QuestionAssignment.findById(assignmentId);
    if (!assignment) return res.status(404).json({ message: 'Assignment not found' });

    const perm = await canAssignQuestion(req.user, assignment.clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const allowed = ['contributorId', 'reviewerId', 'approverId', 'dueDate', 'priority', 'status'];
    const update  = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }

    const updated = await QuestionAssignment.findByIdAndUpdate(
      assignmentId,
      { $set: update },
      { new: true }
    );

    emitAssignmentEvent('assignment:updated', updated);

    return res.status(200).json({ success: true, message: 'Assignment updated', data: updated });
  } catch (err) {
    console.error('[assignmentController] updateAssignment:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// ── Delete ────────────────────────────────────────────────────────────────────

const deleteAssignment = async (req, res) => {
  try {
    const { assignmentId } = req.params;
    const assignment = await QuestionAssignment.findById(assignmentId);
    if (!assignment) return res.status(404).json({ message: 'Assignment not found' });

    const perm = await canAssignQuestion(req.user, assignment.clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    // Capture user ids before deletion for socket notification
    const snapshot = {
      _id:           assignment._id,
      clientId:      assignment.clientId,
      contributorId: assignment.contributorId,
      reviewerId:    assignment.reviewerId,
      approverId:    assignment.approverId,
    };

    await QuestionAssignment.findByIdAndDelete(assignmentId);

    emitAssignmentEvent('assignment:removed', snapshot);

    return res.status(200).json({ success: true, message: 'Assignment removed' });
  } catch (err) {
    console.error('[assignmentController] deleteAssignment:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

module.exports = {
  createAssignment,
  listAssignments,
  getMyAssignedQuestions,
  updateAssignment,
  deleteAssignment,
};
