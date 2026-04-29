'use strict';

const mongoose = require('mongoose');

const ASSIGNMENT_PRIORITY_ENUM = ['low', 'medium', 'high', 'critical'];
const ASSIGNMENT_TYPE_ENUM     = ['metric_based', 'manual'];
const ASSIGNMENT_STATUS_ENUM   = ['assigned', 'in_progress', 'submitted', 'reviewed', 'approved'];

const questionAssignmentSchema = new mongoose.Schema(
  {
    clientId: {
      type:     String,
      required: [true, 'clientId is required'],
      index:    true,
    },
    periodId: {
      type:     String,
      required: [true, 'periodId is required'],
      trim:     true,
    },
    frameworkId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'EsgFramework',
      required: [true, 'frameworkId is required'],
    },
    frameworkCode: {
      type:     String,
      required: [true, 'frameworkCode is required'],
      trim:     true,
      uppercase: true,
    },
    questionId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'EsgFrameworkQuestion',
      required: [true, 'questionId is required'],
      index:    true,
    },
    questionCode: {
      type:     String,
      required: [true, 'questionCode is required'],
      trim:     true,
    },
    contributorId: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'User',
      default: null,
    },
    reviewerId: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'User',
      default: null,
    },
    approverId: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'User',
      default: null,
    },
    assignedBy: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: [true, 'assignedBy is required'],
    },
    dueDate: {
      type:    Date,
      default: null,
    },
    priority: {
      type:    String,
      enum:    ASSIGNMENT_PRIORITY_ENUM,
      default: 'medium',
    },
    assignmentType: {
      type:    String,
      enum:    ASSIGNMENT_TYPE_ENUM,
      default: 'manual',
    },
    metricIds: {
      type:    [mongoose.Schema.Types.ObjectId],
      ref:     'EsgMetric',
      default: [],
    },
    status: {
      type:    String,
      enum:    ASSIGNMENT_STATUS_ENUM,
      default: 'assigned',
    },
  },
  {
    timestamps:  true,
    versionKey:  false,
    collection:  'esg_question_assignments',
  }
);

questionAssignmentSchema.index({ clientId: 1, periodId: 1, frameworkCode: 1 });
questionAssignmentSchema.index({ contributorId: 1, clientId: 1, periodId: 1 });
questionAssignmentSchema.index({ clientId: 1, periodId: 1, questionId: 1 });

module.exports = mongoose.model('QuestionAssignment', questionAssignmentSchema);
module.exports.ASSIGNMENT_PRIORITY_ENUM = ASSIGNMENT_PRIORITY_ENUM;
module.exports.ASSIGNMENT_TYPE_ENUM     = ASSIGNMENT_TYPE_ENUM;
module.exports.ASSIGNMENT_STATUS_ENUM   = ASSIGNMENT_STATUS_ENUM;
