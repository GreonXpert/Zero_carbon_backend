'use strict';

const DisclosureAnswer              = require('../models/DisclosureAnswer.model');
const EsgFrameworkQuestion          = require('../models/FrameworkQuestion.model');
const ClientFrameworkInstance       = require('../models/ClientFrameworkInstance.model');
const ReviewComment                 = require('../models/ReviewComment.model');
const QuestionAssignment            = require('../models/QuestionAssignment.model');
const { canAnswerQuestion, canViewClientBrsr } = require('../services/frameworkAccessService');
const { prefillAnswerFromCore }     = require('../services/brsrPrefillService');
const { checkEvidenceRequirement }  = require('../services/evidenceValidationService');
const { validateTransition }        = require('../services/workflowStateService');
const { emitEsgClientEvent, emitEsgUserEvent } = require('../../esgLink_core/summary/utils/esgSummarySocket');

/**
 * Translate common Mongoose/Mongo errors (bad enum/cast values) into a 400
 * response instead of a generic 500. Returns true if it handled (and
 * responded to) the error.
 */
const handleKnownDbError = (res, err) => {
  if (err.name === 'ValidationError') {
    const errors = {};
    for (const [field, e] of Object.entries(err.errors || {})) {
      errors[field] = e.message;
    }
    res.status(400).json({ message: 'Validation failed', errors });
    return true;
  }
  if (err.name === 'CastError') {
    res.status(400).json({ message: `Invalid value for field "${err.path}": ${err.value}` });
    return true;
  }
  return false;
};

