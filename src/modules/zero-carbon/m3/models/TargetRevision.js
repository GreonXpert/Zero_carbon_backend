'use strict';

const mongoose = require('mongoose');

const TargetRevisionSchema = new mongoose.Schema({
  target_id:        { type: mongoose.Schema.Types.ObjectId, ref: 'TargetMaster', required: true, index: true },
  revision_no:      { type: Number, required: true },
  snapshot_data:    { type: mongoose.Schema.Types.Mixed, required: true },
  trigger_event_id: { type: mongoose.Schema.Types.ObjectId, ref: 'RecalculationEvent', default: null },
  created_by:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

TargetRevisionSchema.index({ target_id: 1, revision_no: 1 }, { unique: true });

module.exports = mongoose.model('TargetRevision', TargetRevisionSchema);
