// models/Organization/AnonymousCode.js
// Tracks anonymous survey codes for anonymous response mode.
// One document per code. No personal identity is stored.
const mongoose = require('mongoose');

const AnonymousCodeSchema = new mongoose.Schema(
  {
    // ─── Context ──────────────────────────────────────────────────────────────
    clientId: { type: String, required: true, index: true },
    flowchartId: { type: mongoose.Schema.Types.ObjectId, ref: 'Flowchart', default: null },
    processFlowchartId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProcessFlowchart', default: null },
    nodeId: { type: String, required: true },
    scopeIdentifier: { type: String, required: true, index: true },

    // ─── Cycle ────────────────────────────────────────────────────────────────
    cycleIndex: { type: Number, required: true },
    cycleDate: { type: Date, required: true },
    reportingYear: { type: Number, required: true },

    // ─── Batch groups codes from same dept/cycle generation ───────────────────
    batchId: { type: String, required: true, index: true },

    // ─── Code ─────────────────────────────────────────────────────────────────
    // anonymousCodeId: human-readable label shown to respondent (e.g. ACME_Sales_001)
    anonymousCodeId: { type: String, required: true },
    // codeHash: bcrypt hash — used for server-side validation; code itself is not stored
    codeHash: { type: String, required: true, unique: true },

    // ─── Expiry ───────────────────────────────────────────────────────────────
    expiresAt: { type: Date, default: null },

    // ─── Redemption state ─────────────────────────────────────────────────────
    isRedeemed: { type: Boolean, default: false, index: true },
    redeemedAt: { type: Date, default: null },

    // ─── Response reference ───────────────────────────────────────────────────
    responseId: { type: mongoose.Schema.Types.ObjectId, ref: 'SurveyResponse', default: null },

    // ─── Audit ────────────────────────────────────────────────────────────────
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

// Compound index for fast look-up by batch
AnonymousCodeSchema.index({ batchId: 1, cycleIndex: 1 });
AnonymousCodeSchema.index({ clientId: 1, scopeIdentifier: 1, cycleIndex: 1 });

module.exports = mongoose.model('AnonymousCode', AnonymousCodeSchema);
