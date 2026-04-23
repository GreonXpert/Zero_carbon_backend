'use strict';

const mongoose = require('mongoose');
const { SnapshotType, ForecastStatus } = require('../constants/enums');

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
}, { timestamps: true });

ForecastSnapshotSchema.index({ target_id: 1, forecast_date: -1, snapshot_type: 1 });

module.exports = mongoose.model('ForecastSnapshot', ForecastSnapshotSchema);
