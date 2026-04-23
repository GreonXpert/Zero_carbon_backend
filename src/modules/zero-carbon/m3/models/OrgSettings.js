'use strict';

const mongoose = require('mongoose');
const { ApprovalDepth, SeasonalityMethod } = require('../constants/enums');

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
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

module.exports = mongoose.model('OrgSettings', OrgSettingsSchema);
