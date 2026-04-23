'use strict';

const mongoose = require('mongoose');
const { SnapshotType, ProgressStatus } = require('../constants/enums');

const ProgressSnapshotSchema = new mongoose.Schema({
  clientId:          { type: String, required: true, index: true },
  target_id:         { type: mongoose.Schema.Types.ObjectId, ref: 'TargetMaster', required: true, index: true },
  snapshot_date:     { type: Date, required: true },
  snapshot_type:     { type: String, enum: Object.values(SnapshotType), required: true },
  actual_emissions:  { type: Number, required: true },
  allowed_emissions: { type: Number, required: true },
  progress_status: {
    type: String,
    enum: Object.values(ProgressStatus),
    required: true,
  },
  gap_pct: { type: Number, default: 0 },
  // M1 ingestion timestamp for stale-live detection
  ingestion_timestamp: { type: Date, default: null },
}, { timestamps: true });

ProgressSnapshotSchema.index({ target_id: 1, snapshot_date: -1, snapshot_type: 1 });

module.exports = mongoose.model('ProgressSnapshot', ProgressSnapshotSchema);
