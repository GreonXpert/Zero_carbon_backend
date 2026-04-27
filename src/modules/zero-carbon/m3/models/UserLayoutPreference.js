'use strict';

const mongoose = require('mongoose');

/**
 * Stores per-user card visibility preferences for the Target View page.
 * Only hidden_cards is persisted — drag positions are session-only on the client.
 * Keyed by (userId, targetId) so each user has their own preference per target.
 */
const userLayoutPreferenceSchema = new mongoose.Schema(
  {
    userId:       { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    targetId:     { type: String, required: true },
    hidden_cards: { type: [String], default: [] },
  },
  { timestamps: true }
);

// Unique per user + target
userLayoutPreferenceSchema.index({ userId: 1, targetId: 1 }, { unique: true });

module.exports = mongoose.model('UserLayoutPreference', userLayoutPreferenceSchema);
