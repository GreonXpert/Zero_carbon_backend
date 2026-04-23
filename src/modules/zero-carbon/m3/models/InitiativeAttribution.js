'use strict';

const mongoose = require('mongoose');

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
  created_by:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updated_by:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  isDeleted:          { type: Boolean, default: false },
}, { timestamps: true });

InitiativeAttributionSchema.index({ target_id: 1, initiative_id: 1 });

module.exports = mongoose.model('InitiativeAttribution', InitiativeAttributionSchema);
