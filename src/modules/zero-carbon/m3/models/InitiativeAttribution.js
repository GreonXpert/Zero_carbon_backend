'use strict';

const mongoose = require('mongoose');
const { MeasurementBasis } = require('../constants/enums');

const InitiativeAttributionSchema = new mongoose.Schema({
  clientId:           { type: String, required: true, index: true },
  target_id:          { type: mongoose.Schema.Types.ObjectId, ref: 'TargetMaster', required: true },
  // External M2 reference
  initiative_id:      { type: String, required: true },
  source_code:        { type: String, default: null },
  category_code:      { type: String, default: null },
  expected_reduction: { type: Number, default: 0 },
  achieved_reduction: { type: Number, default: 0 },
  verification_status:{ type: String, default: 'UNVERIFIED' },
  // ── Enterprise guide additions ────────────────────────────────────────────
  confidence_level:       { type: Number, default: null, min: 0, max: 100 }, // 0–100 %
  measurement_basis:      { type: String, enum: [...Object.values(MeasurementBasis), null], default: null },
  attribution_method:     { type: String, default: null },  // e.g. "GHG Protocol Project"
  reporting_period_start: { type: Date, default: null },
  reporting_period_end:   { type: Date, default: null },
  created_by:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updated_by:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  isDeleted:          { type: Boolean, default: false },
}, { timestamps: true });

InitiativeAttributionSchema.index({ target_id: 1, initiative_id: 1 });

module.exports = mongoose.model('InitiativeAttribution', InitiativeAttributionSchema);
