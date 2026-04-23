'use strict';

const mongoose = require('mongoose');

const FrameworkLibrarySchema = new mongoose.Schema({
  framework_code:    { type: String, required: true, unique: true, trim: true },
  framework_name:    { type: String, required: true },
  framework_version: { type: String, required: true },
  supported_methods: [{ type: String }],
  is_active:         { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('FrameworkLibrary', FrameworkLibrarySchema);
