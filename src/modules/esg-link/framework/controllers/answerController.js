'use strict';

const DisclosureAnswer              = require('../models/DisclosureAnswer.model');
const EsgFrameworkQuestion          = require('../models/FrameworkQuestion.model');
const ClientFrameworkInstance       = require('../models/ClientFrameworkInstance.model');
const { canAnswerQuestion, canViewClientBrsr } = require('../services/frameworkAccessService');
const { prefillAnswerFromCore }     = require('../services/brsrPrefillService');
const { checkEvidenceRequirement }  = require('../services/evidenceValidationService');
const { validateTransition }        = require('../services/workflowStateService');

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
      periodId, frameworkId, frameworkCode, questionCode, assignmentId,
      answerSource, answerData, autoFilledData, sourceTrace,
      applicabilityStatus, naReason,
    } = req.body;

    if (!periodId)      return res.status(400).json({ message: 'periodId is required' });
    if (!frameworkId)   return res.status(400).json({ message: 'frameworkId is required' });
    if (!frameworkCode) return res.status(400).json({ message: 'frameworkCode is required' });
    if (!questionCode)  return res.status(400).json({ message: 'questionCode is required' });

    const answer = await DisclosureAnswer.findOneAndUpdate(
      { clientId, periodId, questionId },
      {
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
      },
      { upsert: true, new: true, runValidators: true }
    );

    return res.status(200).json({ success: true, message: 'Answer saved', data: answer });
  } catch (err) {
    console.error('[answerController] saveAnswer:', err);
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

    const editable = ['not_started', 'in_progress', 'reviewer_changes_requested', 'contributor_clarification_required'];
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

    const transition = validateTransition(answer.status, 'submitted_to_reviewer', req.user.userType);
    if (!transition.valid) return res.status(400).json({ message: transition.reason });

    // Check evidence requirement before allowing submission
    const evidenceCheck = await checkEvidenceRequirement(answer.questionId, answerId);
    if (!evidenceCheck.valid) return res.status(400).json({ message: evidenceCheck.reason });

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

    answer.status      = 'submitted_to_reviewer';
    answer.submittedAt = new Date();
    answer.updatedBy   = req.user._id;
    await answer.save();

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

    const { frameworkCode, periodId } = req.query;
    if (!frameworkCode) return res.status(400).json({ message: 'frameworkCode query param is required' });
    if (!periodId)      return res.status(400).json({ message: 'periodId query param is required' });

    const fc = frameworkCode.toUpperCase();

    // All published questions for this framework
    const questions = await EsgFrameworkQuestion.find(
      { frameworkCode: fc, status: 'published', isDeleted: false },
      { _id: 1, questionCode: 1, questionTitle: 1, questionText: 1, sectionCode: 1,
        principleCode: 1, indicatorType: 1, answerMode: 1, evidenceRequirement: 1, displayOrder: 1 }
    ).sort({ sectionCode: 1, displayOrder: 1 }).lean();

    if (!questions.length) {
      return res.status(200).json({ success: true, count: 0, data: [] });
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

    // Merge question + answer into one record per question
    const data = questions.map((q) => {
      const answer = answerMap[String(q._id)] || null;
      return {
        questionId:    q._id,
        questionCode:  q.questionCode,
        questionTitle: q.questionTitle || null,
        questionText:  q.questionText,
        sectionCode:   q.sectionCode,
        principleCode: q.principleCode || null,
        indicatorType: q.indicatorType,
        answerMode:    q.answerMode,
        evidenceRequirement: q.evidenceRequirement,
        displayOrder:  q.displayOrder,

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

        // Consultant metric approval (only relevant for core_metric / hybrid answers)
        consultantMetricApproval: answer ? answer.consultantMetricApproval : null,
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

    return res.status(200).json({ success: true, summary, count: data.length, data });
  } catch (err) {
    console.error('[answerController] listAllAnswers:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

module.exports = { listClientQuestions, prefillAnswer, saveAnswer, getAnswer, updateAnswer, submitAnswer, listAllAnswers };
