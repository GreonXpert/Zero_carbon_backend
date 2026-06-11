'use strict';

const mongoose = require('mongoose');

const snapshotSchema = new mongoose.Schema(
  {
    snapshotId: { type: String, required: true },
    type:       { type: String, enum: ['generated', 'edited', 'finalized'], required: true },
    s3Key:      { type: String, required: true },
    createdAt:  { type: Date, default: Date.now },
    createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    note:       { type: String, default: '' }
  },
  { _id: false }
);

const exportEntrySchema = new mongoose.Schema(
  {
    exportId:          { type: String, required: true },
    format:            { type: String, enum: ['pdf', 'docx'], required: true },
    s3Key:             { type: String, required: true },
    fileSize:          { type: Number, default: 0 },
    exportedAt:        { type: Date, default: Date.now },
    exportedBy:        { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    brandingApplied:   { type: Boolean, default: false },
    signedUrlExpiresAt:{ type: Date }
  },
  { _id: false }
);

const ragReportSchema = new mongoose.Schema(
  {
    templateId:        { type: mongoose.Schema.Types.ObjectId, ref: 'RagTemplate',        required: true },
    templateVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'RagTemplateVersion', required: true },
    templateSnapshot: {
      name:    { type: String },
      version: { type: Number },
      type:    { type: String }
    },

    // clientId in this app is a custom string (e.g. "Greon008"), NOT a MongoDB ObjectId
    organizationId: { type: String, required: true },
    createdBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    title:          { type: String, default: 'Untitled Report' },
    reportingYear:  { type: Number },
    reportingPeriod: {
      start: { type: Date },
      end:   { type: Date }
    },

    status: {
      type: String,
      enum: ['queued', 'generating', 'draft', 'edited', 'finalized', 'failed'],
      default: 'queued'
    },

    generationJob: {
      jobId:        { type: String },
      queuedAt:     { type: Date },
      startedAt:    { type: Date },
      completedAt:  { type: Date },
      failedAt:     { type: Date },
      errorMessage: { type: String },
      attempts:     { type: Number, default: 0 }
    },

    snapshots:        [snapshotSchema],
    activeSnapshotId: { type: String },

    brandingId:       { type: mongoose.Schema.Types.ObjectId },
    brandingSnapshot: {
      name:         { type: String },
      primaryColor: { type: String },
      logoS3Key:    { type: String }
    },

    exports: [exportEntrySchema],

    generationCount: { type: Number, default: 0 },
    lastGeneratedAt: { type: Date },
    finalizedAt:     { type: Date },
    finalizedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    isDeleted:  { type: Boolean, default: false }
  },
  { timestamps: true }
);

ragReportSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
ragReportSchema.index({ templateId: 1 });
ragReportSchema.index({ createdBy: 1, createdAt: -1 });
ragReportSchema.index({ 'generationJob.jobId': 1 });
ragReportSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('RagReport', ragReportSchema, 'rag_reports');
