const mongoose = require('mongoose');

const NodeSchema = new mongoose.Schema({
  id: { type: String, required: true },
  label: { type: String, required: true },
  position: {
    x: { type: Number, required: true },
    y: { type: Number, required: true },
  },
  parentNode: { type: String, default: null },
  // Use Mixed (or Object) to allow storing nested details
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
});

const EdgeSchema = new mongoose.Schema({
  id: { type: String, required: true },
  source: { type: String, required: true },
  target: { type: String, required: true },
});

const FlowchartSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  nodes: [NodeSchema],
  edges: [EdgeSchema],
});

const Flowchart = mongoose.model('Flowchart', FlowchartSchema);
module.exports = Flowchart;
