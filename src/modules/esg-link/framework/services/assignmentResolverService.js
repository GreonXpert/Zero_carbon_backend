'use strict';

const QuestionAssignment    = require('../models/QuestionAssignment.model');
const QuestionMetricMapping = require('../models/QuestionMetricMapping.model');
const DisclosureAnswer      = require('../models/DisclosureAnswer.model');

const QUESTION_POPULATE =
  'questionCode questionTitle questionText sectionCode principleCode indicatorType displayOrder ' +
  'status answerMode answerComponentType answerSchema frameworkId ' +
  'linkedMetricIds linkedMetricCodes autoAnswerAllowed manualAnswerAllowed linkedBoundaryRequired';

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
    .populate('questionId', QUESTION_POPULATE)
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
      .populate('questionId', QUESTION_POPULATE)
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
        { _id: 1, questionId: 1, status: 1 }   // _id = answerId needed by frontend
      ).lean()
    : [];

  const answerMap = {};
  for (const ans of answers) {
    answerMap[String(ans.questionId)] = ans;    // store full object (not just status)
  }

  const withAnswers = allItems.map((item) => {
    const qId = String(item.questionId?._id || item.questionId);
    const ans = answerMap[qId] || null;
    return {
      ...item,
      answerId:     ans ? ans._id    : null,
      answerStatus: ans ? ans.status : 'not_started',
    };
  });

  // Attach framework-level metric mappings (with metric details) to each item
  const allQIds = [...new Set(
    withAnswers.map((a) => String(a.questionId?._id || a.questionId)).filter(Boolean)
  )];
  const mappings = allQIds.length
    ? await QuestionMetricMapping.find({ questionId: { $in: allQIds }, clientId: null, active: true })
        .populate('metricId', 'metricCode metricName esgCategory primaryUnit')
        .lean()
    : [];
  const byQuestion = {};
  for (const m of mappings) {
    const qId = String(m.questionId);
    if (!byQuestion[qId]) byQuestion[qId] = [];
    byQuestion[qId].push(m);
  }

  return withAnswers.map((item) => {
    const qId = String(item.questionId?._id || item.questionId);
    return { ...item, metricMappings: byQuestion[qId] || [] };
  });
};

module.exports = { getMyQuestions };
