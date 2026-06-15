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

    if (!periodId && !(periodType && periodKey)) {
      return res.status(400).json({
        message: 'Provide either periodId (e.g. "2026") or both periodType + periodKey (e.g. "financial_year" + "2025-04-01_2026-03-31")',
      });
    }

    const prefill = await prefillAnswerFromCore({
      clientId, periodId, periodType, periodKey, questionId, boundaryDocId,
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

    const periodId = rawPeriodId || (periodType && periodKey ? periodKey : null);
    if (!periodId)      return res.status(400).json({ message: 'periodId is required (or provide both periodType and periodKey)' });
    if (!frameworkId)   return res.status(400).json({ message: 'frameworkId is required' });
    if (!frameworkCode) return res.status(400).json({ message: 'frameworkCode is required' });
    if (!questionCode)  return res.status(400).json({ message: 'questionCode is required' });

    const update = {
      $set: {
        clientId, periodId,
        frameworkId, frameworkCode: frameworkCode.toUpperCase(),
        questionId, questionCode,
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
      $setOnInsert: { createdBy: req.user._id },
    };
    const filter  = { clientId, periodId, questionId };
    const options = { upsert: true, new: true, runValidators: true };

    let answer;
    try {
      answer = await DisclosureAnswer.findOneAndUpdate(filter, update, options);
    } catch (upsertErr) {
      if (upsertErr.code === 11000) {
        answer = await DisclosureAnswer.findOneAndUpdate(filter, update, options);
      } else {
        throw upsertErr;
      }
    }

    emitEsgClientEvent(String(clientId), 'answer:updated', {
      clientId: String(clientId), questionId: String(questionId),
      answerId: String(answer._id), status: answer.status,
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

    let targetStatus;
    if (answer.status === 'reviewer_changes_requested') {
      targetStatus = 'resubmitted_to_reviewer';
    } else if (answer.status === 'contributor_clarification_required') {
      targetStatus = 'contributor_clarification_submitted';
    } else {
      targetStatus = 'submitted_to_reviewer';
    }

    const transition = validateTransition(answer.status, targetStatus, req.user.userType);
    if (!transition.valid) return res.status(400).json({ message: transition.reason });

    const evidenceCheck = await checkEvidenceRequirement(answer.questionId, answerId);
    if (!evidenceCheck.valid) return res.status(400).json({ message: evidenceCheck.reason });

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

    if (answer.sourceTrace && answer.sourceTrace.length) {
      answer.coreSnapshot = answer.sourceTrace.map((t) => ({
        metricId: t.metricId, metricCode: t.metricCode,
        value: t.value, unit: t.unit, snapshotAt: new Date(),
      }));
    }

    answer.status      = targetStatus;
    answer.submittedAt = new Date();
    answer.updatedBy   = req.user._id;
    await answer.save();

    emitEsgClientEvent(String(answer.clientId), 'answer:submitted', {
      clientId: String(answer.clientId), answerId: String(answer._id),
      questionId: String(answer.questionId), status: answer.status,
    });
    if (answer.reviewerId) emitEsgUserEvent(String(answer.reviewerId), 'answer:submitted', { answerId: String(answer._id) });
    if (answer.approverId) emitEsgUserEvent(String(answer.approverId), 'answer:submitted', { answerId: String(answer._id) });

    return res.status(200).json({ success: true, message: 'Answer submitted to reviewer', data: answer });
  } catch (err) {
    console.error('[answerController] submitAnswer:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// ── List all answers — supports statsOnly, sectionCode+pagination ─────────────
//
// Query params:
//   frameworkCode  (required)
//   periodId       (required)
//   statsOnly      "true"  → return section-level summary only (lightweight)
//   sectionCode            → scope to one section
//   page           number  → page index (1-based), used with sectionCode + limit
//   limit          number  → page size (0 = no limit)
const listAllAnswers = async (req, res) => {
  try {
    const { clientId } = req.params;
    const perm = await canViewClientBrsr(req.user, clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { frameworkCode, periodId, sectionCode, statsOnly } = req.query;
    if (!frameworkCode) return res.status(400).json({ message: 'frameworkCode query param is required' });
    if (!periodId)      return res.status(400).json({ message: 'periodId query param is required' });

    const fc           = frameworkCode.toUpperCase();
    const baseQFilter  = { frameworkCode: fc, status: 'published', isDeleted: false };

    // ── LIGHTWEIGHT STATS-ONLY MODE ───────────────────────────────────────────
    // Fetches minimal fields (no answerSchema/answerData) to compute per-section
    // totals and the overall summary — used by the sections overview view.
    if (statsOnly === 'true' || statsOnly === '1') {
      const questions = await EsgFrameworkQuestion
        .find(baseQFilter, { _id: 1, sectionCode: 1 })
        .lean();

      if (!questions.length) {
        return res.status(200).json({ success: true, summary: { total: 0 }, sectionStats: [], count: 0 });
      }

      const questionIds = questions.map((q) => q._id);

      const answers = await DisclosureAnswer
        .find(
          { clientId, periodId, questionId: { $in: questionIds } },
          { questionId: 1, status: 1, reviewedAt: 1 }
        )
        .lean();

      const answerMap = {};
      for (const a of answers) answerMap[String(a.questionId)] = a;

      const sectionStatsMap = {};
      for (const q of questions) {
        const sec = q.sectionCode || 'GENERAL';
        if (!sectionStatsMap[sec]) {
          sectionStatsMap[sec] = { sectionCode: sec, total: 0, contributorAnswered: 0, reviewed: 0, approved: 0 };
        }
        const ans = answerMap[String(q._id)];
        const s   = sectionStatsMap[sec];
        s.total += 1;
        if (ans && ans.status && ans.status !== 'not_started') s.contributorAnswered += 1;
        if (ans && ans.reviewedAt) s.reviewed += 1;
        if (ans && ans.status === 'final_approved') s.approved += 1;
      }
      const sectionStats = Object.values(sectionStatsMap)
        .sort((a, b) => a.sectionCode.localeCompare(b.sectionCode));

      const summary = {
        total:            questions.length,
        notStarted:       questions.length - answers.filter((a) => a.status && a.status !== 'not_started').length,
        inProgress:       answers.filter((a) => a.status === 'in_progress').length,
        submitted:        answers.filter((a) => a.status === 'submitted_to_reviewer').length,
        reviewerApproved: answers.filter((a) => a.status === 'reviewer_approved').length,
        finalApproved:    answers.filter((a) => a.status === 'final_approved').length,
      };

      return res.status(200).json({ success: true, summary, sectionStats, count: questions.length });
    }

    // ── PAGINATED SECTION / FULL FETCH ────────────────────────────────────────
    const questionQuery = { ...baseQFilter };
    if (sectionCode) questionQuery.sectionCode = sectionCode;

    const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit = Math.max(0, parseInt(req.query.limit, 10) || 0);

    // DB-level count and pagination when a section + limit are provided
    let totalCount = 0;
    if (sectionCode && limit > 0) {
      totalCount = await EsgFrameworkQuestion.countDocuments(questionQuery);
    }

    const qCursor = EsgFrameworkQuestion
      .find(questionQuery, {
        _id: 1, questionCode: 1, questionTitle: 1, questionText: 1, sectionCode: 1,
        principleCode: 1, indicatorType: 1, answerMode: 1, answerComponentType: 1,
        answerSchema: 1, evidenceRequirement: 1, displayOrder: 1,
      })
      .sort({ sectionCode: 1, displayOrder: 1 });

    if (sectionCode && limit > 0) {
      qCursor.skip((page - 1) * limit).limit(limit);
    }

    const questions = await qCursor.lean();

    if (!questions.length) {
      return res.status(200).json({
        success: true, count: 0, data: [],
        pagination: sectionCode && limit > 0 ? { page, limit, total: totalCount, totalPages: 0 } : null,
      });
    }

    const questionIds = questions.map((q) => q._id);

    // Answers only for the fetched questions
    const answers = await DisclosureAnswer
      .find({ clientId, periodId, questionId: { $in: questionIds } })
      .lean();

    const answerMap = {};
    for (const a of answers) answerMap[String(a.questionId)] = a;

    // Open comment counts
    const answerIds    = answers.map((a) => a._id);
    const commentCounts = answerIds.length
      ? await ReviewComment.aggregate([
          { $match: { answerId: { $in: answerIds }, status: { $ne: 'resolved' } } },
          { $group: { _id: '$answerId', count: { $sum: 1 } } },
        ])
      : [];
    const commentMap = {};
    for (const c of commentCounts) commentMap[String(c._id)] = c.count;

    // Assignments (contributor / reviewer / approver) for the fetched questions only
    const assignments = await QuestionAssignment
      .find(
        { clientId, periodId, questionId: { $in: questionIds } },
        { questionId: 1, contributorId: 1, reviewerId: 1, approverId: 1, dueDate: 1 }
      )
      .populate('contributorId', 'userName email')
      .populate('reviewerId',    'userName email')
      .populate('approverId',    'userName email')
      .lean();

    const assignmentMap = {};
    for (const a of assignments) assignmentMap[String(a.questionId)] = a;

    const data = questions.map((q) => {
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

        answerId:     answer ? answer._id               : null,
        answerStatus: answer ? answer.status            : 'not_started',
        answerSource: answer ? answer.answerSource      : null,
        answerData:   answer ? answer.answerData        : null,
        sourceTrace:  answer ? answer.sourceTrace       : [],
        evidenceIds:  answer ? answer.evidenceIds       : [],
        applicabilityStatus: answer ? answer.applicabilityStatus : null,
        submittedAt:  answer ? answer.submittedAt       : null,
        reviewedAt:   answer ? answer.reviewedAt        : null,
        approvedAt:   answer ? answer.approvedAt        : null,
        updatedAt:    answer ? answer.updatedAt         : null,
        consultantMetricApproval: answer ? answer.consultantMetricApproval : null,
        openCommentCount: answer ? (commentMap[String(answer._id)] || 0) : 0,

        // Assignment with populated names
        contributorId: assignment ? assignment.contributorId : null,
        reviewerId:    assignment ? assignment.reviewerId    : null,
        approverId:    assignment ? assignment.approverId    : null,
        dueDate:       assignment ? assignment.dueDate       : null,
      };
    });

    // Per-page summary (when no sectionCode, compute over page data)
    const summary = !sectionCode ? {
      total:            data.length,
      notStarted:       data.filter((d) => d.answerStatus === 'not_started').length,
      inProgress:       data.filter((d) => d.answerStatus === 'in_progress').length,
      submitted:        data.filter((d) => d.answerStatus === 'submitted_to_reviewer').length,
      reviewerApproved: data.filter((d) => d.answerStatus === 'reviewer_approved').length,
      finalApproved:    data.filter((d) => d.answerStatus === 'final_approved').length,
      metricPendingConsultantApproval: data.filter((d) =>
        ['core_metric', 'hybrid'].includes(d.answerSource) &&
        !(d.consultantMetricApproval && d.consultantMetricApproval.isApproved)
      ).length,
    } : null;

    const pagination = (sectionCode && limit > 0) ? {
      page, limit,
      total:      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / limit)),
    } : null;

    return res.status(200).json({ success: true, summary, pagination, count: data.length, data });
  } catch (err) {
    console.error('[answerController] listAllAnswers:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

module.exports = { listClientQuestions, prefillAnswer, saveAnswer, getAnswer, updateAnswer, submitAnswer, listAllAnswers };
