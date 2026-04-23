'use strict';

const mongoose = require('mongoose');
const { DQFlagCode, Severity, ApprovableEntityType } = require('../constants/enums');

const DataQualityFlagSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  entity_type: {
    type: String,
    enum: Object.values(ApprovableEntityType),
    required: true,
  },
  entity_id: { type: String, required: true },
  flag_code: {
    type: String,
    enum: Object.values(DQFlagCode),
    required: true,
  },
  severity: {
    type: String,
    enum: Object.values(Severity),
    required: true,
  },
  message:           { type: String, required: true },
  remediation_hint:  { type: String, default: null },
  resolved:          { type: Boolean, default: false },
  resolved_by:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  resolved_at:       { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

DataQualityFlagSchema.index({ entity_type: 1, entity_id: 1, resolved: 1 });
DataQualityFlagSchema.index({ clientId: 1, severity: 1, resolved: 1 });

module.exports = mongoose.model('DataQualityFlag', DataQualityFlagSchema);
