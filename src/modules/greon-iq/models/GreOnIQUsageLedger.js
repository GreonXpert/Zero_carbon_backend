'use strict';

// ============================================================================
// GreOnIQUsageLedger — credit consumption record per GreOn IQ action
//
// One record is written per assistant response (after successful generation).
// No record is written for:
//   - out_of_system responses (no credits consumed)
//   - quota_exhausted rejections (no credits consumed)
//   - failed queries that never reached DeepSeek
//
// DUAL-METER DESIGN:
//   baseCredits         — business credits (weighted action model)
//   tokenBandAdjustment — fractional adjustment from real AI token usage
//   totalCredits        — baseCredits + tokenBandAdjustment (enforced amount)
//
// PERIOD KEYS:
//   periodKey — 'YYYY-MM'  for monthly rollup queries
//   weekKey   — 'YYYY-Www' for weekly rollup queries (ISO week, Mon-based)
//
// These keys are set by quotaMathHelpers.getPeriodKey() / getWeekKey()
// in Asia/Kolkata timezone so resets align with IST boundaries.
// ============================================================================

const mongoose = require('mongoose');

// ── Action type → base credit mapping (source of truth in quotaMathHelpers) ──
const ACTION_TYPES = [
  'simple_qa',        // 1 credit  — plain text answer
  'qa_table',         // 2 credits — answer + table
  'qa_chart_table',   // 3 credits — answer + chart + table
  'cross_module',     // 4 credits — cross-module analysis
  'report_preview',   // 5 credits — markdown report preview
  'export_pdf',       // +3 credits (added to report_preview cost)
  'export_docx',      // +3 credits
  'export_excel',     // +2 credits
];

const GreOnIQUsageLedgerSchema = new mongoose.Schema(
  {
    // ── Identity ──────────────────────────────────────────────────────────────
    userId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
      index:    true,
    },
    clientId: {
      type:     String,
      required: true,
      index:    true,
    },
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'ChatSession',
    },
    messageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'ChatMessage',
    },

    // ── Action classification ─────────────────────────────────────────────────
    actionType: {
      type:     String,
      enum:     ACTION_TYPES,
      required: true,
    },

    // ── Credit breakdown ──────────────────────────────────────────────────────
    baseCredits: {
      type:     Number,
      required: true,
      min:      0,
    },
    // floor(aiTokensTotal / 1000) * TOKEN_BAND_RATE (default 0.1)
    // Stored as 0 when DeepSeek token metadata is unavailable
    tokenBandAdjustment: {
      type:    Number,
      default: 0,
      min:     0,
    },
    totalCredits: {
      type:     Number,
      required: true,
      min:      0,
    },

    // ── Period keys (IST-based) ───────────────────────────────────────────────
    periodKey: {
      type:     String,   // 'YYYY-MM'
      required: true,
      index:    true,
    },
    weekKey: {
      type:     String,   // 'YYYY-Www'
      required: true,
      index:    true,
    },

    // ── Raw AI token counts (from DeepSeek response metadata) ─────────────────
    aiTokensIn:  { type: Number, default: 0 },
    aiTokensOut: { type: Number, default: 0 },
  },
  {
    // No updatedAt needed — ledger records are append-only
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// Fast period-based aggregation: sum credits for a user in a period/week
GreOnIQUsageLedgerSchema.index({ userId: 1, periodKey: 1 });
GreOnIQUsageLedgerSchema.index({ userId: 1, weekKey: 1 });
GreOnIQUsageLedgerSchema.index({ clientId: 1, periodKey: 1 });

// Expose action types for use in other services
GreOnIQUsageLedgerSchema.statics.ACTION_TYPES = ACTION_TYPES;

module.exports = mongoose.model('GreOnIQUsageLedger', GreOnIQUsageLedgerSchema);
