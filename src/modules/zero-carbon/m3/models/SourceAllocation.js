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
  chartType: {
  type: String,
  enum: ['organizationFlowchart', 'processFlowchart'],
  required: true,
  index: true,
},

chartId: {
  type: mongoose.Schema.Types.ObjectId,
  default: null,
  index: true,
},

nodeId: {
  type: String,
  required: true,
  index: true,
},

nodeLabel: {
  type: String,
  default: '',
},

scopeIdentifier: {
  type: String,
  required: true,
  index: true,
},

scopeType: {
  type: String,
  default: '',
},

categoryName: {
  type: String,
  default: '',
},

activity: {
  type: String,
  default: '',
},

scopeAllocationPct: {
  type: Number,
  default: 100,
  min: 0,
  max: 100,
},

categoryAllocationPct: {
  type: Number,
  default: 100,
  min: 0,
  max: 100,
},

nodeAllocationPct: {
  type: Number,
  default: 100,
  min: 0,
  max: 100,
},

scopeDetailAllocationPct: {
  type: Number,
  default: 100,
  min: 0,
  max: 100,
},

absoluteAllocatedValue: {
  type: Number,
  default: 0,
  min: 0,
},
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
  {
    target_id: 1,
    chartType: 1,
    chartId: 1,
    nodeId: 1,
    scopeIdentifier: 1,
  },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
  }
);

module.exports = mongoose.model('SourceAllocation', SourceAllocationSchema);
