'use strict';

/**
 * AnnualMetricRecord
 * ──────────────────
 * Stores per-year actual metric values for non-emission-based target methods:
 *   • RE Tracking          – renewable / total electricity kWh
 *   • Supplier Engagement  – engaged / total count OR spend values
 *
 * One document per (target_id, calendar_year).
 * Computed percentage fields (_pct) are stored alongside raw values for
 * quick reads without re-division at query time.
 */

const mongoose = require('mongoose');
const { SourceSystem } = require('../constants/enums');

const AnnualMetricRecordSchema = new mongoose.Schema({
  clientId:      { type: String, required: true, index: true },
  target_id:     { type: mongoose.Schema.Types.ObjectId, ref: 'TargetMaster', required: true },
  calendar_year: { type: Number, required: true },

  // ── Renewable Electricity (RE_Tracking) ──────────────────────────────────
  re_renewable_kwh: { type: Number, default: null },   // actual renewable kWh consumed
  re_total_kwh:     { type: Number, default: null },   // total electricity kWh consumed
  re_pct:           { type: Number, default: null },   // (renewable / total) × 100, computed on save

  // ── Supplier Engagement (Supplier_Engagement_Tracking) ───────────────────
  supplier_engaged_count: { type: Number, default: null },
  supplier_total_count:   { type: Number, default: null },
  supplier_engaged_spend: { type: Number, default: null },  // monetary value, same currency
  supplier_total_spend:   { type: Number, default: null },
  supplier_engagement_pct:{ type: Number, default: null },  // computed on save

  source_system: {
    type: String,
    enum: Object.values(SourceSystem),
    default: SourceSystem.MANUAL,
  },
  notes:      { type: String, default: null },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

AnnualMetricRecordSchema.index({ target_id: 1, calendar_year: 1 }, { unique: true });

// ── Pre-save: compute percentage fields ─────────────────────────────────────
AnnualMetricRecordSchema.pre('save', function (next) {
  // RE %
  if (this.re_total_kwh != null && this.re_total_kwh > 0 && this.re_renewable_kwh != null) {
    this.re_pct = parseFloat(((this.re_renewable_kwh / this.re_total_kwh) * 100).toFixed(4));
  } else {
    this.re_pct = null;
  }

  // Supplier engagement % — prefer count metric, fall back to spend
  if (this.supplier_total_count != null && this.supplier_total_count > 0 && this.supplier_engaged_count != null) {
    this.supplier_engagement_pct = parseFloat(
      ((this.supplier_engaged_count / this.supplier_total_count) * 100).toFixed(4)
    );
  } else if (this.supplier_total_spend != null && this.supplier_total_spend > 0 && this.supplier_engaged_spend != null) {
    this.supplier_engagement_pct = parseFloat(
      ((this.supplier_engaged_spend / this.supplier_total_spend) * 100).toFixed(4)
    );
  } else {
    this.supplier_engagement_pct = null;
  }

  next();
});

module.exports = mongoose.model('AnnualMetricRecord', AnnualMetricRecordSchema);
