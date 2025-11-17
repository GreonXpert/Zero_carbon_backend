// models/TransportFlowchart.js
const mongoose = require('mongoose');

// Simple node schema for transportation-specific charts.
// Each node represents a Scope with category "Upstream transportation" or "Downstream transportation"
// coming from either the organization Flowchart or the ProcessFlowchart.
const TransportNodeSchema = new mongoose.Schema({
  id: { type: String, required: true },          // React Flow node id
  label: { type: String, required: true },       // Display label

  position: {
    x: { type: Number, required: true, default: 0 },
    y: { type: Number, required: true, default: 0 }
  },

  // Transport direction for this node
  direction: {
    type: String,
    enum: ['upstream', 'downstream'],
    required: true
  },

  // Source reference so we know which original node / scope this came from
  source: {
    chartType: {
      type: String,
      enum: ['flowchart', 'processflowchart', 'merged'],
      required: true
    },
    nodeId: { type: String, required: true },
    scopeIdentifier: { type: String, required: true }
  },

  // Lightweight details for UI – we do NOT duplicate the full ScopeDetailSchema here.
  details: {
    categoryName: { type: String, default: '' },
    activity:     { type: String, default: '' },
    scopeType:    { type: String, default: '' },
    nodeLabel:    { type: String, default: '' },
    department:   { type: String, default: '' },
    location:     { type: String, default: '' }
  }
}, { _id: false });

const TransportEdgeSchema = new mongoose.Schema({
  id:     { type: String, required: true },
  source: { type: String, required: true },
  target: { type: String, required: true },
  sourcePosition: { type: String },
  targetPosition: { type: String }
}, { _id: false });

const TransportFlowchartSchema = new mongoose.Schema({
  clientId: {
    type: String,
    required: true,
    index: true
  },

  // "upstream" -> only upstream chart
  // "downstream" -> only downstream chart
  // "both" -> combined chart (if you ever want one chart for both)
  transportType: {
    type: String,
    enum: ['upstream', 'downstream', 'both'],
    required: true,
    default: 'both'
  },

  // Who created the transport chart
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  creatorType: {
    type: String,
    enum: ['super_admin', 'consultant_admin', 'consultant', 'client_admin'],
    required: true
  },

  lastModifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },

  // Snapshot of assessment levels at creation time (e.g. ['organization','process'])
  assessmentLevels: {
    type: [String],
    default: []
  },

  nodes: [TransportNodeSchema],
  edges: [TransportEdgeSchema],

  version:   { type: Number, default: 1 },
  isActive:  { type: Boolean, default: true }
}, {
  timestamps: true
});

// Index so each client can have one active chart per transportType
TransportFlowchartSchema.index({ clientId: 1, transportType: 1, isActive: 1 });

const TransportFlowchart = mongoose.model('TransportFlowchart', TransportFlowchartSchema);

module.exports = TransportFlowchart;
