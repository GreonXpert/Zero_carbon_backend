'use strict';
/**
 * EsgLinkBoundary.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Stores the ESGLink Core Boundary — the organisational node/edge structure
 * used as the foundation for ESG data collection.
 *
 * Step 1 — node/edge skeleton
 * Step 3 — adds MetricDetailSchema (metricsDetails[]) + node workflow defaults
 */

const mongoose = require('mongoose');

// ── §2.6 Validation Rule sub-schema ──────────────────────────────────────────
const ValidationRuleSchema = new mongoose.Schema({
  validationRuleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ValidationRule',
    default: null   // always null in V1 — becomes FK when validation library ships
  },
  validationRuleName:   { type: String, default: '' },
  validationCode:       { type: String, default: '' },
  thresholdLogic:       { type: String, default: '' },
  anomalyFlagBehavior:  { type: String, default: '' },
  missingDataBehavior:  { type: String, default: '' },
  config:               { type: mongoose.Schema.Types.Mixed, default: {} },
  severity: {
    type: String,
    enum: ['info', 'warning', 'critical'],
    default: 'info'
  }
}, { _id: true });

// ── §2.5 Variable config sub-schema ──────────────────────────────────────────
const VariableConfigSchema = new mongoose.Schema({
  varName:      { type: String, required: true },
  updatePolicy: {
    type: String,
    enum: ['frozen', 'realtime', 'manual'],
    required: true
  },
  defaultValue: { type: mongoose.Schema.Types.Mixed, default: null },
  notes:        { type: String, default: '' }
}, { _id: true });

// ── Version history entry sub-schema ─────────────────────────────────────────
const VersionHistorySchema = new mongoose.Schema({
  mappingVersion: { type: Number },
  changedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  changedAt:      { type: Date, default: Date.now },
  changeSummary:  { type: String, default: '' },
  snapshot:       { type: mongoose.Schema.Types.Mixed }  // full mapping state before increment
}, { _id: false });

// ── MetricDetailSchema — Step 3 core ─────────────────────────────────────────
const MetricDetailSchema = new mongoose.Schema({

  // ── Identity ────────────────────────────────────────────────────────────────
  metricId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EsgMetric',
    required: true
  },
  metricCode: { type: String, default: '' },   // snapshot from EsgMetric at mapping time
  metricName: { type: String, default: '' },   // snapshot from EsgMetric at mapping time

  // ── Mapping status ───────────────────────────────────────────────────────────
  mappingStatus: {
    type: String,
    enum: ['draft', 'under_review', 'approved', 'rejected', 'active', 'inactive'],
    default: 'draft'
  },

  // ── §2.3 Collection and Reporting Behavior ───────────────────────────────────
  frequency:          { type: String, default: '' },
  boundaryScope:      { type: String, default: '' },
  rollUpBehavior:     { type: String, default: '' },
  reportingLevelNote: { type: String, default: '' },

  // ── §2.4 Source and References ───────────────────────────────────────────────
  allowedSourceTypes: [{ type: String }],
  defaultSourceType:  { type: String, default: null },
  zeroCarbonReference: { type: Boolean, default: false },
  zeroCarbonLink: {
    linkedBoundaryId: { type: mongoose.Schema.Types.ObjectId, ref: 'EsgLinkBoundary', default: null },
    linkedNodeId:     { type: String, default: '' },
    linkNote:         { type: String, default: '' }
  },
  ingestionInstructions: { type: String, default: '' },

  // ── §2.5 Derivation Logic ────────────────────────────────────────────────────
  // formulaId stays on EsgMetric as source of truth.
  // Snapshot captured at mapping time for audit stability.
  formulaVersionAtAssignment: { type: Number, default: null },
  formulaSnapshot: {
    formulaId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Formula', default: null },
    name:       { type: String, default: '' },
    expression: { type: String, default: '' },
    variables: [{
      name:  { type: String },
      label: { type: String },
      unit:  { type: String }
    }]
  },
  variableConfigs: [VariableConfigSchema],

  // ── §2.6 Quality and Validation ──────────────────────────────────────────────
  validationRules: [ValidationRuleSchema],

  // ── §2.7 Evidence and Auditability ───────────────────────────────────────────
  evidenceRequirement: {
    type: String,
    enum: ['none', 'optional', 'required'],
    default: 'none'
  },
  evidenceTypeNote:   { type: String, default: '' },
  auditTrailRequired: { type: Boolean, default: true },  // always true — hardcoded

  // ── §2.8 Workflow assignments ────────────────────────────────────────────────
  contributors:        [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  reviewers:           [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  approvers:           [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  inheritNodeReviewers: { type: Boolean, default: true },
  inheritNodeApprovers: { type: Boolean, default: true },
  approvalLevel: {
    type: String,
    enum: ['single', 'multi'],
    default: 'single'
  },

  // ── §2.10 System / Governance ────────────────────────────────────────────────
  createdBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt:      { type: Date, default: Date.now },
  updatedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedAt:      { type: Date, default: Date.now },
  mappingVersion: { type: Number, default: 1 },  // business version — do NOT use __v
  versionHistory: [VersionHistorySchema]

}, { _id: true });  // _id: true → each entry gets its own mappingId

// ── BoundaryNodeSchema ────────────────────────────────────────────────────────
const BoundaryNodeSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    description: 'Unique node identifier (matches ZeroCarbon node.id if imported)'
  },
  label: {
    type: String,
    required: true,
    trim: true
  },
  type: {
    type: String,
    enum: ['entity', 'department', 'site', 'subsidiary', 'holding', 'custom'],
    default: 'entity'
  },
  position: {
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 }
  },
  details: {
    name:       { type: String, default: '' },
    department: { type: String, default: '' },
    location:   { type: String, default: '' },
    entityType: { type: String, default: '' },
    notes:      { type: String, default: '' }
  },

  // ── Step 3: node-level workflow defaults ─────────────────────────────────────
  nodeReviewerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  nodeApproverIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  // ── Step 3: per-metric contextual mapping ─────────────────────────────────────
  metricsDetails: [MetricDetailSchema],

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { _id: false });

