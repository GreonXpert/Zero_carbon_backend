'use strict';

// ============================================================================
// ChatExportJob — tracks a report export generation job
//
// EXPORT WORKFLOW (v1 — synchronous):
//   1. POST /api/greon-iq/report/export  → creates job record (status: pending)
//   2. exportService generates the file synchronously
//   3. On success: status → completed, s3Key + downloadUrl populated
//   4. GET  /api/greon-iq/exports/:exportId  → client polls for status
//
// Future v2 can make step 2 async (queue-based) without changing the model.
//
// SECURITY:
//   downloadUrl is a pre-signed S3 URL valid for a configurable duration.
//   expiresAt is set at generation time so the endpoint can reject stale polls.
//   Permissions are re-checked before file generation (not just at job creation).
// ============================================================================

const mongoose = require('mongoose');

const ChatExportJobSchema = new mongoose.Schema(
  {
    // ── Source ────────────────────────────────────────────────────────────────
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
    clientId: {
      type:     String,
      required: true,
    },

    // ── Export configuration ──────────────────────────────────────────────────
    format: {
      type:     String,
      enum:     ['pdf', 'docx', 'xlsx'],
      required: true,
    },

    // ── Status lifecycle ──────────────────────────────────────────────────────
    status: {
      type:    String,
      enum:    ['pending', 'processing', 'completed', 'failed'],
      default: 'pending',
    },

    // ── Output (populated on completion) ─────────────────────────────────────
    s3Key:       { type: String, default: null },
    downloadUrl: { type: String, default: null },
    // When the pre-signed URL expires
    expiresAt:   { type: Date,   default: null },

    // ── Failure info ──────────────────────────────────────────────────────────
    errorMessage: { type: String, default: null },

    // ── Credits charged for this export ───────────────────────────────────────
    creditsCharged: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ChatExportJob', ChatExportJobSchema);
