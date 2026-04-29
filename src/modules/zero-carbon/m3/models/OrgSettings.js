'use strict';

const mongoose = require('mongoose');
const { ApprovalDepth, SeasonalityMethod, ForecastMethod } = require('../constants/enums');

const OrgSettingsSchema = new mongoose.Schema({
  clientId: { type: String, required: true, unique: true },
  approval_depth: {
    type: String,
    enum: Object.values(ApprovalDepth),
    default: ApprovalDepth.SINGLE_STEP,
  },
  allocation_tolerance_pct:      { type: Number, default: 0.005 },
  seasonality_default_method: {
    type: String,
    enum: Object.values(SeasonalityMethod),
    default: SeasonalityMethod.EQUAL,
  },
  forecast_at_risk_threshold_pct: { type: Number, default: 5 },
  scope3_coverage_threshold_pct:  { type: Number, default: 75 },
  live_ingest_cadence_minutes:    { type: Number, default: 15, min: 5, max: 1440 },
  evidence_retention_days:        { type: Number, default: 3650 },
  fiscal_year_boundary:           { type: String, default: 'calendar' },
  // ── Enterprise guide additions ─────────────────────────────────────────────
  forecast_method_default: {
    type: String,
    enum: Object.values(ForecastMethod),
    default: ForecastMethod.LINEAR_EXTRAPOLATION,
  },
  // Set to true after the client's first manual forecast compute.
  // Once locked, auto-recompute always uses forecast_method_default.
  // Manual computes with a different method are saved as comparison (is_primary: false).
  forecast_method_locked: { type: Boolean, default: false },
  // 12 monthly weights that must sum to 1.0 (used when seasonality_default_method = CUSTOM_CURVE)
  custom_seasonality_curve: {
    type: [Number],
    default: null,
    validate: {
      validator(v) { return v == null || v.length === 0 || v.length === 12; },
      message: 'custom_seasonality_curve must contain exactly 12 values.',
    },
  },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

module.exports = mongoose.model('OrgSettings', OrgSettingsSchema);
