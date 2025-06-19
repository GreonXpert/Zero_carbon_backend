// models/ProcessFlowchart.js
const mongoose = require('mongoose');

const NodeSchema = new mongoose.Schema({
  id: { type: String, required: true },
  label: { type: String, required: true },
  position: {
    x: { type: Number, required: true },
    y: { type: Number, required: true },
  },
  parentNode: { type: String, default: null },
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
});

const EdgeSchema = new mongoose.Schema({
  id: { type: String, required: true },
  source: { type: String, required: true },
  target: { type: String, required: true },
});

const ProcessFlowchartSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true }, // Changed from userId to clientId
  nodes: [NodeSchema],
  edges: [EdgeSchema],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lastModifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date },
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

// Add index for efficient queries
ProcessFlowchartSchema.index({ clientId: 1, isDeleted: 1 });

module.exports = mongoose.model('ProcessFlowchart', ProcessFlowchartSchema);