'use strict';

const mongoose = require('mongoose');

/**
 * Stores per-user UI layout preferences for the Target View page.
 * Keyed by (userId, targetId) so each user has their own saved layout.
 */
const userLayoutPreferenceSchema = new mongoose.Schema(
  {
    userId:       { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    targetId:     { type: String, required: true },
    layouts:      { type: mongoose.Schema.Types.Mixed, default: null },
    hidden_cards: { type: [String], default: [] },
  },
  { timestamps: true }
);

// Unique per user+target
userLayoutPreferenceSchema.index({ userId: 1, targetId: 1 }, { unique: true });

module.exports = mongoose.model('UserLayoutPreference', userLayoutPreferenceSchema);
