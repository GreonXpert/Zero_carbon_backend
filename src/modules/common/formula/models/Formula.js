'use strict';

/**
 * Formula.js — Common Formula Model
 *
 * This is the authoritative formula schema for all modules (zero_carbon, esg_link, future).
 * It replaces the module-specific ReductionFormula model.
 *
 * Collection: 'reduction_formulas'
 *   - Intentionally kept the same collection name to avoid data migration risk.
 *   - Existing Reduction and NetReductionEntry documents reference formulaId by ObjectId;
 *     since the same collection is used, all existing references remain valid.
 *   - Model name changed: 'ReductionFormula' → 'Formula'
 *     Old references in Reduction.js and NetReductionEntry.js have been updated accordingly.
 *
 * CLIENT SCOPE DESIGN:
 *   zero_carbon — clientIds: [String]  (array; one formula shared across many clients)
 *   esg_link    — clientId:  String    (single; null when scopeType='global')
 */

const mongoose = require('mongoose');

// ─── Variable Sub-Schema (unchanged from original) ───────────────────────────

const VariableSchema = new mongoose.Schema({
  name:          { type: String, required: true },   // identifier used in expression
  label:         { type: String, default: '' },
  unit:          { type: String, default: '' },

  // Update policy for the variable
  updatePolicy:  { type: String, enum: ['manual', 'annual_automatic'], default: 'manual' },

  // Default / last value for frozen or policy-managed vars
  defaultValue:  { type: Number, default: null },
  lastValue:     { type: Number, default: null },
  lastUpdatedAt: { type: Date }
}, { _id: false });

// ─── Main Formula Schema ──────────────────────────────────────────────────────

const FormulaSchema = new mongoose.Schema({

  // ── Core formula fields ───────────────────────────────────────────────────
  name:        { type: String, required: true, index: true },
  label:       { type: String, default: '' },
  // NOTE: For moduleKey='esg_link', label is enforced = name in the service layer.

  description: { type: String, default: '' },
  link:        { type: String, default: '' },   // documentation/reference URL
  unit:        { type: String, default: '' },

  // Math expression; variable names must match VariableSchema.name values
  expression:  { type: String, required: true },

  variables:   [VariableSchema],

  // Manual versioning support
  version:     { type: Number, default: 1 },

  // ── Module-awareness ──────────────────────────────────────────────────────
  moduleKey: {
    type: String,
    enum: ['zero_carbon', 'esg_link'],
    required: true
  },

  scopeType: {
    type: String,
    enum: ['client', 'team', 'global'],
    required: true,
    default: 'client'
  },

  // zero_carbon: array of client IDs — one formula can serve many clients.
  // esg_link:    always [] (esg_link uses clientId below).
  clientIds: { type: [String], default: [] },

  // esg_link: single client ID, or null when scopeType='global'.
  // zero_carbon: always null (zero_carbon uses clientIds above).
  clientId: { type: String, default: null },

  // ── Traceability ──────────────────────────────────────────────────────────
  createdByRole:   { type: String, default: '' },
  sourceFormulaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Formula', default: null },

  // ── Auth ──────────────────────────────────────────────────────────────────
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // ── Soft delete ───────────────────────────────────────────────────────────
  isDeleted: { type: Boolean, default: false }

}, {
  timestamps: true,
  collection: 'reduction_formulas'
});

// ─── Indexes ──────────────────────────────────────────────────────────────────
FormulaSchema.index({ name: 1, version: -1 });
FormulaSchema.index({ moduleKey: 1, clientIds: 1, isDeleted: 1 }); // zero_carbon
FormulaSchema.index({ moduleKey: 1, clientId: 1, isDeleted: 1 });  // esg_link

// ─── Model Registration ───────────────────────────────────────────────────────
module.exports = mongoose.model('Formula', FormulaSchema);
