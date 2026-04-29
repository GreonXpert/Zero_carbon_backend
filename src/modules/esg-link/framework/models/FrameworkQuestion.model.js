'use strict';

const mongoose = require('mongoose');

const INDICATOR_TYPE_ENUM       = ['essential', 'leadership', 'core', 'general', 'management'];
const DISCLOSURE_TYPE_ENUM      = ['quantitative', 'qualitative', 'mixed'];
const ANSWER_MODE_ENUM          = ['auto_mapped', 'manual', 'hybrid', 'narrative', 'table', 'matrix'];
const ANSWER_COMPONENT_ENUM     = [
  'number_input', 'text_input', 'boolean', 'dropdown', 'multi_select',
  'date_picker', 'table_grid', 'matrix_grid', 'file_upload', 'rich_text',
  'percentage', 'ratio', 'currency', 'unit_value', 'yes_no_na', 'ranking',
];
const EVIDENCE_REQUIREMENT_ENUM = ['required', 'recommended', 'optional', 'not_applicable'];
const QUESTION_STATUS_ENUM      = [
  'draft', 'submitted_for_approval', 'approved', 'published', 'rejected', 'retired',
];

const frameworkQuestionSchema = new mongoose.Schema(
  {
    frameworkId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'EsgFramework',
      required: [true, 'frameworkId is required'],
      index:    true,
    },
    frameworkCode: {
      type:     String,
      required: [true, 'frameworkCode is required'],
      trim:     true,
      uppercase: true,
    },
    questionCode: {
      type:     String,
      required: [true, 'questionCode is required'],
      trim:     true,
      // e.g. 'BRSR-A-Q1', 'BRSR-C-P1-E-Q1'
    },
    questionVersion: {
      type:    Number,
      default: 1,
      // Incremented when a published question is edited via createDraftVersion()
    },
    sectionCode: {
      type:     String,
      required: [true, 'sectionCode is required'],
      trim:     true,
    },
    principleCode: {
      type:    String,
      trim:    true,
      default: null,
    },
    subsectionCode: {
      type:    String,
      trim:    true,
      default: null,
    },
    indicatorType: {
      type: String,
      enum: INDICATOR_TYPE_ENUM,
      default: 'essential',
    },
    questionTitle: {
      type:    String,
      trim:    true,
      default: null,
      // Short label for the question
    },
    questionText: {
      type:     String,
      required: [true, 'questionText is required'],
      trim:     true,
    },
    helpText: {
      type:    String,
      trim:    true,
      default: null,
    },
    regulatoryReference: {
      type:    String,
      trim:    true,
      default: null,
      // e.g. 'SEBI Circular SEBI/HO/CFD/CMD1/CIR/P/2021/562'
    },
    disclosureType: {
      type:    String,
      enum:    DISCLOSURE_TYPE_ENUM,
      default: 'quantitative',
    },
    answerMode: {
      type:    String,
      enum:    ANSWER_MODE_ENUM,
      default: 'manual',
    },
    answerComponentType: {
      type:    String,
      enum:    ANSWER_COMPONENT_ENUM,
      default: 'text_input',
    },
    answerSchema: {
      type:    mongoose.Schema.Types.Mixed,
      default: null,
      // Free-form schema for complex table/matrix answer structures
    },
    linkedMetricIds: {
      type:    [mongoose.Schema.Types.ObjectId],
      ref:     'EsgMetric',
      default: [],
    },
    linkedMetricCodes: {
      type:    [String],
      default: [],
    },
    linkedBoundaryRequired: {
      type:    Boolean,
      default: false,
    },
    manualAnswerAllowed: {
      type:    Boolean,
      default: true,
    },
    autoAnswerAllowed: {
      type:    Boolean,
      default: false,
    },
    manualOverrideAllowed: {
      type:    Boolean,
      default: true,
    },
    evidenceRequirement: {
      type:    String,
      enum:    EVIDENCE_REQUIREMENT_ENUM,
      default: 'optional',
    },
    evidenceInstructions: {
      type:    String,
      trim:    true,
      default: null,
    },
    defaultOwnerRole: {
      type:    String,
      trim:    true,
      default: null,
      // e.g. 'consultant', 'client_admin', 'contributor'
    },
    reviewRequired: {
      type:    Boolean,
      default: true,
    },
    approvalRequired: {
      type:    Boolean,
      default: true,
    },
    applicability: {
      isConditional:       { type: Boolean, default: false },
      conditionQuestionCode: { type: String, default: null },
      conditionValue:      { type: mongoose.Schema.Types.Mixed, default: null },
    },
    displayOrder: {
      type:    Number,
      default: 0,
    },
    status: {
      type:    String,
      enum:    QUESTION_STATUS_ENUM,
      default: 'draft',
    },
    createdBy: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: [true, 'createdBy is required'],
    },
    submittedBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'User',
      default: null,
    },
    approvedBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'User',
      default: null,
    },
    rejectionReason: {
      type:    String,
      trim:    true,
      default: null,
    },
    isDeleted: {
      type:    Boolean,
      default: false,
    },
    deletedAt: {
      type:    Date,
      default: null,
    },
    deletedBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'User',
      default: null,
    },
  },
  {
    timestamps:  true,
    versionKey:  false,
    collection:  'esg_framework_questions',
  }
);

frameworkQuestionSchema.index(
  { frameworkCode: 1, questionCode: 1, questionVersion: 1 },
  { unique: true }
);
frameworkQuestionSchema.index({ frameworkCode: 1, sectionCode: 1, status: 1, isDeleted: 1 });
frameworkQuestionSchema.index({ frameworkCode: 1, principleCode: 1, status: 1, isDeleted: 1 });

module.exports = mongoose.model('EsgFrameworkQuestion', frameworkQuestionSchema);
module.exports.INDICATOR_TYPE_ENUM       = INDICATOR_TYPE_ENUM;
module.exports.DISCLOSURE_TYPE_ENUM      = DISCLOSURE_TYPE_ENUM;
module.exports.ANSWER_MODE_ENUM          = ANSWER_MODE_ENUM;
module.exports.ANSWER_COMPONENT_ENUM     = ANSWER_COMPONENT_ENUM;
module.exports.EVIDENCE_REQUIREMENT_ENUM = EVIDENCE_REQUIREMENT_ENUM;
module.exports.QUESTION_STATUS_ENUM      = QUESTION_STATUS_ENUM;
