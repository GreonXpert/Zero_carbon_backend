'use strict';

const mongoose = require('mongoose');
const {
  TargetFamily, FrameworkName, MethodName,
  LifecycleStatus, ApprovalStatus, ScopeBoundary,
  MetricType, OrgBoundaryBasis, TargetBoundaryLevel,
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

  // ── Enterprise guide additions ─────────────────────────────────────────────
  target_name:           { type: String, trim: true, default: null },
  framework_version:     { type: String, trim: true, default: null },    // e.g. "SBTi_v5"
  metric_type:           { type: String, enum: [...Object.values(MetricType), null], default: null },
  org_boundary_basis:    { type: String, enum: Object.values(OrgBoundaryBasis), default: OrgBoundaryBasis.OPERATIONAL_CONTROL },
  target_boundary_level: { type: String, enum: Object.values(TargetBoundaryLevel), default: TargetBoundaryLevel.ORGANIZATION },
  scope_coverage_pct:    { type: Number, default: null, min: 0, max: 100 }, // overall across all scopes
  owner_role:            { type: String, default: null },
  owner_user_id:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  effective_from:        { type: Date, default: null },   // set on publish → ACTIVE
  effective_to:          { type: Date, default: null },   // set on archive / supersede
  superseded_by:         { type: mongoose.Schema.Types.ObjectId, ref: 'TargetMaster', default: null },

  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  isDeleted: { type: Boolean, default: false },
}, { timestamps: true });

TargetMasterSchema.index({ clientId: 1, target_code: 1 }, { unique: true });

module.exports = mongoose.model('TargetMaster', TargetMasterSchema);
