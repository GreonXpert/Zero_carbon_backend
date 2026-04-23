'use strict';

const mongoose = require('mongoose');

const RolePermissionMatrixSchema = new mongoose.Schema({
  role_code:     { type: String, required: true },
  action_code:   { type: String, required: true },
  resource_type: { type: String, required: true },
  scope_type:    { type: String, default: 'Org' },
  allowed:       { type: Boolean, required: true, default: false },
}, { timestamps: true });

RolePermissionMatrixSchema.index({ role_code: 1, action_code: 1, resource_type: 1 }, { unique: true });

module.exports = mongoose.model('RolePermissionMatrix', RolePermissionMatrixSchema);
