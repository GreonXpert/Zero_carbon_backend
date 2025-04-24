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
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  nodes: [NodeSchema],
  edges: [EdgeSchema],
});

module.exports = mongoose.model('ProcessFlowchart', ProcessFlowchartSchema);
