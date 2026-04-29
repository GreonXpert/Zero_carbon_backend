'use strict';

const QuestionAssignment          = require('../models/QuestionAssignment.model');
const EsgFramework                = require('../models/Framework.model');
const { canAssignQuestion, canViewClientBrsr } = require('../services/frameworkAccessService');
const { getMyQuestions }          = require('../services/assignmentResolverService');

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

    if (!periodId)     return res.status(400).json({ message: 'periodId is required' });
    if (!frameworkId)  return res.status(400).json({ message: 'frameworkId is required' });
    if (!frameworkCode) return res.status(400).json({ message: 'frameworkCode is required' });
    if (!questionId)   return res.status(400).json({ message: 'questionId is required' });
    if (!questionCode) return res.status(400).json({ message: 'questionCode is required' });

    const assignment = await QuestionAssignment.create({
      clientId,
      periodId,
      frameworkId,
      frameworkCode: frameworkCode.toUpperCase(),
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

    return res.status(201).json({ success: true, message: 'Assignment created', data: assignment });
  } catch (err) {
    console.error('[assignmentController] createAssignment:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const listAssignments = async (req, res) => {
  try {
    const { clientId } = req.params;
    const perm = await canViewClientBrsr(req.user, clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { periodId, frameworkCode, questionId, contributorId } = req.query;
    const query = { clientId };
    if (periodId)      query.periodId      = periodId;
    if (frameworkCode) query.frameworkCode = frameworkCode.toUpperCase();
    if (questionId)    query.questionId    = questionId;
    if (contributorId) query.contributorId = contributorId;

    const assignments = await QuestionAssignment.find(query)
      .populate('contributorId', 'name email')
      .populate('reviewerId',    'name email')
      .populate('approverId',    'name email')
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ success: true, count: assignments.length, data: assignments });
  } catch (err) {
    console.error('[assignmentController] listAssignments:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const getMyAssignedQuestions = async (req, res) => {
  try {
    const { clientId } = req.params;
    const perm = await canViewClientBrsr(req.user, clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { periodId, frameworkCode } = req.query;
    if (!periodId) return res.status(400).json({ message: 'periodId query param is required' });

    const questions = await getMyQuestions(req.user._id, clientId, periodId, frameworkCode);
    return res.status(200).json({ success: true, count: questions.length, data: questions });
  } catch (err) {
    console.error('[assignmentController] getMyAssignedQuestions:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

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

    return res.status(200).json({ success: true, message: 'Assignment updated', data: updated });
  } catch (err) {
    console.error('[assignmentController] updateAssignment:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

module.exports = { createAssignment, listAssignments, getMyAssignedQuestions, updateAssignment };
