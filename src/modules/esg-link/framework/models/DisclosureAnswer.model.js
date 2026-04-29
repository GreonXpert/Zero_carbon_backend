'use strict';

const mongoose = require('mongoose');

const ANSWER_SOURCE_ENUM       = ['core_metric', 'manual', 'hybrid'];
const APPLICABILITY_STATUS_ENUM = ['applicable', 'not_applicable', 'conditional'];
const ANSWER_STATUS_ENUM       = [
  'not_started',
  'in_progress',
  'submitted_to_reviewer',
  'reviewer_changes_requested',
  'resubmitted_to_reviewer',
  'reviewer_approved',
  'submitted_to_approver',
  'approver_query_to_reviewer',
  'reviewer_response_pending',
  'contributor_clarification_required',
  'contributor_clarification_submitted',
  'final_approved',
  'locked',
];

const SourceTraceSchema = new mongoose.Schema(
  {
    metricId:      { type: mongoose.Schema.Types.ObjectId, ref: 'EsgMetric' },
    metricCode:    { type: String },
    mappingId:     { type: mongoose.Schema.Types.ObjectId },
    value:         { type: mongoose.Schema.Types.Mixed },
    unit:          { type: String },
    boundaryDocId: { type: mongoose.Schema.Types.ObjectId },
    summaryLayer:  { type: String },
    snapshotAt:    { type: Date },
  },
  { _id: false }
);

const CoreSnapshotSchema = new mongoose.Schema(
  {
    metricId:      { type: mongoose.Schema.Types.ObjectId, ref: 'EsgMetric' },
    metricCode:    { type: String },
    value:         { type: mongoose.Schema.Types.Mixed },
    unit:          { type: String },
    snapshotAt:    { type: Date },
  },
  { _id: false }
);

const EvidenceLinkEmbedSchema = new mongoose.Schema(
  {
    evidenceId:    { type: mongoose.Schema.Types.ObjectId, ref: 'EsgEvidenceLink' },
    evidenceType:  { type: String },
    title:         { type: String },
    url:           { type: String },
  },
  { _id: false }
);

const ManualOverrideSchema = new mongoose.Schema(
  {
    isOverridden:   { type: Boolean, default: false },
    originalValue:  { type: mongoose.Schema.Types.Mixed, default: null },
    newValue:       { type: mongoose.Schema.Types.Mixed, default: null },
    reason:         { type: String, default: null },
    overriddenBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    overriddenAt:   { type: Date, default: null },
  },
  { _id: false }
);

const disclosureAnswerSchema = new mongoose.Schema(
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
    assignmentId: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'QuestionAssignment',
      default: null,
    },
    answerSource: {
      type:    String,
      enum:    ANSWER_SOURCE_ENUM,
      default: 'manual',
    },
    // The final answer submitted by the contributor (may include manual overrides)
    answerData: {
      type:    mongoose.Schema.Types.Mixed,
      default: null,
    },
    // Auto-filled data fetched from Core summary (read-only reference)
    autoFilledData: {
      type:    mongoose.Schema.Types.Mixed,
      default: null,
    },
    // Core metric values frozen at submission time
    coreSnapshot: {
      type:    [CoreSnapshotSchema],
      default: [],
    },
    // Trace of which Core summary values were used and how
    sourceTrace: {
      type:    [SourceTraceSchema],
      default: [],
    },
    evidenceIds: {
      type:    [mongoose.Schema.Types.ObjectId],
      ref:     'EsgEvidenceLink',
      default: [],
    },
    evidenceLinks: {
      type:    [EvidenceLinkEmbedSchema],
      default: [],
    },
    manualOverride: {
      type:    ManualOverrideSchema,
      default: () => ({}),
    },

    // ── Consultant sign-off on auto-filled Core metric data ───────────────────
    // Only relevant when answerSource is 'core_metric' or 'hybrid'.
    // Must be isApproved=true for all metric-linked answers before
    // consultantFinalApprove can proceed.
    consultantMetricApproval: {
      isApproved: { type: Boolean, default: false },
      approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      approvedAt: { type: Date, default: null },
      notes:      { type: String, default: null },
    },

    applicabilityStatus: {
      type:    String,
      enum:    APPLICABILITY_STATUS_ENUM,
      default: 'applicable',
    },
    naReason: {
      type:    String,
      trim:    true,
      default: null,
    },
    assignedContributor: {
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
    status: {
      type:    String,
      enum:    ANSWER_STATUS_ENUM,
      default: 'not_started',
      index:   true,
    },
    submittedAt: {
      type:    Date,
      default: null,
    },
    reviewedAt: {
      type:    Date,
      default: null,
    },
    approvedAt: {
      type:    Date,
      default: null,
    },
    lockedAt: {
      type:    Date,
      default: null,
    },
    createdBy: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: [true, 'createdBy is required'],
    },
    updatedBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'User',
      default: null,
    },
  },
  {
    timestamps:  true,
    versionKey:  false,
    collection:  'esg_disclosure_answers',
  }
);

disclosureAnswerSchema.index(
  { clientId: 1, periodId: 1, questionId: 1 },
  { unique: true }
);
disclosureAnswerSchema.index({ clientId: 1, periodId: 1, frameworkCode: 1, status: 1 });
disclosureAnswerSchema.index({ assignmentId: 1 });

module.exports = mongoose.model('DisclosureAnswer', disclosureAnswerSchema);
module.exports.ANSWER_SOURCE_ENUM        = ANSWER_SOURCE_ENUM;
module.exports.APPLICABILITY_STATUS_ENUM = APPLICABILITY_STATUS_ENUM;
module.exports.ANSWER_STATUS_ENUM        = ANSWER_STATUS_ENUM;
