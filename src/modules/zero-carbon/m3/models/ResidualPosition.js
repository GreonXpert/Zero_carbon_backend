'use strict';

const mongoose = require('mongoose');

const ResidualPositionSchema = new mongoose.Schema({
  clientId:                   { type: String, required: true, index: true },
  target_id:                  { type: mongoose.Schema.Types.ObjectId, ref: 'TargetMaster', required: true },
  gross_emissions:             { type: Number, required: true },
  verified_reductions:         { type: Number, default: 0 },
  residual_emissions:          { type: Number, required: true },
  neutralization_required_pct: { type: Number, required: true },
  computed_at:                 { type: Date, default: Date.now },
  created_by:                  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

ResidualPositionSchema.index({ target_id: 1, computed_at: -1 });

module.exports = mongoose.model('ResidualPosition', ResidualPositionSchema);
