'use strict';

const mongoose = require('mongoose');
const { AllocationStatus } = require('../constants/enums');

const SourceAllocationSchema = new mongoose.Schema({
  clientId:       { type: String, required: true, index: true },
  target_id:      { type: mongoose.Schema.Types.ObjectId, ref: 'TargetMaster', required: true },
  source_code:    { type: String, required: true },
  category_code:  { type: String, required: true },
  facility_id:    { type: String, required: true },
  business_unit_id:{ type: String, default: null },
  allocated_pct:  { type: Number, required: true, min: 0, max: 100 },
  reconciliation_status: {
    type: String,
    enum: Object.values(AllocationStatus),
    default: AllocationStatus.DRAFT,
  },
  // Optimistic concurrency
  version:    { type: Number, default: 1 },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  isDeleted:  { type: Boolean, default: false },
}, { timestamps: true });

SourceAllocationSchema.index(
  { target_id: 1, source_code: 1, category_code: 1, facility_id: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);

module.exports = mongoose.model('SourceAllocation', SourceAllocationSchema);
