'use strict';

const DisclosureAnswer        = require('../models/DisclosureAnswer.model');
const EsgFrameworkQuestion    = require('../models/FrameworkQuestion.model');
const ClientFrameworkInstance = require('../models/ClientFrameworkInstance.model');
const QuestionMetricMapping   = require('../models/QuestionMetricMapping.model');
const BrsrFinalReport         = require('../models/BrsrFinalReport.model');
const { canConsultantFinalApprove, canViewClientBrsr } = require('../services/frameworkAccessService');

// ── Consultant approval of metric-filled data ────────────────────────────────

const approveMetricData = async (req, res) => {
  try {
    const { answerId } = req.params;
    const answer = await DisclosureAnswer.findById(answerId);
    if (!answer) return res.status(404).json({ message: 'Answer not found' });

    const perm = await canConsultantFinalApprove(req.user, answer.clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    if (!['core_metric', 'hybrid'].includes(answer.answerSource)) {
      return res.status(400).json({
        message: `Only metric-linked answers (answerSource: core_metric or hybrid) need consultant metric approval. This answer has answerSource: "${answer.answerSource}".`,
      });
    }

    const { notes } = req.body;

    answer.consultantMetricApproval = {
      isApproved: true,
      approvedBy: req.user._id,
      approvedAt: new Date(),
      notes:      notes || null,
    };
    answer.updatedBy = req.user._id;
    await answer.save();

    return res.status(200).json({
      success: true,
      message: 'Metric data approved by consultant',
      data:    answer,
    });
  } catch (err) {
    console.error('[consultantApprovalController] approveMetricData:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// ── Consultant bulk final approval — closes the reporting year ───────────────

const consultantFinalApprove = async (req, res) => {
  try {
    const { clientId } = req.params;
    const perm = await canConsultantFinalApprove(req.user, clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { frameworkCode, periodId } = req.body;
    if (!frameworkCode) return res.status(400).json({ message: 'frameworkCode is required' });
    if (!periodId)      return res.status(400).json({ message: 'periodId is required' });

    const fc = frameworkCode.toUpperCase();

    // 1. Verify active instance exists
    const instance = await ClientFrameworkInstance.findOne({
      clientId,
      frameworkCode: fc,
      periodId,
      status: { $nin: ['completed', 'cancelled'] },
    }).lean();
    if (!instance) {
      return res.status(404).json({
        message: 'No active framework instance found. It may already be completed or cancelled.',
      });
    }

    // 2. Get all published questions for this framework
    const publishedQuestions = await EsgFrameworkQuestion.find(
      { frameworkCode: fc, status: 'published', isDeleted: false },
      { _id: 1, questionCode: 1, questionTitle: 1, questionText: 1, sectionCode: 1, principleCode: 1, indicatorType: 1 }
    ).lean();

    const totalQuestions = publishedQuestions.length;
    if (totalQuestions === 0) {
      return res.status(400).json({ message: 'No published questions found for this framework' });
    }

    const questionIds = publishedQuestions.map((q) => q._id);

    // 3. Get all answers for this client+period
    const answers = await DisclosureAnswer.find(
      { clientId, periodId, questionId: { $in: questionIds } },
      { questionId: 1, status: 1, answerSource: 1, answerData: 1, coreSnapshot: 1, evidenceLinks: 1, approvedAt: 1, 'consultantMetricApproval.isApproved': 1 }
    ).lean();

    // Pre-flight check A: all questions must have a final_approved answer
    const approvedAnswerQIds = new Set(
      answers.filter((a) => a.status === 'final_approved' || a.status === 'locked').map((a) => String(a.questionId))
    );
    const missing = publishedQuestions.filter((q) => !approvedAnswerQIds.has(String(q._id)));
    if (missing.length > 0) {
      return res.status(400).json({
        message: `${missing.length} question(s) do not yet have a final_approved answer. Complete the approval workflow for all questions before consultant final approval.`,
        data: { missingQuestions: missing.map((q) => ({ questionId: q._id, questionCode: q.questionCode })) },
      });
    }

    // Pre-flight check B: all metric-linked answers must have consultant metric approval
    const metricLinkedQIds = await QuestionMetricMapping.distinct('questionId', {
      questionId: { $in: questionIds },
      active:     true,
    });
    const metricLinkedSet = new Set(metricLinkedQIds.map(String));

    const unapprovedMetricAnswers = answers.filter((a) =>
      metricLinkedSet.has(String(a.questionId)) &&
      ['core_metric', 'hybrid'].includes(a.answerSource) &&
      !(a.consultantMetricApproval && a.consultantMetricApproval.isApproved)
    );
    if (unapprovedMetricAnswers.length > 0) {
      return res.status(400).json({
        message: `${unapprovedMetricAnswers.length} metric-linked answer(s) have not been approved by the consultant yet. Use POST /brsr/answers/:answerId/consultant/approve-metric-data for each.`,
        data: { count: unapprovedMetricAnswers.length },
      });
    }

    // 4. Build snapshot
    const answerMap = {};
    for (const a of answers) {
      answerMap[String(a.questionId)] = a;
    }

    const snapshot = publishedQuestions.map((q) => {
      const ans = answerMap[String(q._id)] || {};
      return {
        questionId:    q._id,
        questionCode:  q.questionCode,
        questionTitle: q.questionTitle || null,
        questionText:  q.questionText,
        sectionCode:   q.sectionCode,
        principleCode: q.principleCode || null,
        indicatorType: q.indicatorType,
        answerSource:  ans.answerSource  || 'manual',
        answerData:    ans.answerData    || null,
        coreSnapshot:  ans.coreSnapshot  || [],
        evidenceLinks: ans.evidenceLinks || [],
        finalStatus:   ans.status        || 'final_approved',
        approvedAt:    ans.approvedAt    || null,
      };
    });

    const metricLinkedCount = answers.filter((a) => ['core_metric', 'hybrid'].includes(a.answerSource)).length;

    // 5. Create final report
    const report = await BrsrFinalReport.create({
      clientId,
      frameworkCode:     fc,
      periodId,
      reportingYear:     instance.reportingYear,
      instanceId:        instance._id,
      consultantId:      req.user._id,
      approvedAt:        new Date(),
      totalQuestions,
      totalAnswers:      answers.length,
      metricLinkedCount,
      snapshot,
      status:            'final',
    });

    // 6. Mark instance as completed
    await ClientFrameworkInstance.findByIdAndUpdate(instance._id, {
      $set: {
        status:   'completed',
        lockedBy: req.user._id,
        lockedAt: new Date(),
      },
    });

    return res.status(200).json({
      success: true,
      message: 'BRSR final approval complete. Reporting year is now closed.',
      data: {
        report,
        instanceId: instance._id,
        periodId,
        totalQuestions,
        metricLinkedCount,
      },
    });
  } catch (err) {
    console.error('[consultantApprovalController] consultantFinalApprove:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// ── Get final report ─────────────────────────────────────────────────────────

const getFinalReport = async (req, res) => {
  try {
    const { clientId } = req.params;
    const perm = await canViewClientBrsr(req.user, clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { frameworkCode, periodId } = req.query;
    if (!frameworkCode) return res.status(400).json({ message: 'frameworkCode query param is required' });
    if (!periodId)      return res.status(400).json({ message: 'periodId query param is required' });

    const report = await BrsrFinalReport.findOne({
      clientId,
      frameworkCode: frameworkCode.toUpperCase(),
      periodId,
    }).lean();

    if (!report) {
      return res.status(404).json({
        message: 'Final report not found. The reporting year may not be completed yet.',
      });
    }

    return res.status(200).json({ success: true, data: report });
  } catch (err) {
    console.error('[consultantApprovalController] getFinalReport:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

module.exports = { approveMetricData, consultantFinalApprove, getFinalReport };
