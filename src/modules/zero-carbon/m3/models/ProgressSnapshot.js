'use strict';

const mongoose = require('mongoose');
const { SnapshotType, ProgressStatus } = require('../constants/enums');

const ProgressSnapshotSchema = new mongoose.Schema({
  clientId:          { type: String, required: true, index: true },
  target_id:         { type: mongoose.Schema.Types.ObjectId, ref: 'TargetMaster', required: true, index: true },
  snapshot_date:     { type: Date, required: true },
  snapshot_type:     { type: String, enum: Object.values(SnapshotType), required: true },
  calendar_year:     { type: Number, required: true },
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
  // ── Enterprise guide additions ─────────────────────────────────────────────
  m1_summary_id: { type: mongoose.Schema.Types.ObjectId, ref: 'EmissionSummary', default: null },
}, { timestamps: true });

// Unique upsert key — one canonical snapshot per (target, type, year). Prevents duplicate rows
// when computeProgress is re-run for the same year.
ProgressSnapshotSchema.index(
  { target_id: 1, snapshot_type: 1, calendar_year: 1 },
  { unique: true }
);
// Query support for trajectory (fetch all annual snapshots for a target ordered by year)
ProgressSnapshotSchema.index({ target_id: 1, calendar_year: -1 });

module.exports = mongoose.model('ProgressSnapshot', ProgressSnapshotSchema);
