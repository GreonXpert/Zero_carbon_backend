'use strict';

const mongoose = require('mongoose');
const {
  TargetFamily, FrameworkName, MethodName,
  LifecycleStatus, ApprovalStatus, ScopeBoundary,
} = require('../constants/enums');

const TargetMasterSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  target_code: { type: String, required: true, trim: true },

  target_family:     { type: String, enum: Object.values(TargetFamily), required: true },
  framework_name:    { type: String, enum: Object.values(FrameworkName), required: true },
  method_name:       { type: String, enum: Object.values(MethodName), required: true },

  base_year:              { type: Number, required: true },
  base_year_emissions:    { type: Number, default: null },
  target_year:            { type: Number, required: true },
  target_reduction_pct:   { type: Number, default: null, min: 0, max: 100 },

  scope_boundary:         { type: String, enum: Object.values(ScopeBoundary), default: 'S1S2' },
  scope3_coverage_pct:    { type: Number, default: null, min: 0, max: 100 },
  interim_years:          [{ type: Number }],

  // GEI / SDA denominator setup
  denominator_unit: { type: String, default: null },

  // SDA-specific: target intensity value
  target_intensity_value: { type: Number, default: null },

  lifecycle_status: {
    type: String,
    enum: Object.values(LifecycleStatus),
    default: LifecycleStatus.DRAFT,
  },
  approval_status: {
    type: String,
    enum: Object.values(ApprovalStatus),
    default: null,
  },

  // Optimistic concurrency
  version: { type: Number, default: 1 },

  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  isDeleted: { type: Boolean, default: false },
}, { timestamps: true });

TargetMasterSchema.index({ clientId: 1, target_code: 1 }, { unique: true });

module.exports = mongoose.model('TargetMaster', TargetMasterSchema);
