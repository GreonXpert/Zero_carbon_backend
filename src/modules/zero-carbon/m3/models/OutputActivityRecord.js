'use strict';

const mongoose = require('mongoose');
const { SourceSystem } = require('../constants/enums');

const OutputActivityRecordSchema = new mongoose.Schema({
  clientId:        { type: String, required: true, index: true },
  target_id:       { type: mongoose.Schema.Types.ObjectId, ref: 'TargetMaster', required: true },
  calendar_year:   { type: Number, required: true },
  output_value:    { type: Number, required: true },
  denominator_unit:{ type: String, required: true },
  source_system: {
    type: String,
    enum: Object.values(SourceSystem),
    default: SourceSystem.MANUAL,
  },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

OutputActivityRecordSchema.index({ target_id: 1, calendar_year: 1 }, { unique: true });

module.exports = mongoose.model('OutputActivityRecord', OutputActivityRecordSchema);
