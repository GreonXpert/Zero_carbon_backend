'use strict';

const QuestionAssignment    = require('../models/QuestionAssignment.model');
const QuestionMetricMapping = require('../models/QuestionMetricMapping.model');
const DisclosureAnswer      = require('../models/DisclosureAnswer.model');

/**
 * getMyQuestions
 * Returns all framework questions assigned to a contributor for a given client+period.
 * Merges:
 *   1. Direct QuestionAssignments (contributorId === userId)
 *   2. Questions linked via metric-based assignments (metricIds overlap)
 *
 * @param {string|ObjectId} contributorId
 * @param {string}          clientId
 * @param {string}          periodId
 * @param {string}          [frameworkCode] - optional filter
 * @returns {Promise<Array>}
 */
const getMyQuestions = async (contributorId, clientId, periodId, frameworkCode) => {
  const assignmentQuery = {
    clientId,
    periodId,
    contributorId,
    ...(frameworkCode && { frameworkCode }),
  };

  const directAssignments = await QuestionAssignment.find(assignmentQuery)
    .populate('questionId', 'questionCode questionText sectionCode principleCode indicatorType displayOrder status')
    .lean();

  // Gather all questionIds already covered by direct assignments
  const directQuestionIds = new Set(
    directAssignments.map((a) => String(a.questionId?._id || a.questionId))
  );

  // Metric-based: find questions whose mappings reference metrics on this contributor's assignments
  const metricAssignments = await QuestionAssignment.find(
    { ...assignmentQuery, assignmentType: 'metric_based', 'metricIds.0': { $exists: true } }
  ).lean();

  const allMetricIds = metricAssignments.flatMap((a) => a.metricIds);
  let metricBasedQuestions = [];

  if (allMetricIds.length) {
    const mappings = await QuestionMetricMapping.find(
      { metricId: { $in: allMetricIds }, active: true, ...(frameworkCode && { frameworkCode }) },
      { questionId: 1, questionCode: 1 }
    )
      .populate('questionId', 'questionCode questionText sectionCode principleCode indicatorType displayOrder status')
      .lean();

    metricBasedQuestions = mappings
      .filter((m) => m.questionId && !directQuestionIds.has(String(m.questionId._id || m.questionId)))
      .map((m) => ({
        _isMetricBased:  true,
        questionId:      m.questionId,
        questionCode:    m.questionCode,
        clientId,
        periodId,
        frameworkCode:   m.frameworkCode,
        assignmentType:  'metric_based',
      }));
  }

  // Merge and attach answer status
  const allItems = [
    ...directAssignments.map((a) => ({ ...a, _isMetricBased: false })),
    ...metricBasedQuestions,
  ];

  const questionIds = allItems.map((a) => a.questionId?._id || a.questionId).filter(Boolean);
  const answers     = questionIds.length
    ? await DisclosureAnswer.find(
        { clientId, periodId, questionId: { $in: questionIds } },
        { questionId: 1, status: 1 }
      ).lean()
    : [];

  const answerMap = {};
  for (const ans of answers) {
    answerMap[String(ans.questionId)] = ans.status;
  }

  return allItems.map((item) => {
    const qId = String(item.questionId?._id || item.questionId);
    return {
      ...item,
      answerStatus: answerMap[qId] || 'not_started',
    };
  });
};

module.exports = { getMyQuestions };
