'use strict';

const mongoose = require('mongoose');
const { CreditPurpose, CreditStatus } = require('../constants/enums');

const CreditLedgerSchema = new mongoose.Schema({
  clientId:               { type: String, required: true, index: true },
  residual_position_id:   { type: mongoose.Schema.Types.ObjectId, ref: 'ResidualPosition', default: null },
  credit_type:            { type: String, required: true },
  credit_amount:          { type: Number, required: true },
  evidence_attachment_id: { type: mongoose.Schema.Types.ObjectId, ref: 'EvidenceAttachment', default: null },
  purpose: {
    type: String,
    enum: Object.values(CreditPurpose),
    required: true,
  },
  retirement_status: { type: Boolean, default: false },
  retired_at:        { type: Date, default: null },
  // ── Enterprise guide additions ─────────────────────────────────────────────
  credit_status:   { type: String, enum: Object.values(CreditStatus), default: CreditStatus.ACTIVE },
  vintage_year:    { type: Number, default: null },       // year credit was issued/generated
  registry_name:   { type: String, default: null },       // e.g. "Verra", "Gold Standard"
  registry_id:     { type: String, default: null },       // registry certificate / serial number
  project_id:      { type: String, default: null },       // upstream project reference
  created_by:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updated_by:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

CreditLedgerSchema.index({ clientId: 1, retirement_status: 1 });

module.exports = mongoose.model('CreditLedger', CreditLedgerSchema);
