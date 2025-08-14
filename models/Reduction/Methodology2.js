// models/Reduction/Methodology2.js
const mongoose = require('mongoose');

/** Keep UnitItem compatible with M1 (ABD/APD/ALD structure) */
const UnitItemSchema = new mongoose.Schema({
  label: { type: String, required: true }, // e.g., L1
  value: { type: Number, required: true }, // ALD1
  EF:    { type: Number, required: true },
  GWP:   { type: Number, required: true },
  AF:    { type: Number, required: true },
  uncertainty: { type: Number, default: 0 } // percent
}, { _id: false });

/**
 * M2 subdocument (no math here; just storage).
 * - ALD items to compute LE exactly like M1 (to be computed later)
 * - formulaRef links to a separate formula (see Formula model)
 * - results placeholders to be filled by a calculator later
 */
const Methodology2Schema = new mongoose.Schema({
  // ALD: leakage emission units (same as M1 → for LE)
  ALD: [UnitItemSchema],

  // Results (to be computed later)
  LE: { type: Number, default: 0 },     // Leakage Emissions (sum-with-uncertainty)
  ER: { type: Number, default: 0 },     // Emission Reduction (defined by your formula later)
  CAPD: { type: Number, default: 0 },   // If your M2 uses an activity base, store here
  emissionReductionRate: { type: Number, default: 0 }, // feeds NetReduction

  // Link to a reusable custom formula (stored separately)
  formulaRef: {
    formulaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Formula' },
    version:   { type: String, default: '' } // snapshot of formula version when attached
  },

  // Values/params for the formula (free-form for now)
  formulaParams: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Notes
  notes: { type: String, default: '' }
}, { _id: false });

module.exports = Methodology2Schema;
