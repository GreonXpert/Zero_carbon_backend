'use strict';

const mongoose = require('mongoose');
const { SnapshotType, ForecastStatus, ForecastMethod } = require('../constants/enums');

const ForecastSnapshotSchema = new mongoose.Schema({
  clientId:            { type: String, required: true, index: true },
  target_id:           { type: mongoose.Schema.Types.ObjectId, ref: 'TargetMaster', required: true, index: true },
  forecast_date:       { type: Date, required: true },
  snapshot_type:       { type: String, enum: Object.values(SnapshotType), required: true },
  projected_emissions: { type: Number, required: true },
  allowed_emissions:   { type: Number, required: true },
  forecast_status: {
    type: String,
    enum: Object.values(ForecastStatus),
    required: true,
  },
  // true when projected > allowed (after at-risk threshold check)
  at_risk_indicator: { type: Boolean, default: false },
  // ── Enterprise guide additions ─────────────────────────────────────────────
  forecast_method:     { type: String, enum: Object.values(ForecastMethod), default: ForecastMethod.LINEAR_EXTRAPOLATION },
  confidence_lower:    { type: Number, default: null },   // lower bound of confidence interval
  confidence_upper:    { type: Number, default: null },   // upper bound of confidence interval
  basis_period_start:  { type: Date, default: null },
  basis_period_end:    { type: Date, default: null },

  // true  → auto-recomputed / first manual compute using the client's locked method
  // false → manual comparison compute using a different method (does not affect live tracking)
  is_primary: { type: Boolean, default: true, index: true },

  // ── Dual-status fields ─────────────────────────────────────────────────────
  // vs_budget_status  → projected year-end vs pathway allowed_emissions (same as forecast_status, explicit alias)
  // vs_baseline_status → actual YTD vs seasonally-expected YTD (prior-year pattern × allowed budget)
  vs_budget_status:   { type: String, enum: [...Object.values(ForecastStatus), null], default: null },
  vs_baseline_status: { type: String, enum: [...Object.values(ForecastStatus), null], default: null },
  // Expected YTD at today's date per seasonal weights × allowed budget
  ytd_expected:       { type: Number, default: null },
  // Annual emissions if pace exactly follows prior-year seasonal pattern
  baseline_projected: { type: Number, default: null },

  // ── Monthly chart data arrays (ANNUAL snapshots only) ─────────────────────
  // monthly_allowed[i] = { month (1-12), allowed_co2e } — budget × seasonal weight
  // monthly_baseline[i] = { month (1-12), baseline_co2e } — prior-year actuals scaled to budget
  monthly_allowed:  [{ month: { type: Number }, allowed_co2e:  { type: Number } }],
  monthly_baseline: [{ month: { type: Number }, baseline_co2e: { type: Number } }],

  // Per-allocation breakdown (populated when APPROVED/ACTIVE allocations exist for the target)
  allocation_forecasts: [{
    allocation_id:               { type: mongoose.Schema.Types.ObjectId, ref: 'SourceAllocation' },
    source_code:                 { type: String },
    facility_id:                 { type: String },
    category_name:               { type: String },
    scope_type:                  { type: String },
    business_unit_id:            { type: String, default: null },
    // Per-level percentages (from the 4-level hierarchy)
    scope_allocation_pct:        { type: Number, default: 0 },
    category_allocation_pct:     { type: Number, default: 0 },
    node_allocation_pct:         { type: Number, default: 0 },
    scope_detail_allocation_pct: { type: Number, default: 0 },
    // Effective % = scope × category × node × scopeDetail (expressed as a percentage)
    effective_pct:               { type: Number, default: 0 },
    ytd_emissions:               { type: Number },
    allocated_budget:            { type: Number },
    projected_emissions:         { type: Number },
    forecast_status:             { type: String, enum: Object.values(ForecastStatus) },
    confidence_lower:            { type: Number, default: null },
    confidence_upper:            { type: Number, default: null },
  }],
}, { timestamps: true });

ForecastSnapshotSchema.index({ target_id: 1, forecast_date: -1, snapshot_type: 1 });

module.exports = mongoose.model('ForecastSnapshot', ForecastSnapshotSchema);
