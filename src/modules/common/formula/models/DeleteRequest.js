'use strict';

/**
 * DeleteRequest.js — Common Formula Delete Request Model
 *
 * Tracks deletion requests submitted by consultants, pending approval
 * from consultant_admin or super_admin.
 *
 * Moved from: src/modules/zero-carbon/reduction/models/DeleteRequest.js
 * Old file is now a re-export pointing here.
 *
 * ref changed: 'ReductionFormula' → 'Formula' to match the new common model name.
 */

const mongoose = require('mongoose');

const DeleteRequestSchema = new mongoose.Schema({

  formulaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Formula',       // was: 'ReductionFormula'
    required: true
  },

  requestedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  requestedAt: { type: Date, default: Date.now },

  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },

  approvedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt:  { type: Date },

  reason:      { type: String }  // optional reason from the consultant

}, { timestamps: true });

module.exports = mongoose.model('DeleteRequest', DeleteRequestSchema);
