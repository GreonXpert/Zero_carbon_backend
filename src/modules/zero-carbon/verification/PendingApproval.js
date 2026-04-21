// models/PendingApproval/PendingApproval.js
const mongoose = require("mongoose");

/**
 * PendingApproval
 * Holds DataEntry or NetReductionEntry data that was intercepted by the
 * threshold verification layer because the incoming value deviated beyond
 * the configured threshold percentage.
 *
 * The original payload is stored here so it can be replayed when approved.
 * Nothing is written to DataEntry or NetReductionEntry until consultant_admin approves.
 */
const VerificationMetaSchema = new mongoose.Schema(
  {
    normalizedIncomingValue: { type: Number },
    historicalAverageDailyValue: { type: Number },
    deviationPercentage: { type: Number },
    thresholdPercentage: { type: Number },
    sampleCount: { type: Number },
    frequency: { type: String },
    anomalyReason: { type: String }
  },
  { _id: false }
);

const PendingApprovalSchema = new mongoose.Schema(
  {
    // Which flow this record belongs to
    flowType: {
      type: String,
      enum: ["dataEntry", "netReduction"],
      required: true,
      index: true
    },

    clientId: {
      type: String,
      required: true,  
      index: true
    },

    // ── DataEntry context ──────────────────────────────────────────────
    nodeId: { type: String },
    scopeIdentifier: { type: String },

    // ── NetReduction context of Reduction ───────────────────────────────────────────
    projectId: { type: String },
    calculationMethodology: { type: String },

    // ── Common ────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ["Pending_Approval", "Approved", "Rejected"],
      default: "Pending_Approval",
      index: true
    },

    inputType: { type: String },

    // Full normalized payload needed to replay the save on approval
    originalPayload: {
      type: mongoose.Schema.Types.Mixed
    },

    // Computed anomaly comparison metadata
    verificationMeta: {
      type: VerificationMetaSchema
    },

    // Who submitted the original entry
    submittedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },

    submittedByType: { type: String },

    submittedAt: {
      type: Date,
      default: Date.now
    },

    // Who reviewed (approved/rejected) this record
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },

    reviewedAt: { type: Date },

    rejectionReason: { type: String },

    // The Notification document created when anomaly was detected
    notificationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Notification"
    },

    // Set after approval: the newly created DataEntry / NetReductionEntry _id
    finalizedEntryId: {
      type: mongoose.Schema.Types.ObjectId
    },

    // 'DataEntry' or 'NetReductionEntry'
    finalizedCollection: { type: String }
  },
  {
    timestamps: true
  }
);

// Useful query indexes
PendingApprovalSchema.index({ clientId: 1, status: 1 });
PendingApprovalSchema.index({ clientId: 1, flowType: 1, status: 1 });

module.exports = mongoose.model("PendingApproval", PendingApprovalSchema);