const listClientQuestions = async (req, res) => {
  try {
    const { clientId } = req.params;
    const perm = await canViewClientBrsr(req.user, clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { periodId, frameworkCode, sectionCode, principleCode } = req.query;
    if (!frameworkCode) return res.status(400).json({ message: 'frameworkCode query param is required' });

    // Verify an active instance exists for this client + framework
    const instance = await ClientFrameworkInstance.findOne({
      clientId,
      frameworkCode: frameworkCode.toUpperCase(),
      ...(periodId && { periodId }),
    }).lean();
    if (!instance) {
      return res.status(404).json({ message: 'Framework not activated for this client and period' });
    }

    const questionQuery = { frameworkCode: frameworkCode.toUpperCase(), status: 'published', isDeleted: false };
    if (sectionCode)   questionQuery.sectionCode   = sectionCode;
    if (principleCode) questionQuery.principleCode = principleCode;

    const questions = await EsgFrameworkQuestion.find(questionQuery)
      .sort({ sectionCode: 1, displayOrder: 1 })
      .lean();

    // Attach answer status if periodId is given
    let answerMap = {};
    if (periodId && questions.length) {
      const answers = await DisclosureAnswer.find(
        { clientId, periodId, questionId: { $in: questions.map((q) => q._id) } },
        { questionId: 1, status: 1 }
      ).lean();
      for (const a of answers) {
        answerMap[String(a.questionId)] = a.status;
      }
    }

    const result = questions.map((q) => ({
      ...q,
      answerStatus: answerMap[String(q._id)] || 'not_started',
    }));

    return res.status(200).json({ success: true, count: result.length, data: result });
  } catch (err) {
    console.error('[answerController] listClientQuestions:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const prefillAnswer = async (req, res) => {
  try {
    const { clientId, questionId } = req.params;
    const perm = await canViewClientBrsr(req.user, clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { periodId, periodType, periodKey, boundaryDocId } = req.query;

    // At least one period identifier is required
    if (!periodId && !(periodType && periodKey)) {
      return res.status(400).json({
        message: 'Provide either periodId (e.g. "2026") or both periodType + periodKey (e.g. "financial_year" + "2025-04-01_2026-03-31")',
      });
    }

    const prefill = await prefillAnswerFromCore({
      clientId,
      periodId,
      periodType,
      periodKey,
      questionId,
      boundaryDocId,
    });
    return res.status(200).json({ success: true, data: prefill });
  } catch (err) {
    console.error('[answerController] prefillAnswer:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const saveAnswer = async (req, res) => {
  try {
    const { clientId, questionId } = req.params;
    const perm = await canAnswerQuestion(req.user, clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const {
      periodId: rawPeriodId, periodType, periodKey,
      frameworkId, frameworkCode, questionCode, assignmentId,
      answerSource, answerData, autoFilledData, sourceTrace,
      applicabilityStatus, naReason,
    } = req.body;

    // Accept periodType + periodKey as an alternative period identifier (matches prefill API format)
    const periodId = rawPeriodId || (periodType && periodKey ? periodKey : null);
    if (!periodId) return res.status(400).json({ message: 'periodId is required (or provide both periodType and periodKey)' });
    if (!frameworkId)   return res.status(400).json({ message: 'frameworkId is required' });
    if (!frameworkCode) return res.status(400).json({ message: 'frameworkCode is required' });
    if (!questionCode)  return res.status(400).json({ message: 'questionCode is required' });

    const update = {
      $set: {
        clientId,
        periodId,
        frameworkId,
        frameworkCode: frameworkCode.toUpperCase(),
        questionId,
        questionCode,
        assignmentId:        assignmentId        || null,
        answerSource:        answerSource        || 'manual',
        answerData:          answerData          || null,
        autoFilledData:      autoFilledData      || null,
        sourceTrace:         sourceTrace         || [],
        applicabilityStatus: applicabilityStatus || 'applicable',
        naReason:            naReason            || null,
        status:              'in_progress',
        updatedBy:           req.user._id,
      },
      $setOnInsert: {
        createdBy:   req.user._id,
      },
    };
    const filter = { clientId, periodId, questionId };
    const options = { upsert: true, new: true, runValidators: true };

    let answer;
    try {
      answer = await DisclosureAnswer.findOneAndUpdate(filter, update, options);
    } catch (upsertErr) {
      // Two concurrent saves (e.g. double-click) can both try to insert the same
      // {clientId, periodId, questionId} doc — the loser hits the unique index
      // (E11000) instead of finding the winner's just-inserted row. Retry once;
      // the doc now exists so this becomes a plain update.
      if (upsertErr.code === 11000) {
        answer = await DisclosureAnswer.findOneAndUpdate(filter, update, options);
      } else {
        throw upsertErr;
      }
    }

    emitEsgClientEvent(String(clientId), 'answer:updated', {
      clientId:   String(clientId),
      questionId: String(questionId),
      answerId:   String(answer._id),
      status:     answer.status,
    });

    return res.status(200).json({ success: true, message: 'Answer saved', data: answer });
  } catch (err) {
    console.error('[answerController] saveAnswer:', err);
    if (handleKnownDbError(res, err)) return;
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const getAnswer = async (req, res) => {
  try {
    const { answerId } = req.params;
    const answer = await DisclosureAnswer.findById(answerId).lean();
    if (!answer) return res.status(404).json({ message: 'Answer not found' });

    const perm = await canViewClientBrsr(req.user, answer.clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    return res.status(200).json({ success: true, data: answer });
  } catch (err) {
    console.error('[answerController] getAnswer:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const updateAnswer = async (req, res) => {
  try {
    const { answerId } = req.params;
    const answer = await DisclosureAnswer.findById(answerId);
    if (!answer) return res.status(404).json({ message: 'Answer not found' });

    const perm = await canAnswerQuestion(req.user, answer.clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const editable = ['not_started', 'in_progress', 'reviewer_changes_requested', 'contributor_clarification_required', 'approver_declined'];
    if (!editable.includes(answer.status)) {
      return res.status(400).json({ message: `Answer in status "${answer.status}" cannot be edited` });
    }

    const allowed = ['answerData', 'autoFilledData', 'sourceTrace', 'applicabilityStatus', 'naReason', 'answerSource'];
    const update  = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }
    update.updatedBy = req.user._id;

    const updated = await DisclosureAnswer.findByIdAndUpdate(answerId, { $set: update }, { new: true });
    return res.status(200).json({ success: true, message: 'Answer updated', data: updated });
  } catch (err) {
    console.error('[answerController] updateAnswer:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const submitAnswer = async (req, res) => {
  try {
    const { answerId } = req.params;
    const answer = await DisclosureAnswer.findById(answerId);
    if (!answer) return res.status(404).json({ message: 'Answer not found' });

    const perm = await canAnswerQuestion(req.user, answer.clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    // Determine the correct target status:
    //   resubmission after changes requested → resubmitted_to_reviewer
    //   clarification reply → contributor_clarification_submitted
    //   first submission / after approver_declined → submitted_to_reviewer (full cycle restarts)
    let targetStatus;
    if (answer.status === 'reviewer_changes_requested') {
      targetStatus = 'resubmitted_to_reviewer';
    } else if (answer.status === 'contributor_clarification_required') {
      targetStatus = 'contributor_clarification_submitted';
    } else {
      // 'in_progress', 'approver_declined', or any other editable state → submitted_to_reviewer
      targetStatus = 'submitted_to_reviewer';
    }

    const transition = validateTransition(answer.status, targetStatus, req.user.userType);
    if (!transition.valid) return res.status(400).json({ message: transition.reason });

    // Check evidence requirement before allowing submission
    const evidenceCheck = await checkEvidenceRequirement(answer.questionId, answerId);
    if (!evidenceCheck.valid) return res.status(400).json({ message: evidenceCheck.reason });

    // Stamp reviewerId / approverId from the linked assignment so the reviewer/approver
    // can later query their own queue by answer.reviewerId / answer.approverId
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

    // Freeze the current autoFilledData as coreSnapshot at submission time
    if (answer.sourceTrace && answer.sourceTrace.length) {
      answer.coreSnapshot = answer.sourceTrace.map((t) => ({
        metricId:   t.metricId,
        metricCode: t.metricCode,
        value:      t.value,
        unit:       t.unit,
        snapshotAt: new Date(),
      }));
    }

    answer.status      = targetStatus;
    answer.submittedAt = new Date();
    answer.updatedBy   = req.user._id;
    await answer.save();

    emitEsgClientEvent(String(answer.clientId), 'answer:submitted', {
      clientId:   String(answer.clientId),
      answerId:   String(answer._id),
      questionId: String(answer.questionId),
      status:     answer.status,
    });
    if (answer.reviewerId) emitEsgUserEvent(String(answer.reviewerId), 'answer:submitted', { answerId: String(answer._id) });
    if (answer.approverId) emitEsgUserEvent(String(answer.approverId), 'answer:submitted', { answerId: String(answer._id) });

    return res.status(200).json({ success: true, message: 'Answer submitted to reviewer', data: answer });
  } catch (err) {
    console.error('[answerController] submitAnswer:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// ── Consultant: list all answers for a client+period with question details ────

const listAllAnswers = async (req, res) => {
  try {
    const { clientId } = req.params;
    const perm = await canViewClientBrsr(req.user, clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { frameworkCode, periodId, sectionCode, statsOnly } = req.query;
    if (!frameworkCode) return res.status(400).json({ message: 'frameworkCode query param is required' });
    if (!periodId)      return res.status(400).json({ message: 'periodId query param is required' });

    const fc = frameworkCode.toUpperCase();

    // All published questions for this framework
    const questions = await EsgFrameworkQuestion.find(
      { frameworkCode: fc, status: 'published', isDeleted: false },
      { _id: 1, questionCode: 1, questionTitle: 1, questionText: 1, sectionCode: 1,
        principleCode: 1, indicatorType: 1, answerMode: 1, answerComponentType: 1,
        answerSchema: 1, evidenceRequirement: 1, displayOrder: 1 }
    ).sort({ sectionCode: 1, displayOrder: 1 }).lean();

    if (!questions.length) {
      return res.status(200).json({ success: true, count: 0, data: [], sectionStats: [] });
    }

    const questionIds = questions.map((q) => q._id);

    // All answers for this client+period
    const answers = await DisclosureAnswer.find(
      { clientId, periodId, questionId: { $in: questionIds } }
    ).lean();

    const answerMap = {};
    for (const a of answers) {
      answerMap[String(a.questionId)] = a;
    }

    // Count open (non-resolved) comments per answer
    const answerIds = answers.map((a) => a._id);
    const commentCounts = answerIds.length
      ? await ReviewComment.aggregate([
          { $match: { answerId: { $in: answerIds }, status: { $ne: 'resolved' } } },
          { $group: { _id: '$answerId', count: { $sum: 1 } } },
        ])
      : [];
    const commentMap = {};
    for (const c of commentCounts) commentMap[String(c._id)] = c.count;

    // Assignments — fetch contributor (and reviewer/approver) names for display
    const assignments = await QuestionAssignment.find(
      { clientId, periodId, questionId: { $in: questionIds } },
      { questionId: 1, contributorId: 1, reviewerId: 1, approverId: 1 }
    ).populate('contributorId', 'userName email')
     .populate('reviewerId',    'userName email')
     .populate('approverId',    'userName email')
     .lean();

    const assignmentMap = {};
    for (const a of assignments) {
      assignmentMap[String(a.questionId)] = a;
    }

    // Merge question + answer into one record per question
    let data = questions.map((q) => {
      const answer     = answerMap[String(q._id)]     || null;
      const assignment = assignmentMap[String(q._id)] || null;
      return {
        questionId:    q._id,
        questionCode:  q.questionCode,
        questionTitle: q.questionTitle || null,
        questionText:  q.questionText,
        sectionCode:   q.sectionCode,
        principleCode: q.principleCode || null,
        indicatorType:       q.indicatorType,
        answerMode:          q.answerMode,
        answerComponentType: q.answerComponentType || null,
        answerSchema:        q.answerSchema        || null,
        evidenceRequirement: q.evidenceRequirement,
        displayOrder:        q.displayOrder,

        // Answer fields (null if not yet started)
        answerId:       answer ? answer._id                             : null,
        answerStatus:   answer ? answer.status                         : 'not_started',
        answerSource:   answer ? answer.answerSource                   : null,
        answerData:     answer ? answer.answerData                     : null,
        sourceTrace:    answer ? answer.sourceTrace                    : [],
        evidenceIds:    answer ? answer.evidenceIds                    : [],
        applicabilityStatus: answer ? answer.applicabilityStatus       : null,
        submittedAt:    answer ? answer.submittedAt                    : null,
        reviewedAt:     answer ? answer.reviewedAt                     : null,
        approvedAt:     answer ? answer.approvedAt                     : null,
        updatedAt:      answer ? answer.updatedAt                      : null,

        // Consultant metric approval (only relevant for core_metric / hybrid answers)
        consultantMetricApproval: answer ? answer.consultantMetricApproval : null,

        openCommentCount: answer ? (commentMap[String(answer._id)] || 0) : 0,

        // Assignment — contributor/reviewer/approver with populated names
        assignedContributor: assignment ? assignment.contributorId : null,
        assignedReviewer:    assignment ? assignment.reviewerId    : null,
        assignedApprover:    assignment ? assignment.approverId    : null,
      };
    });

    // Summary counts for quick consultant overview
    const summary = {
      total:              data.length,
      notStarted:         data.filter((d) => d.answerStatus === 'not_started').length,
      inProgress:         data.filter((d) => d.answerStatus === 'in_progress').length,
      submitted:          data.filter((d) => d.answerStatus === 'submitted_to_reviewer').length,
      reviewerApproved:   data.filter((d) => d.answerStatus === 'reviewer_approved').length,
      finalApproved:      data.filter((d) => d.answerStatus === 'final_approved').length,
      metricPendingConsultantApproval: data.filter((d) =>
        ['core_metric', 'hybrid'].includes(d.answerSource) &&
        !(d.consultantMetricApproval && d.consultantMetricApproval.isApproved)
      ).length,
    };

    // Per-section stats — total / answered by contributor / reviewed / approved.
    // Computed once over the full dataset so the section overview and the
    // per-section stat cards stay accurate even when `data` below is later
    // filtered/paginated to a single section.
    const sectionStatsMap = {};
    for (const d of data) {
      const sec = d.sectionCode || 'GENERAL';
      if (!sectionStatsMap[sec]) {
        sectionStatsMap[sec] = { sectionCode: sec, total: 0, contributorAnswered: 0, reviewed: 0, approved: 0 };
      }
      const s = sectionStatsMap[sec];
      s.total += 1;
      if (d.answerStatus !== 'not_started') s.contributorAnswered += 1;
      if (d.reviewedAt) s.reviewed += 1;
      if (d.answerStatus === 'final_approved') s.approved += 1;
    }
    const sectionStats = Object.values(sectionStatsMap).sort((a, b) => a.sectionCode.localeCompare(b.sectionCode));

    // Lightweight mode — used to populate the section overview without
    // shipping every question's full answerSchema/answerData payload.
    if (statsOnly === 'true' || statsOnly === '1') {
      return res.status(200).json({ success: true, summary, sectionStats, count: data.length });
    }

    // Optionally scope to a single section and paginate the result —
    // keeps per-request payloads small for sections with many questions.
    let pagination = null;
    if (sectionCode) {
      data = data.filter((d) => (d.sectionCode || 'GENERAL') === sectionCode);

      const page  = Math.max(1, parseInt(req.query.page, 10)  || 1);
      const limit = Math.max(0, parseInt(req.query.limit, 10) || 0);
      if (limit > 0) {
        const total      = data.length;
        const totalPages = Math.max(1, Math.ceil(total / limit));
        const start      = (page - 1) * limit;
        data = data.slice(start, start + limit);
        pagination = { page, limit, total, totalPages };
      }
    }

    return res.status(200).json({ success: true, summary, sectionStats, pagination, count: data.length, data });
  } catch (err) {
    console.error('[answerController] listAllAnswers:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

module.exports = { listClientQuestions, prefillAnswer, saveAnswer, getAnswer, updateAnswer, submitAnswer, listAllAnswers };
