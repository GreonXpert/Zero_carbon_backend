'use strict';

const mongoose = require('mongoose');

const UserScopeMapSchema = new mongoose.Schema({
  user_id:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  clientId:    { type: String, required: true, index: true },
  role_code:   { type: String, required: true },
  scope_type:  { type: String, required: true },
  scope_value: { type: String, required: true },
}, { timestamps: true });

UserScopeMapSchema.index({ user_id: 1, clientId: 1 });

module.exports = mongoose.model('UserScopeMap', UserScopeMapSchema);
