'use strict';

const mongoose = require('mongoose');

/**
 * SeasonalProfile — stores a manually defined monthly emission distribution
 * for a target + calendar year combination.
 *
 * Used as a fallback when no prior-year EmissionSummary monthly data is available
 * (e.g., new clients). The `monthly_weights` array (12 values) is normalised at
 * read-time so it always sums to 1.0, regardless of the raw values entered.
 *
 * Fields:
 *   clientId         — Organisation identifier
 *   target_id        — Reference to TargetMaster
 *   calendar_year    — Year this profile applies to (e.g., 2026)
 *   scope            — 'All' (default) or 'Scope 1' / 'Scope 2' / 'Scope 3'
 *   monthly_weights  — Raw weight for each of the 12 months (Jan=index 0)
 *                      Values need not sum to any specific number; they are
 *                      normalised when used in forecastService.
 *   created_by       — userId or email of whoever saved the profile
 */
const SeasonalProfileSchema = new mongoose.Schema(
  {
    clientId:     { type: String, required: true, index: true },
    target_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'TargetMaster', required: true, index: true },
    calendar_year:{ type: Number, required: true },
    scope:        { type: String, default: 'All' },
    monthly_weights: {
      type: [Number],
      required: true,
      validate: {
        validator: (arr) => arr.length === 12,
        message:   'monthly_weights must contain exactly 12 values (one per month).',
      },
    },
    created_by: { type: String, default: null },
  },
  { timestamps: true }
);

SeasonalProfileSchema.index({ target_id: 1, calendar_year: 1, scope: 1 }, { unique: true });

module.exports = mongoose.model('SeasonalProfile', SeasonalProfileSchema);