// ── BoundaryEdgeSchema ────────────────────────────────────────────────────────
const BoundaryEdgeSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true
  },
  source: {
    type: String,
    required: true,
    description: 'id of the source node'
  },
  target: {
    type: String,
    required: true,
    description: 'id of the target node'
  },
  label: {
    type: String,
    default: ''
  }
}, { _id: false });

// ── EsgLinkBoundarySchema ─────────────────────────────────────────────────────
const EsgLinkBoundarySchema = new mongoose.Schema(
  {
    clientId: {
      type: String,
      required: true,
      index: true,
      description: 'Matches Client.clientId'
    },

    setupMethod: {
      type: String,
      enum: ['imported_from_zero_carbon', 'manual'],
      required: true
    },

    importedFromFlowchartId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Flowchart',
      default: null
    },
    importedFromChartVersion: {
      type: Number,
      default: null
    },

    nodes: {
      type: [BoundaryNodeSchema],
      default: []
    },

    edges: {
      type: [BoundaryEdgeSchema],
      default: []
    },

    version: {
      type: Number,
      default: 1,
      description: 'Incremented on every save'
    },

    isActive: {
      type: Boolean,
      default: true
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    lastModifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },

    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

// ── Compound index — one active boundary per client ───────────────────────────
EsgLinkBoundarySchema.index({ clientId: 1, isActive: 1 });

// ── Field-level encryption — AES-256-GCM ─────────────────────────────────────
// nodes and edges (and now metricsDetails embedded inside nodes) are encrypted.
// All Step 3 reads/writes must use full Mongoose .findOne() + .save() lifecycle.
// Never use $push/$set directly on nodes — bypasses encryption plugin.
const encryptionPlugin = require('../../../../common/utils/mongooseEncryptionPlugin');
EsgLinkBoundarySchema.plugin(encryptionPlugin, {
  fields: ['nodes', 'edges'],
});

module.exports = mongoose.model('EsgLinkBoundary', EsgLinkBoundarySchema);
