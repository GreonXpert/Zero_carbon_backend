const mongoose = require('mongoose');

const { Schema } = mongoose;

// ─── Approval Decision Sub-Schema ────────────────────────────────────────────
const ApprovalDecisionSchema = new Schema(
  {
    approverId:   { type: Schema.Types.ObjectId, ref: 'User', required: true },
    approverType: { type: String }, // snapshot: 'approver' | 'consultant' | 'consultant_admin'
    decision:     { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    note:         { type: String, maxlength: 1000 },
    decidedAt:    { type: Date },
  },
  { _id: true }
);

// ─── Evidence Sub-Schema ─────────────────────────────────────────────────────
const EvidenceSchema = new Schema(
  {
    evidenceType: { type: String, enum: ['file', 'url'], required: true, default: 'file' },
    fileName:     { type: String, required: true },
    s3Key:        { type: String },   // set only when evidenceType = 'file'
    url:          { type: String },   // set only when evidenceType = 'url'
    mimeType:     { type: String },
    fileSize:     { type: Number },   // bytes; set only when evidenceType = 'file'
    uploadedBy:   { type: Schema.Types.ObjectId, ref: 'User' },
    uploadedAt:   { type: Date, default: Date.now },
    description:  { type: String },
  },
  { _id: true }
);

EvidenceSchema.path('s3Key').validate(function () {
  if (this.evidenceType === 'file' && !this.s3Key) return false;
  return true;
}, 's3Key is required when evidenceType is "file"');

EvidenceSchema.path('url').validate(function () {
  if (this.evidenceType === 'url' && !this.url) return false;
  return true;
}, 'url is required when evidenceType is "url"');

// ─── Validation Result Sub-Schema ────────────────────────────────────────────
const ValidationResultSchema = new Schema(
  {
    passed:      { type: Boolean },
    errors:      [{ field: String, message: String, severity: String }],
    validatedAt: { type: Date },
  },
  { _id: false }
);

// ─── Main Schema ─────────────────────────────────────────────────────────────
const EsgDataEntrySchema = new Schema(
  {
    // ── Ownership chain ──────────────────────────────────────────────────────
    clientId:      { type: String, required: true, index: true },
    boundaryDocId: { type: Schema.Types.ObjectId, ref: 'EsgLinkBoundary' },
    nodeId:        { type: String, required: true, index: true },
    mappingId:     { type: String, required: true, index: true }, // MetricDetailSchema._id
    metricId:      { type: Schema.Types.ObjectId, ref: 'EsgMetric', index: true },

    // ── Period ───────────────────────────────────────────────────────────────
    period: {
      year:        { type: Number, required: true },
      periodLabel: { type: String, required: true }, // "2024-03" | "2024-Q1" | "2024"
      frequency:   { type: String }, // snapshot from mapping at creation time
    },

    // ── Source & Input ───────────────────────────────────────────────────────
    submissionSource: {
      type:    String,
      enum:    ['contributor', 'api', 'iot', 'system_import'],
      default: 'contributor',
    },
    inputType: {
      type: String,
      enum: ['manual', 'ocr', 'csv', 'excel', 'api', 'iot'],
      default: 'manual',
    },

    // ── Data Values ──────────────────────────────────────────────────────────
    dataValues:        { type: Map, of: Schema.Types.Mixed },
    unitOfMeasurement: { type: String },

    // ── Derived / Formula ────────────────────────────────────────────────────
    calculatedValue: { type: Number, default: null },
    derivedFrom: {
      formulaId:      { type: Schema.Types.ObjectId },
      expression:     { type: String },
      variableValues: { type: Schema.Types.Mixed }, // frozen snapshot at calculation time
    },

    // ── Workflow Status ──────────────────────────────────────────────────────
    workflowStatus: {
      type:    String,
      enum:    ['draft', 'submitted', 'under_review', 'clarification_requested',
                'resubmitted', 'approved', 'rejected', 'superseded'],
      default: 'draft',
      index:   true,
    },

    // ── Versioning (for superseded chain) ────────────────────────────────────
    version:      { type: Number, default: 1 },
    supersededBy: { type: Schema.Types.ObjectId, ref: 'EsgDataEntry', default: null },
    supersedes:   { type: Schema.Types.ObjectId, ref: 'EsgDataEntry', default: null },

    // ── Submission Tracking ──────────────────────────────────────────────────
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    submittedAt: { type: Date, default: null },

    // ── Evidence Files ───────────────────────────────────────────────────────
    evidence: [EvidenceSchema],

    // ── API/IoT Ingestion Trace ──────────────────────────────────────────────
    rawPayload:              { type: Schema.Types.Mixed },
    ingestionIdempotencyKey: { type: String, sparse: true }, // unique sparse — set below

    // ── Multi-Approver Decisions ─────────────────────────────────────────────
    // Populated when workflowStatus first reaches under_review.
    // Each entry = one assigned approver's decision.
    // Status → 'approved' when approvalPercentage >= 50%.
    // Consultant fast-track: if >= 75% of approvers are consultants AND
    // all consultant-approvers approved → already >= 75% > 50% threshold.
    approvalDecisions: [ApprovalDecisionSchema],

    // ── Validation ───────────────────────────────────────────────────────────
    validationResult:  ValidationResultSchema,
    auditTrailRequired: { type: Boolean, default: true }, // always true, copied from mapping

    // ── OCR Metadata ─────────────────────────────────────────────────────────
    ocrConfidence: { type: Number }, // 0–1, set when inputType = 'ocr'

    // ── Soft Delete ──────────────────────────────────────────────────────────
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// ─── Indexes ─────────────────────────────────────────────────────────────────
EsgDataEntrySchema.index({ clientId: 1, workflowStatus: 1 });
EsgDataEntrySchema.index({ clientId: 1, nodeId: 1, mappingId: 1, 'period.year': 1 });
EsgDataEntrySchema.index({
  clientId: 1,
  nodeId: 1,
  mappingId: 1,
  workflowStatus: 1,
  'period.year': 1,
});
EsgDataEntrySchema.index({ submittedBy: 1 });
EsgDataEntrySchema.index(
  { ingestionIdempotencyKey: 1 },
  { unique: true, sparse: true }
);

// ─── Virtual: approval percentage ────────────────────────────────────────────
EsgDataEntrySchema.virtual('approvalPercentage').get(function () {
  const decisions = this.approvalDecisions;
  if (!decisions || decisions.length === 0) return 0;
  const approved = decisions.filter((d) => d.decision === 'approved').length;
  return (approved / decisions.length) * 100;
});

EsgDataEntrySchema.virtual('rejectionPercentage').get(function () {
  const decisions = this.approvalDecisions;
  if (!decisions || decisions.length === 0) return 0;
  const rejected = decisions.filter((d) => d.decision === 'rejected').length;
  return (rejected / decisions.length) * 100;
});

module.exports = mongoose.model('EsgDataEntry', EsgDataEntrySchema, 'esg_data_entries');
