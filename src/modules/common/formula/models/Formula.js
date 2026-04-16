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
 * MIGRATION NOTE:
 *   Old documents may still have 'clientIds' (array). The migration script at
 *   src/modules/common/formula/migrations/migrateFormulas.js populates 'clientId' (string)
 *   from 'clientIds[0]' for each document, and creates clones for additional clients.
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

  // ── Core formula fields (same as before) ──────────────────────────────────
  name:        { type: String, required: true, index: true },
  label:       { type: String, default: '' },
  // NOTE: For moduleKey='esg_link', label is enforced = name in the service layer.

  description: { type: String, default: '' },
  link:        { type: String, default: '' },   // documentation/reference URL
  unit:        { type: String, default: '' },

  // Math expression; variable names must match VariableSchema.name values
  // e.g. "(A * B) - sqrt(C) / D"
  expression:  { type: String, required: true },

  variables:   [VariableSchema],

  // Manual versioning support
  version:     { type: Number, default: 1 },

  // ── Module-awareness (NEW) ─────────────────────────────────────────────────
  moduleKey: {
    type: String,
    enum: ['zero_carbon', 'esg_link'],
    required: true
    // Add new module keys here as future modules are onboarded.
  },

  // Scope type (schema-ready for all values; only 'client' is active in business logic now)
  scopeType: {
    type: String,
    enum: ['client', 'team', 'global'],
    required: true,
    default: 'client'
  },

  // Single clientId (replaces old clientIds[] array)
  // Required when scopeType = 'client'; enforced in service layer, not schema,
  // to allow graceful validation error messages.
  clientId: { type: String, default: null },

  // ── Traceability (NEW) ────────────────────────────────────────────────────
  createdByRole: { type: String, default: '' },
  // sourceFormulaId: set on cloned records created during migration.
  // Points to the original formula that was split.
  sourceFormulaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Formula', default: null },

  // ── Auth ──────────────────────────────────────────────────────────────────
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // ── Soft delete ───────────────────────────────────────────────────────────
  isDeleted:   { type: Boolean, default: false }

}, {
  timestamps: true,
  collection: 'reduction_formulas'
  // NOTE: Collection name is kept as 'reduction_formulas' for zero-risk backward compatibility.
  // Rename to 'common_formulas' in a future dedicated DB migration once all consumers are confirmed stable.
});

// ─── Indexes ──────────────────────────────────────────────────────────────────
FormulaSchema.index({ name: 1, version: -1 });
FormulaSchema.index({ moduleKey: 1, clientId: 1, isDeleted: 1 });

// ─── Model Registration ───────────────────────────────────────────────────────
// Model name changed from 'ReductionFormula' to 'Formula'.
// All schema refs in Reduction.js and NetReductionEntry.js have been updated to ref: 'Formula'.
module.exports = mongoose.model('Formula', FormulaSchema);
