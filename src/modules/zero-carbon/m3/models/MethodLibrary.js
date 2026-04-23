'use strict';

const mongoose = require('mongoose');

const MethodLibrarySchema = new mongoose.Schema({
  method_code:         { type: String, required: true, unique: true, trim: true },
  method_name:         { type: String, required: true },
  calculation_engine:  { type: String, required: true },
  // JSON object with required parameters (e.g., SDA sectoral curves: { year: factor })
  required_parameters: { type: mongoose.Schema.Types.Mixed, default: {} },
  framework_gating:    [{ type: String }],
  is_active:           { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('MethodLibrary', MethodLibrarySchema);
