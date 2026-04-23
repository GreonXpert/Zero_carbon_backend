'use strict';

const mongoose = require('mongoose');
const { RecalculationTrigger, RecalcEventStatus } = require('../constants/enums');

const RecalculationEventSchema = new mongoose.Schema({
  clientId:     { type: String, required: true, index: true },
  target_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'TargetMaster', required: true },
  trigger_type: {
    type: String,
    enum: Object.values(RecalculationTrigger),
    required: true,
  },
  // Required when trigger_type === 'Other'
  justification: { type: String, default: null },
  status: {
    type: String,
    enum: Object.values(RecalcEventStatus),
    default: RecalcEventStatus.PENDING,
  },
  approved_by:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  approved_at:    { type: Date, default: null },
  new_revision_id:{ type: mongoose.Schema.Types.ObjectId, ref: 'TargetRevision', default: null },
  created_by:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

RecalculationEventSchema.index({ target_id: 1, status: 1 });

module.exports = mongoose.model('RecalculationEvent', RecalculationEventSchema);
