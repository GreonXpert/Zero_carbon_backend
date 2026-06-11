'use strict';

const EsgFrameworkQuestion        = require('../models/FrameworkQuestion.model');
const EsgFramework                = require('../models/Framework.model');
const QuestionMetricMapping       = require('../models/QuestionMetricMapping.model');
const { canManageFrameworkQuestion, canApproveQuestion } = require('../services/frameworkAccessService');
const { blockPublishedEdit, createDraftVersion }         = require('../services/questionVersionService');
const { syncMetricFrameworkFlags }                       = require('../services/metricFrameworkSyncService');

const createQuestion = async (req, res) => {
  try {
    const perm = canManageFrameworkQuestion(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const {
      frameworkId, frameworkCode, questionCode, sectionCode, principleCode, subsectionCode,
      indicatorType, questionTitle, questionText, helpText, regulatoryReference,
      disclosureType, answerMode, answerComponentType, answerSchema,
      linkedMetricIds, linkedMetricCodes, linkedBoundaryRequired,
      manualAnswerAllowed, autoAnswerAllowed, manualOverrideAllowed,
      evidenceRequirement, evidenceInstructions, defaultOwnerRole,
      reviewRequired, approvalRequired, applicability, displayOrder,
    } = req.body;

    if (!frameworkId)   return res.status(400).json({ message: 'frameworkId is required' });
    if (!frameworkCode) return res.status(400).json({ message: 'frameworkCode is required' });
    if (!questionCode)  return res.status(400).json({ message: 'questionCode is required' });
    if (!sectionCode)   return res.status(400).json({ message: 'sectionCode is required' });
    if (!questionText)  return res.status(400).json({ message: 'questionText is required' });

    const exists = await EsgFrameworkQuestion.findOne({
      frameworkCode: frameworkCode.toUpperCase(),
      questionCode,
      questionVersion: 1,
      isDeleted: false,
    }).lean();
    if (exists) {
      return res.status(409).json({
        message: `Question "${questionCode}" already exists for framework "${frameworkCode}". Use the version endpoint to create a new version of a published question.`,
      });
    }

    const question = await EsgFrameworkQuestion.create({
      frameworkId,
      frameworkCode: frameworkCode.toUpperCase(),
      questionCode,
      questionVersion:        1,
      sectionCode,
      principleCode:          principleCode          || null,
      subsectionCode:         subsectionCode         || null,
      indicatorType:          indicatorType          || 'essential',
      questionTitle:          questionTitle          || null,
      questionText,
      helpText:               helpText               || null,
      regulatoryReference:    regulatoryReference    || null,
      disclosureType:         disclosureType         || 'quantitative',
      answerMode:             answerMode             || 'manual',
      answerComponentType:    answerComponentType    || 'text_input',
      answerSchema:           answerSchema           || null,
      linkedMetricIds:        linkedMetricIds        || [],
      linkedMetricCodes:      linkedMetricCodes      || [],
      linkedBoundaryRequired: linkedBoundaryRequired || false,
      manualAnswerAllowed:    manualAnswerAllowed !== undefined ? manualAnswerAllowed : true,
      autoAnswerAllowed:      autoAnswerAllowed      || false,
      manualOverrideAllowed:  manualOverrideAllowed  !== undefined ? manualOverrideAllowed : true,
      evidenceRequirement:    evidenceRequirement    || 'optional',
      evidenceInstructions:   evidenceInstructions   || null,
      defaultOwnerRole:       defaultOwnerRole       || null,
      reviewRequired:         reviewRequired         !== undefined ? reviewRequired : true,
      approvalRequired:       approvalRequired       !== undefined ? approvalRequired : true,
      applicability:          applicability          || {},
      displayOrder:           displayOrder           || 0,
      status:                 'draft',
      createdBy:              req.user._id,
    });

    // Auto-create a QuestionMetricMapping for each linked metric so the prefill service can use them
    const metricIdsToMap = Array.isArray(linkedMetricIds) && linkedMetricIds.length
      ? linkedMetricIds
      : [];
    const metricCodesToMap = Array.isArray(linkedMetricCodes) ? linkedMetricCodes : [];

    for (let i = 0; i < metricIdsToMap.length; i++) {
      const mId   = metricIdsToMap[i];
      const mCode = metricCodesToMap[i] || '';
      try {
        const alreadyExists = await QuestionMetricMapping.findOne({
          questionId: question._id,
          metricId:   mId,
          clientId:   null,
          active:     true,
        }).lean();
        if (!alreadyExists) {
          await QuestionMetricMapping.create({
            clientId:          null,
            frameworkId,
            frameworkCode:     frameworkCode.toUpperCase(),
            questionId:        question._id,
            questionCode:      question.questionCode,
            metricId:          mId,
            metricCode:        mCode,
            sectionCode:       sectionCode   || null,
            principleCode:     principleCode || null,
            indicatorType:     indicatorType || null,
            mappingType:       'auto_answer',
            aggregationMethod: 'sum',
            isPrimary:         i === 0,
            isCore:            false,
            isBrsrCore:        false,
            allowManualOverride: true,
            useAllNodes:       true,
            boundaryNodeIds:   [],
            active:            true,
            createdBy:         req.user._id,
          });
          await syncMetricFrameworkFlags(mId);
        }
      } catch (mapErr) {
        console.error('[frameworkQuestionController] auto-create mapping failed for metric', mId, ':', mapErr.message);
      }
    }

    return res.status(201).json({ success: true, message: 'Question created', data: question });
  } catch (err) {
    console.error('[frameworkQuestionController] createQuestion:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const updateQuestion = async (req, res) => {
  try {
    const perm = canManageFrameworkQuestion(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const question = await EsgFrameworkQuestion.findById(req.params.questionId);
    if (!question || question.isDeleted) return res.status(404).json({ message: 'Question not found' });

    const block = blockPublishedEdit(question);
    if (block) return res.status(400).json({ message: block.message });

    const allowed = [
      'questionTitle', 'questionText', 'helpText', 'regulatoryReference',
      'disclosureType', 'answerMode', 'answerComponentType', 'answerSchema',
      'linkedMetricIds', 'linkedMetricCodes', 'linkedBoundaryRequired',
      'manualAnswerAllowed', 'autoAnswerAllowed', 'manualOverrideAllowed',
      'evidenceRequirement', 'evidenceInstructions', 'defaultOwnerRole',
      'reviewRequired', 'approvalRequired', 'applicability', 'displayOrder',
      'indicatorType', 'principleCode', 'subsectionCode',
    ];
    const update = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }

    const updated = await EsgFrameworkQuestion.findByIdAndUpdate(
      req.params.questionId,
      { $set: update },
      { new: true, runValidators: true }
    );

    return res.status(200).json({ success: true, message: 'Question updated', data: updated });
  } catch (err) {
    console.error('[frameworkQuestionController] updateQuestion:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const submitQuestion = async (req, res) => {
  try {
    const perm = canManageFrameworkQuestion(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const question = await EsgFrameworkQuestion.findById(req.params.questionId);
    if (!question || question.isDeleted) return res.status(404).json({ message: 'Question not found' });
    if (question.status !== 'draft') {
      return res.status(400).json({ message: `Only draft questions can be submitted. Current status: ${question.status}` });
    }

    question.status      = 'submitted_for_approval';
    question.submittedBy = req.user._id;
    await question.save();

    return res.status(200).json({ success: true, message: 'Question submitted for approval', data: question });
  } catch (err) {
    console.error('[frameworkQuestionController] submitQuestion:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const approveQuestion = async (req, res) => {
  try {
    const perm = canApproveQuestion(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const question = await EsgFrameworkQuestion.findById(req.params.questionId);
    if (!question || question.isDeleted) return res.status(404).json({ message: 'Question not found' });
    if (question.status !== 'submitted_for_approval') {
      return res.status(400).json({ message: `Only submitted questions can be approved. Current status: ${question.status}` });
    }

    question.status     = 'approved';
    question.approvedBy = req.user._id;
    await question.save();

    return res.status(200).json({ success: true, message: 'Question approved', data: question });
  } catch (err) {
    console.error('[frameworkQuestionController] approveQuestion:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const rejectQuestion = async (req, res) => {
  try {
    const perm = canApproveQuestion(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { rejectionReason } = req.body;
    if (!rejectionReason) return res.status(400).json({ message: 'rejectionReason is required' });

    const question = await EsgFrameworkQuestion.findById(req.params.questionId);
    if (!question || question.isDeleted) return res.status(404).json({ message: 'Question not found' });
    if (question.status !== 'submitted_for_approval') {
      return res.status(400).json({ message: `Only submitted questions can be rejected. Current status: ${question.status}` });
    }

    question.status          = 'rejected';
    question.rejectionReason = rejectionReason;
    await question.save();

    return res.status(200).json({ success: true, message: 'Question rejected', data: question });
  } catch (err) {
    console.error('[frameworkQuestionController] rejectQuestion:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const publishQuestion = async (req, res) => {
  try {
    const perm = canApproveQuestion(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const question = await EsgFrameworkQuestion.findById(req.params.questionId);
    if (!question || question.isDeleted) return res.status(404).json({ message: 'Question not found' });
    if (question.status !== 'approved') {
      return res.status(400).json({ message: `Only approved questions can be published. Current status: ${question.status}` });
    }

    question.status = 'published';
    await question.save();

    return res.status(200).json({ success: true, message: 'Question published', data: question });
  } catch (err) {
    console.error('[frameworkQuestionController] publishQuestion:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const versionQuestion = async (req, res) => {
  try {
    const perm = canManageFrameworkQuestion(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const result = await createDraftVersion(req.params.questionId, req.body, req.user._id);
    if (!result.success) return res.status(400).json({ message: result.message });

    return res.status(201).json({ success: true, message: result.message, data: result.data });
  } catch (err) {
    console.error('[frameworkQuestionController] versionQuestion:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const listQuestions = async (req, res) => {
  try {
    const { frameworkCode, sectionCode, principleCode, status, indicatorType, includeMappings } = req.query;

    const query = { isDeleted: false };
    if (frameworkCode) query.frameworkCode = frameworkCode.toUpperCase();
    if (sectionCode)   query.sectionCode   = sectionCode;
    if (principleCode) query.principleCode = principleCode;
    if (status)        query.status        = status;
    if (indicatorType) query.indicatorType = indicatorType;

    const questions = await EsgFrameworkQuestion.find(query)
      .sort({ sectionCode: 1, displayOrder: 1 })
      .lean();

    // Optional: attach framework-level metric mappings to each question
    // Call with ?includeMappings=true (e.g. in the assignment modal question dropdown)
    if (includeMappings === 'true' && questions.length) {
      const questionIds = questions.map((q) => q._id);
      const allMappings = await QuestionMetricMapping.find({
        questionId: { $in: questionIds },
        clientId:   null,
        active:     true,
      })
        .populate('metricId', 'metricCode metricName esgCategory primaryUnit')
        .lean();

      const byQuestion = {};
      for (const m of allMappings) {
        const qId = String(m.questionId);
        if (!byQuestion[qId]) byQuestion[qId] = [];
        byQuestion[qId].push(m);
      }

      const enriched = questions.map((q) => ({
        ...q,
        metricMappings:     byQuestion[String(q._id)] || [],
        metricMappingCount: (byQuestion[String(q._id)] || []).length,
      }));

      return res.status(200).json({ success: true, count: enriched.length, data: enriched });
    }

    return res.status(200).json({ success: true, count: questions.length, data: questions });
  } catch (err) {
    console.error('[frameworkQuestionController] listQuestions:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const getQuestion = async (req, res) => {
  try {
    const question = await EsgFrameworkQuestion.findById(req.params.questionId).lean();
    if (!question || question.isDeleted) return res.status(404).json({ message: 'Question not found' });

    // Optional: include the framework-level metric mappings (with metric details)
    // Call with ?includeMappings=true from the assignment modal or anywhere that needs them
    let metricMappings = undefined;
    if (req.query.includeMappings === 'true') {
      metricMappings = await QuestionMetricMapping.find({
        questionId: question._id,
        clientId:   null,
        active:     true,
      })
        .populate('metricId', 'metricCode metricName esgCategory primaryUnit')
        .lean();
    }

    return res.status(200).json({
      success: true,
      data: {
        ...question,
        ...(metricMappings !== undefined && { metricMappings }),
      },
    });
  } catch (err) {
    console.error('[frameworkQuestionController] getQuestion:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const getQuestionStats = async (req, res) => {
  try {
    const { frameworkCode } = req.query;
    const matchStage = { isDeleted: false };
    if (frameworkCode) matchStage.frameworkCode = frameworkCode.toUpperCase();

    const stats = await EsgFrameworkQuestion.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: { sectionCode: '$sectionCode', principleCode: '$principleCode', status: '$status' },
          count: { $sum: 1 },
        },
      },
      {
        $group: {
          _id:     { sectionCode: '$_id.sectionCode', principleCode: '$_id.principleCode' },
          byStatus: { $push: { status: '$_id.status', count: '$count' } },
          total:   { $sum: '$count' },
        },
      },
    ]);

    return res.status(200).json({ success: true, data: stats });
  } catch (err) {
    console.error('[frameworkQuestionController] getQuestionStats:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

module.exports = {
  createQuestion,
  updateQuestion,
  submitQuestion,
  approveQuestion,
  rejectQuestion,
  publishQuestion,
  versionQuestion,
  listQuestions,
  getQuestion,
  getQuestionStats,
};
