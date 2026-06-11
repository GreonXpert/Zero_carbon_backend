'use strict';

// ============================================================================
// ChatAuditLog — immutable audit record written after every GreOn IQ query
//
// IMPORTANT:
//   - This collection is NEVER deleted by retention cleanup jobs.
//   - It is NEVER deleted when a user manually deletes chat sessions.
//   - It stores metadata and counts — never raw encrypted field values.
//   - aiRequestMeta must never include DEEPSEEK_API_KEY or any secret.
// ============================================================================

const mongoose = require('mongoose');

const ChatAuditLogSchema = new mongoose.Schema(
  {
    // ── Identity ──────────────────────────────────────────────────────────────
    sessionId: {
      type:  mongoose.Schema.Types.ObjectId,
      ref:   'ChatSession',
      index: true,
    },
    messageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'ChatMessage',
    },
    userId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
      index:    true,
    },
    userType: {
      type: String,
    },
    clientId: {
      type:  String,
      index: true,
    },

    // ── Question + classification ─────────────────────────────────────────────
    question:         { type: String, required: true },
    normalizedIntent: { type: String, default: null },
    detectedProduct:  { type: String, enum: ['zero_carbon', 'esg_link', 'both', 'out_of_system', null], default: null },

    // ── Resolved query plan (stored for traceability) ─────────────────────────
    queryPlan: {
      type:    mongoose.Schema.Types.Mixed,
      default: null,
    },
    filtersApplied: {
      type:    mongoose.Schema.Types.Mixed,
      default: null,
    },

    // ── What was touched ──────────────────────────────────────────────────────
    modulesUsed:        { type: [String], default: [] },
    recordsTouchedCount:{ type: Number,   default: 0 },
    excludedDomains:    { type: [String], default: [] },

    // ── Output ────────────────────────────────────────────────────────────────
    outputMode:          { type: String, default: null },
    finalAnswerLength:   { type: Number, default: 0 },
    exportRequested:     { type: Boolean, default: false },
    exportFormat:        { type: String, enum: ['pdf', 'docx', 'xlsx', null], default: null },

    // ── Restriction / access-denied detail ────────────────────────────────────
    // Populated whenever status is 'access_restricted' or 'client_resolution_needed'
    restrictionCode:   { type: String, default: null },
    restrictionReason: { type: String, default: null },
    attemptedDomain:   { type: String, default: null },
    attemptedClientId: { type: String, default: null },

    // ── AI provider metadata (safe — no keys, no raw prompts) ─────────────────
    aiRequestMeta: {
      model:      { type: String, default: null },
      durationMs: { type: Number, default: 0 },
    },
    aiResponseMeta: {
      tokensIn:   { type: Number, default: 0 },
      tokensOut:  { type: Number, default: 0 },
    },

    // ── Result ────────────────────────────────────────────────────────────────
    durationMs:    { type: Number, default: 0 },
    quotaConsumed: { type: Number, default: 0 },
    status: {
      type: String,
      enum: [
        'success',
        'partial',
        'quota_exhausted',
        'out_of_system',
        'permission_denied',
        'provider_error',
        'greon_iq_disabled',
        'invalid_request',
        'access_restricted',
        'client_resolution_needed',
      ],
      required: true,
    },
    errorCode: { type: String, default: null },
  },
  {
    timestamps: true,
  }
);

ChatAuditLogSchema.index({ clientId: 1, createdAt: -1 });
ChatAuditLogSchema.index({ userId: 1, createdAt: -1 });
ChatAuditLogSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('ChatAuditLog', ChatAuditLogSchema);
