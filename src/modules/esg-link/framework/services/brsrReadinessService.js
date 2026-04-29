'use strict';

const ClientFrameworkInstance = require('../models/ClientFrameworkInstance.model');
const EsgFrameworkQuestion    = require('../models/FrameworkQuestion.model');
const DisclosureAnswer        = require('../models/DisclosureAnswer.model');
const QuestionMetricMapping   = require('../models/QuestionMetricMapping.model');
const BrsrFinalReport         = require('../models/BrsrFinalReport.model');

const FINAL_STATUSES      = new Set(['final_approved', 'locked']);
const REVIEWED_STATUSES   = new Set(['reviewer_approved', 'submitted_to_approver', 'approver_query_to_reviewer',
  'reviewer_response_pending', 'contributor_clarification_required', 'contributor_clarification_submitted',
  'final_approved', 'locked']);
const ANSWERED_STATUSES   = new Set(['in_progress', 'submitted_to_reviewer', 'reviewer_changes_requested',
  'resubmitted_to_reviewer', 'reviewer_approved', 'submitted_to_approver', 'approver_query_to_reviewer',
  'reviewer_response_pending', 'contributor_clarification_required', 'contributor_clarification_submitted',
  'final_approved', 'locked']);

/**
 * getReadinessDashboard
 * Returns section/principle-level readiness + detailed progress counters.
 *
 * @param {string} clientId
 * @param {string} frameworkCode
 * @param {string} periodId
 * @returns {Promise<object>}
 */
const getReadinessDashboard = async (clientId, frameworkCode, periodId) => {
  const instance = await ClientFrameworkInstance.findOne({
    clientId,
    frameworkCode,
    periodId,
  }).lean();

  if (!instance) {
    return {
      found:         false,
      message:       'No active framework instance found for this client and period',
      clientId,
      frameworkCode,
      periodId,
    };
  }

  const questions = await EsgFrameworkQuestion.find(
    { frameworkCode, status: 'published', isDeleted: false },
    { _id: 1, questionCode: 1, sectionCode: 1, principleCode: 1, indicatorType: 1 }
  ).lean();

  const questionIds = questions.map((q) => q._id);
  const totalQuestions = questions.length;

  // Fetch all answers for this client+period
  const answers = await DisclosureAnswer.find(
    { clientId, periodId, questionId: { $in: questionIds } },
    { questionId: 1, status: 1, answerSource: 1, 'consultantMetricApproval.isApproved': 1 }
  ).lean();

  const answerMap = {};
  for (const ans of answers) {
    answerMap[String(ans.questionId)] = ans;
  }

  // Questions that have at least one active metric mapping
  const mappedQuestionIds = await QuestionMetricMapping.distinct('questionId', {
    questionId: { $in: questionIds },
    active:     true,
  });
  const metricLinkedSet = new Set(mappedQuestionIds.map(String));

  // Progress counters
  let notStarted              = 0;
  let answeredByContributor   = 0;
  let reviewed                = 0;
  let approverApproved        = 0;
  let metricLinked            = metricLinkedSet.size;
  let metricDataApproved      = 0;

  for (const q of questions) {
    const qId = String(q._id);
    const ans  = answerMap[qId];
    const status = ans ? ans.status : 'not_started';

    if (status === 'not_started') notStarted++;
    if (ANSWERED_STATUSES.has(status))  answeredByContributor++;
    if (REVIEWED_STATUSES.has(status))  reviewed++;
    if (FINAL_STATUSES.has(status))     approverApproved++;

    // Count metric-linked answers where consultant has approved the Core data
    if (metricLinkedSet.has(qId) && ans && ans.consultantMetricApproval && ans.consultantMetricApproval.isApproved) {
      metricDataApproved++;
    }
  }

  // Check if final report exists
  const finalReport = await BrsrFinalReport.findOne(
    { clientId, frameworkCode, periodId },
    { _id: 1, status: 1, approvedAt: 1 }
  ).lean();

  const consultantFinalDone = !!(finalReport && finalReport.status === 'final');

  const overallReadinessPct = totalQuestions > 0
    ? Math.round((approverApproved / totalQuestions) * 100)
    : 0;

  // Section/principle breakdown
  const sectionMap = {};
  for (const q of questions) {
    const sec  = q.sectionCode   || 'Unknown';
    const prin = q.principleCode || 'General';
    const qId  = String(q._id);
    const ans  = answerMap[qId];
    const status = ans ? ans.status : 'not_started';

    if (!sectionMap[sec]) {
      sectionMap[sec] = { sectionCode: sec, total: 0, finalApproved: 0, principles: {} };
    }
    if (!sectionMap[sec].principles[prin]) {
      sectionMap[sec].principles[prin] = { principleCode: prin, total: 0, finalApproved: 0, byStatus: {} };
    }

    sectionMap[sec].total++;
    sectionMap[sec].principles[prin].total++;

    if (FINAL_STATUSES.has(status)) {
      sectionMap[sec].finalApproved++;
      sectionMap[sec].principles[prin].finalApproved++;
    }
    sectionMap[sec].principles[prin].byStatus[status] =
      (sectionMap[sec].principles[prin].byStatus[status] || 0) + 1;
  }

  const sections = Object.values(sectionMap).map((sec) => ({
    sectionCode:   sec.sectionCode,
    total:         sec.total,
    finalApproved: sec.finalApproved,
    readinessPct:  sec.total > 0 ? Math.round((sec.finalApproved / sec.total) * 100) : 0,
    principles:    Object.values(sec.principles),
  }));

  return {
    found:               true,
    clientId,
    frameworkCode,
    periodId,
    instanceStatus:      instance.status,
    activatedAt:         instance.activatedAt,
    overallReadinessPct,
    sections,
    // ── Progress counters ────────────────────────────────────────────────────
    progress: {
      totalQuestions,
      notStarted,
      answeredByContributor,
      metricLinked,
      metricDataApproved,
      reviewed,
      approverApproved,
      consultantFinalDone,
      finalReport: finalReport
        ? { reportId: finalReport._id, approvedAt: finalReport.approvedAt }
        : null,
    },
  };
};

module.exports = { getReadinessDashboard };
