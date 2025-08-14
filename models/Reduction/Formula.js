// models/Reduction/Formula.js
const mongoose = require('mongoose');

/**
 * Stores complex expressions for Methodology-2 calculations.
 * This is math-agnostic storage; evaluation happens elsewhere later.
 */
const FormulaVarSchema = new mongoose.Schema({
  name:     { type: String, required: true },     // variable key in the expression
  label:    { type: String, default: '' },        // human-friendly name
  type:     { type: String, enum: ['number','boolean','string','array','object'], default: 'number' },
  required: { type: Boolean, default: false },
  default:  { type: mongoose.Schema.Types.Mixed, default: null },
  notes:    { type: String, default: '' }
}, { _id: false });

const FormulaSchema = new mongoose.Schema({
  name:        { type: String, required: true, index: true },
  key:         { type: String, required: true, unique: true }, // slug/id for lookups
  description: { type: String, default: '' },

  // Expression can be plain infix (stored as string), or JSON-DSL later.
  // We keep it as string now; evaluator comes later.
  expression:  { type: String, required: true },

  variables:   [FormulaVarSchema],

  // Scoping: formulas can be global or client-specific (optional).
  scope: {
    type: { type: String, enum: ['global','client'], default: 'global' },
    clientId: { type: String, default: '' }
  },

  // Lifecycle
  status:   { type: String, enum: ['draft','published','archived'], default: 'draft' },
  version:  { type: String, default: '1.0.0' },

  // Ownership / audit
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Soft delete
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date },
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, {
  timestamps: true,
  collection: 'reduction_formulas'
});

module.exports = mongoose.model('Formula', FormulaSchema);
