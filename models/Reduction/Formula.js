// models/Reduction/Formula.js
const mongoose = require('mongoose');

const VariableSchema = new mongoose.Schema({
  name:          { type: String, required: true },      // variable identifier used in expression
  label:         { type: String, default: '' },
  unit:          { type: String, default: '' },



  // Update policy
  updatePolicy:  { type: String, enum: ['manual','annual_automatic'], default: 'manual' },

  // Default / last value for frozen or policy-managed vars
  defaultValue:  { type: Number, default: null },
  lastValue:     { type: Number, default: null },
  lastUpdatedAt: { type: Date },

  
}, { _id: false });

const ReductionFormulaSchema = new mongoose.Schema({
  name:        { type: String, required: true, index: true },
  description: { type: String, default: '' },
  link:        { type: String, default: '' },

  // Expression; variables must match VariableSchema.name
  expression:  { type: String, required: true }, // e.g. "(A * B) - sqrt(C) / D"

  variables:   [VariableSchema],

  // Optional versioning
  version:     { type: Number, default: 1 },

  // Who can see/edit (you can also enforce via routes)
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt:   { type: Date, default: Date.now },
  isDeleted:   { type: Boolean, default: false }
}, {
  timestamps: true,
  collection: 'reduction_formulas'
});

ReductionFormulaSchema.index({ name: 1, version: -1 });

module.exports = mongoose.model('ReductionFormula', ReductionFormulaSchema);
