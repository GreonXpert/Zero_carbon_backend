'use strict';

// ============================================================================
// GreOnIQInteractionEvent — analytics/research event log
//
// Tracks user interactions with GreOn IQ for research and training purposes:
//   like, dislike, feedback_clear, export, pin, unpin
//
// This is an append-only collection. Events are never deleted.
// ============================================================================

const mongoose = require('mongoose');

const GreOnIQInteractionEventSchema = new mongoose.Schema(
  {
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
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'ChatSession',
      required: true,
    },
    // null for session-level events (pin/unpin)
    messageId: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'ChatMessage',
      default: null,
    },
    eventType: {
      type:     String,
      enum:     ['like', 'dislike', 'feedback_clear', 'export', 'pin', 'unpin'],
      required: true,
    },
    // Only set when eventType = 'export'
    exportFormat: {
      type:    String,
      enum:    ['pdf', 'docx', 'xlsx', null],
      default: null,
    },
    createdAt: {
      type:    Date,
      default: Date.now,
      index:   true,
    },
  },
  { timestamps: false }
);

// Compound index for per-user/session event queries
GreOnIQInteractionEventSchema.index({ userId: 1, sessionId: 1, createdAt: -1 });
// Index for aggregate analytics by client + time
GreOnIQInteractionEventSchema.index({ clientId: 1, eventType: 1, createdAt: -1 });

module.exports = mongoose.model('GreOnIQInteractionEvent', GreOnIQInteractionEventSchema);
