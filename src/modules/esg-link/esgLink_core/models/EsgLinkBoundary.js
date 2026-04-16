'use strict';
/**
 * EsgLinkBoundary.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Stores the ESGLink Core Boundary — the organisational node/edge structure
 * used as the foundation for ESG data collection.
 *
 * This is intentionally lean: it stores ONLY structural node data and edges,
 * never ZeroCarbon-specific scope details, emission factors, or API/IOT configs.
 */

const mongoose = require('mongoose');

// ── BoundaryNodeSchema ────────────────────────────────────────────────────────
const BoundaryNodeSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    description: 'Unique node identifier (matches ZeroCarbon node.id if imported)'
  },
  label: {
    type: String,
    required: true,
    trim: true
  },
  type: {
    type: String,
    enum: ['entity', 'department', 'site', 'subsidiary', 'holding', 'custom'],
    default: 'entity'
  },
  position: {
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 }
  },
  details: {
    name:       { type: String, default: '' },
    department: { type: String, default: '' },
    location:   { type: String, default: '' },
    entityType: { type: String, default: '' },
    notes:      { type: String, default: '' }
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { _id: false });

// ── BoundaryEdgeSchema ────────────────────────────────────────────────────────
const BoundaryEdgeSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true
  },
  source: {
    type: String,
    required: true,
    description: 'id of the source node'
  },
  target: {
    type: String,
    required: true,
    description: 'id of the target node'
  },
  label: {
    type: String,
    default: ''
  }
}, { _id: false });

// ── EsgLinkBoundarySchema ─────────────────────────────────────────────────────
const EsgLinkBoundarySchema = new mongoose.Schema(
  {
    clientId: {
      type: String,
      required: true,
      index: true,
      description: 'Matches Client.clientId'
    },

    // How was this boundary created?
    setupMethod: {
      type: String,
      enum: ['imported_from_zero_carbon', 'manual'],
      required: true,
      description: '"imported_from_zero_carbon" = auto-fetched from ZeroCarbon org flowchart; "manual" = created by consultant'
    },

    // If imported: track which ZeroCarbon flowchart version was the source
    importedFromFlowchartId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Flowchart',
      default: null
    },
    importedFromChartVersion: {
      type: Number,
      default: null
    },

    nodes: {
      type: [BoundaryNodeSchema],
      default: []
    },

    edges: {
      type: [BoundaryEdgeSchema],
      default: []
    },

    version: {
      type: Number,
      default: 1,
      description: 'Incremented on every save'
    },

    isActive: {
      type: Boolean,
      default: true
    },

    // Audit trail
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    lastModifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },

    // Soft-delete
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

// ── Compound index — one active boundary per client ───────────────────────────
EsgLinkBoundarySchema.index({ clientId: 1, isActive: 1 });

// ── Field-level encryption — AES-256-GCM (same fields as Flowchart + ProcessFlowchart) ──
// nodes and edges contain organisational entity names, locations, and structure —
// these are encrypted at rest using the project's shared encryptionPlugin.
// Requires FIELD_ENCRYPTION_KEY env var (64-char hex, 32 bytes).
const encryptionPlugin = require('../../../../common/utils/mongooseEncryptionPlugin');
EsgLinkBoundarySchema.plugin(encryptionPlugin, {
  fields: ['nodes', 'edges'],
});

module.exports = mongoose.model('EsgLinkBoundary', EsgLinkBoundarySchema);
