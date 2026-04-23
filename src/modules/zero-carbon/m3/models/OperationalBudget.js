'use strict';

const mongoose = require('mongoose');
const { BudgetGranularity } = require('../constants/enums');

const OperationalBudgetSchema = new mongoose.Schema({
  clientId:            { type: String, required: true, index: true },
  target_id:           { type: mongoose.Schema.Types.ObjectId, ref: 'TargetMaster', required: true },
  parent_pathway_id:   { type: mongoose.Schema.Types.ObjectId, ref: 'PathwayAnnual', required: true },
  granularity: {
    type: String,
    enum: Object.values(BudgetGranularity),
    required: true,
  },
  // e.g. "2025-03" for monthly, "2025-Q2" for quarterly, "2025" for annual, "2025-03-15" for daily
  period_key:        { type: String, required: true },
  budget_emissions:  { type: Number, required: true },
  // Always true — manual writes are rejected at API layer
  is_system_derived: { type: Boolean, default: true, immutable: true },
}, { timestamps: true });

OperationalBudgetSchema.index({ target_id: 1, granularity: 1, period_key: 1 }, { unique: true });

module.exports = mongoose.model('OperationalBudget', OperationalBudgetSchema);
