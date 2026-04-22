'use strict';

// ============================================================================
// ChatSession — one conversation thread per user per client
//
// A session groups related messages together. It stores a lightweight
// contextState so follow-up questions inside the same session can carry
// forward the last resolved product, module, dateRange, and intent without
// requiring the user to repeat themselves.
//
// Retention is enforced at the session level (not message level).
// When a user's chatRetentionLimit is exceeded, the OLDEST session(s) are
// purged from ChatSession + ChatMessage. Audit logs are never deleted.
// ============================================================================

const mongoose = require('mongoose');

// ── Tracks what the last successful query was about ──────────────────────────
// Used by intentRouterService to resolve follow-up pronouns ("it", "that").
const ContextStateSchema = new mongoose.Schema(
  {
    lastProduct:    { type: String, enum: ['zero_carbon', 'esg_link', 'both'], default: null },
    lastModule:     { type: String, default: null },
    lastIntent:     { type: String, default: null },
    lastClientId:   { type: String, default: null },
    lastDateRange: {
      label:     { type: String, default: null },
      startDate: { type: Date,   default: null },
      endDate:   { type: Date,   default: null },
    },
    lastOutputMode: { type: String, default: null },
  },
  { _id: false }
);

const ChatSessionSchema = new mongoose.Schema(
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
    // Auto-generated from the first user message (truncated to 80 chars)
    title: {
      type:    String,
      default: 'New Conversation',
      maxlength: 120,
    },
    messageCount: {
      type:    Number,
      default: 0,
      min:     0,
    },
    // Live in-session context — updated after every successful query
    contextState: {
      type:    ContextStateSchema,
      default: () => ({}),
    },
    // Soft-end flag: set to false when session is manually closed (not deleted)
    isActive: {
      type:    Boolean,
      default: true,
    },
    // Pin flag: pinned sessions are excluded from retention cleanup and sorted first
    isPinned: {
      type:    Boolean,
      default: false,
      index:   true,
    },
  },
  { timestamps: true }
);

// Composite index: pinned sessions first, then newest first within each group
ChatSessionSchema.index({ userId: 1, clientId: 1, isPinned: -1, updatedAt: -1 });

module.exports = mongoose.model('ChatSession', ChatSessionSchema);
