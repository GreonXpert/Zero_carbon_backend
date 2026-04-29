'use strict';

const mongoose = require('mongoose');

const REPORT_STATUS_ENUM = ['draft', 'final'];

const SnapshotItemSchema = new mongoose.Schema(
  {
    questionId:    { type: mongoose.Schema.Types.ObjectId, ref: 'EsgFrameworkQuestion' },
    questionCode:  { type: String },
    questionTitle: { type: String },
    questionText:  { type: String },
    sectionCode:   { type: String },
    principleCode: { type: String },
    indicatorType: { type: String },
    answerSource:  { type: String },
    answerData:    { type: mongoose.Schema.Types.Mixed, default: null },
    coreSnapshot:  { type: [mongoose.Schema.Types.Mixed], default: [] },
    evidenceLinks: { type: [mongoose.Schema.Types.Mixed], default: [] },
    finalStatus:   { type: String },
    approvedAt:    { type: Date, default: null },
  },
  { _id: false }
);

const brsrFinalReportSchema = new mongoose.Schema(
  {
    clientId: {
      type:     String,
      required: [true, 'clientId is required'],
      index:    true,
    },
    frameworkCode: {
      type:     String,
      required: [true, 'frameworkCode is required'],
      trim:     true,
      uppercase: true,
    },
    periodId: {
      type:     String,
      required: [true, 'periodId is required'],
      trim:     true,
      // e.g. '2024-25'
    },
    reportingYear: {
      type:     Number,
      required: [true, 'reportingYear is required'],
    },
    instanceId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'ClientFrameworkInstance',
      required: [true, 'instanceId is required'],
    },
    consultantId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: [true, 'consultantId is required'],
    },
    approvedAt: {
      type:    Date,
      default: null,
    },
    totalQuestions: {
      type:    Number,
      default: 0,
    },
    totalAnswers: {
      type:    Number,
      default: 0,
    },
    metricLinkedCount: {
      type:    Number,
      default: 0,
      // Count of answers where answerSource is 'core_metric' or 'hybrid'
    },
    snapshot: {
      type:    [SnapshotItemSchema],
      default: [],
    },
    status: {
      type:    String,
      enum:    REPORT_STATUS_ENUM,
      default: 'final',
    },
  },
  {
    timestamps:  true,
    versionKey:  false,
    collection:  'esg_brsr_final_reports',
  }
);

brsrFinalReportSchema.index(
  { clientId: 1, frameworkCode: 1, periodId: 1 },
  { unique: true }
);

module.exports = mongoose.model('BrsrFinalReport', brsrFinalReportSchema);
module.exports.REPORT_STATUS_ENUM = REPORT_STATUS_ENUM;
