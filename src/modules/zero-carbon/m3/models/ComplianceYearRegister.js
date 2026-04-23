'use strict';

const mongoose = require('mongoose');
const { ComplianceStatus } = require('../constants/enums');

const ComplianceYearRegisterSchema = new mongoose.Schema({
  clientId:        { type: String, required: true, index: true },
  target_id:       { type: mongoose.Schema.Types.ObjectId, ref: 'TargetMaster', required: true },
  compliance_year: { type: Number, required: true },

  actual_emissions: { type: Number, default: null },
  output_value:     { type: Number, default: null },

  // Computed fields — frozen on CLOSED
  target_gei:    { type: Number, default: null },
  achieved_gei:  { type: Number, default: null },
  gap:           { type: Number, default: null },
  credit_need:   { type: Number, default: null },
  credit_surplus:{ type: Number, default: null },

  closure_status: {
    type: String,
    enum: Object.values(ComplianceStatus),
    default: ComplianceStatus.OPEN,
  },

  closed_by:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  closed_at:  { type: Date, default: null },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

ComplianceYearRegisterSchema.index({ target_id: 1, compliance_year: 1 }, { unique: true });

module.exports = mongoose.model('ComplianceYearRegister', ComplianceYearRegisterSchema);
