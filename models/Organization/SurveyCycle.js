// models/Organization/SurveyCycle.js
// Tracks the lifecycle and statistics of each survey cycle
// (one document per clientId + nodeId + scopeIdentifier + cycleIndex).
const mongoose = require('mongoose');

const SurveyCycleSchema = new mongoose.Schema(
  {
    // ─── Context ──────────────────────────────────────────────────────────────
    clientId: { type: String, required: true, index: true },
    flowchartId: { type: mongoose.Schema.Types.ObjectId, ref: 'Flowchart', default: null },
    processFlowchartId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProcessFlowchart', default: null },
    nodeId: { type: String, required: true },
    scopeIdentifier: { type: String, required: true },
    responseMode: { type: String, enum: ['unique', 'anonymous'], required: true },

    // ─── Cycle identity ───────────────────────────────────────────────────────
    cycleIndex: { type: Number, required: true },
    cycleDate: { type: Date, required: true },
    reportingYear: { type: Number, required: true },

    // ─── Status ───────────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ['upcoming', 'open', 'closed', 'cancelled', 'approved'],
      default: 'upcoming',
      index: true,
    },
    openedAt:    { type: Date, default: null },
    closedAt:    { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt:  { type: Date, default: null },
    approvedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // ─── Completion threshold ─────────────────────────────────────────────────
    // Minimum submission % required before approve is allowed (0–100).
    // Set at link/code generation time; can be updated via PATCH .../threshold.
    completionThresholdPct: { type: Number, default: 100, min: 0, max: 100 },

    // ─── Completion statistics ────────────────────────────────────────────────
    // totalLinks is set when links/codes are generated (= numberOfEmployees for that cycle)
    totalLinks: { type: Number, default: 0 },
    statistics: {
      submitted: { type: Number, default: 0 },
      opened: { type: Number, default: 0 },
      pending: { type: Number, default: 0 },
      expired: { type: Number, default: 0 },
      // completionPct = submitted / totalLinks * 100  (0 if totalLinks === 0)
      completionPct: { type: Number, default: 0 },
    },

    // ─── Aggregated emissions for this cycle ─────────────────────────────────
    totalEmissionsKgCO2e: { type: Number, default: null },

    // ─── Audit ────────────────────────────────────────────────────────────────
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    generatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Unique constraint: one cycle doc per scope per cycle index
SurveyCycleSchema.index(
  { clientId: 1, scopeIdentifier: 1, cycleIndex: 1 },
  { unique: true }
);

module.exports = mongoose.model('SurveyCycle', SurveyCycleSchema);
