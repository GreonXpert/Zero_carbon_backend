'use strict';

const mongoose = require('mongoose');

const PathwayAnnualSchema = new mongoose.Schema({
  clientId:         { type: String, required: true, index: true },
  target_id:        { type: mongoose.Schema.Types.ObjectId, ref: 'TargetMaster', required: true },
  calendar_year:    { type: Number, required: true },
  allowed_emissions:{ type: Number, required: true },
  // SHA256 of target_id + framework + method + key params — used for re-derivation detection
  recompute_hash:   { type: String, required: true },
}, { timestamps: true });

PathwayAnnualSchema.index({ target_id: 1, calendar_year: 1 }, { unique: true });

module.exports = mongoose.model('PathwayAnnual', PathwayAnnualSchema);
