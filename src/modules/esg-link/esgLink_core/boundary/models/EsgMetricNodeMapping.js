'use strict';
/**
 * EsgMetricNodeMapping.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Step 3: Maps an ESGLink metric from the library to a specific boundary node.
 * One mapping per (clientId, boundaryNodeId, metricId) — enforced by compound
 * unique index.
 */

const mongoose = require('mongoose');

const ValidationRuleSchema = new mongoose.Schema(
  {
    validationRuleId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null
    },
    validationRuleName: { type: String, trim: true },
    validationCode:     { type: String, trim: true },
    thresholdLogic:     { type: String, trim: true },
    anomalyFlagBehavior: {
      type: String,
      enum: ['warn_and_hold', 'flag_only', 'block'],
      default: 'warn_and_hold'
    },
    missingDataBehavior: {
      type: String,
      enum: ['use_previous_period', 'use_zero', 'flag_missing'],
      default: 'flag_missing'
    },
    config:   { type: mongoose.Schema.Types.Mixed, default: {} },
    severity: { type: String, enum: ['info', 'warning', 'error'], default: 'warning' }
  },
  { _id: false }
);

const EsgMetricNodeMappingSchema = new mongoose.Schema(
  {
    // ── Scope ─────────────────────────────────────────────────────────────────
    clientId: {
      type: String,
      required: [true, 'clientId is required'],
      index: true
    },
    // node.id string inside the EsgLinkBoundary nodes array
    boundaryNodeId: {
      type: String,
      required: [true, 'boundaryNodeId is required']
    },
    // parent EsgLinkBoundary document
    boundaryDocId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EsgLinkBoundary',
      required: [true, 'boundaryDocId is required']
    },
    metricId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EsgMetric',
      required: [true, 'metricId is required']
    },

    // ── Mapping configuration ─────────────────────────────────────────────────
    mappingStatus: {
      type: String,
      enum: ['draft', 'active', 'archived'],
      default: 'draft'
    },
    frequency: {
      type: String,
      enum: ['daily', 'weekly', 'monthly', 'quarterly', 'annually'],
      required: [true, 'frequency is required']
    },
    boundaryScope:      { type: String, trim: true, default: '' },
    rollUpBehavior: {
      type: String,
      enum: ['sum', 'average', 'max', 'min', 'none'],
      default: 'sum'
    },
    reportingLevelNote: { type: String, trim: true, default: '' },

    // ── Data ingestion ────────────────────────────────────────────────────────
    allowedSourceTypes: {
      type: [String],
      enum: ['manual', 'api', 'iot'],
      default: ['manual']
    },
    defaultSourceType: {
      type: String,
      enum: ['manual', 'api', 'iot'],
      default: 'manual'
    },
    zeroCarbonReference:    { type: Boolean, default: false },
    ingestionInstructions:  { type: String, trim: true, default: '' },

    // ── Validation rules ──────────────────────────────────────────────────────
    validationRules: {
      type: [ValidationRuleSchema],
      default: []
    },

    // ── Evidence ──────────────────────────────────────────────────────────────
    evidenceRequirement: {
      type: String,
      enum: ['required', 'optional', 'none'],
      default: 'optional'
    },
    evidenceTypeNote: { type: String, trim: true, default: '' },

    // ── Workflow assignees ────────────────────────────────────────────────────
    contributors: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    reviewers:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    approvers:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    inheritNodeReviewers: { type: Boolean, default: false },
    inheritNodeApprovers: { type: Boolean, default: false },
    approvalLevel: {
      type: String,
      enum: ['single', 'multi'],
      default: 'single'
    },

    // ── Ownership ─────────────────────────────────────────────────────────────
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    // ── Soft delete ───────────────────────────────────────────────────────────
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  {
    timestamps: true,
    versionKey: false,
    collection: 'esg_metric_node_mappings'
  }
);

// One active mapping per metric per node per client
EsgMetricNodeMappingSchema.index(
  { clientId: 1, boundaryNodeId: 1, metricId: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);

EsgMetricNodeMappingSchema.index({ clientId: 1, boundaryNodeId: 1, isDeleted: 1 });
EsgMetricNodeMappingSchema.index({ clientId: 1, metricId: 1, isDeleted: 1 });

module.exports = mongoose.model('EsgMetricNodeMapping', EsgMetricNodeMappingSchema);
