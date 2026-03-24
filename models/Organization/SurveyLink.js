// models/Organization/SurveyLink.js
// Tracks unique survey links for identified (unique) response mode.
// One document per employee per cycle.
const mongoose = require('mongoose');

const SurveyLinkSchema = new mongoose.Schema(
  {
    // ─── Context ──────────────────────────────────────────────────────────────
    clientId: { type: String, required: true, index: true },
    flowchartId: { type: mongoose.Schema.Types.ObjectId, ref: 'Flowchart', default: null },
    processFlowchartId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProcessFlowchart', default: null },
    nodeId: { type: String, required: true },
    scopeIdentifier: { type: String, required: true, index: true },

    // ─── Cycle (maps to employeeCommutingConfig.collectionDates[cycleIndex]) ──
    cycleIndex: { type: Number, required: true },
    cycleDate: { type: Date, required: true },
    reportingYear: { type: Number, required: true },

    // ─── Recipient ────────────────────────────────────────────────────────────
    recipientId: { type: String, default: null },
    recipientName: { type: String, default: '' },

    // ─── Token security ───────────────────────────────────────────────────────
    // tokenHash: bcrypt hash stored in DB; plaintext token returned only once at generation
    tokenHash: { type: String, required: true, unique: true },
    tokenPrefix: { type: String, required: true }, // first 8 chars — safe to display in admin

    // ─── Lifecycle ────────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ['pending', 'opened', 'submitted', 'expired'],
      default: 'pending',
      index: true,
    },
    expiresAt: { type: Date, required: true },
    sentAt: { type: Date, default: null },
    openedAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },

    // ─── Response reference ───────────────────────────────────────────────────
    responseId: { type: mongoose.Schema.Types.ObjectId, ref: 'SurveyResponse', default: null },

    // ─── Autosave draft (partial progress; unique mode only) ──────────────────
    draftData: { type: mongoose.Schema.Types.Mixed, default: null },

    // ─── Audit ────────────────────────────────────────────────────────────────
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

// Compound index for fast look-up by client + scope + cycle
SurveyLinkSchema.index({ clientId: 1, scopeIdentifier: 1, cycleIndex: 1 });
// Index for per-recipient deduplication
SurveyLinkSchema.index({ recipientId: 1, scopeIdentifier: 1, cycleIndex: 1 });

module.exports = mongoose.model('SurveyLink', SurveyLinkSchema);
