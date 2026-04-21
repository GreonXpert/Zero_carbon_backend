// models/ThresholdConfig/ThresholdConfig.js
"use strict";
const mongoose = require("mongoose");

/**
 * ThresholdConfig
 * Configured by consultant_admin per client+scopeIdentifier (DataEntry)
 * or per client+projectId (NetReduction).
 *
 * When isActive=true and incoming data deviates from the historical daily-normalized
 * average by more than thresholdPercentage%, the entry is intercepted and held
 * in PendingApproval for consultant_admin review before being finalized.
 */
const ThresholdConfigSchema = new mongoose.Schema(
  {
    clientId: {
      type: String,
      required: true,
      index: true
    },

    // For flowType='dataEntry': scope identifier (e.g. 'scope1_fuel_combustion')
    // For flowType='netReduction': projectId of the reduction project
    scopeIdentifier: {
      type: String,
      required: true,
      index: true
    },

    // Optional: restrict to a specific node. null = applies to all nodes with this scopeIdentifier
    nodeId: {
      type: String,
      default: null
    },

    // Which flow this config applies to
    flowType: {
      type: String,
      enum: ["dataEntry", "netReduction"],
      required: true
    },

    // Percentage deviation allowed before flagging anomaly (0.1 – 10000)
    thresholdPercentage: {
      type: Number,
      required: true,
      min: 0.1,
      max: 10000
    },

    // Whether this config is currently active
    isActive: {
      type: Boolean,
      default: true
    },

    // How many historical records to use for computing the baseline average
    baselineSampleSize: {
      type: Number,
      default: 10,
      min: 3,
      max: 50
    },

    // Minimum number of historical entries needed before starting threshold checks
    // Set to 1 for immediate anomaly detection, 2-3 for more data points, default 3
    minSamplesBeforeCheck: {
      type: Number,
      default: 3,
      min: 1,
      max: 10
    },

    // If set, only intercept entries from these inputTypes.
    // Empty array means all inputTypes are subject to threshold check.
    appliesToInputTypes: {
      type: [String],
      default: []
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },

    createdByType: {
      type: String
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    }
  },
  {
    timestamps: true
  }
);

// Compound unique index — one active config per client+scope+flowType+node
ThresholdConfigSchema.index(
  { clientId: 1, scopeIdentifier: 1, flowType: 1, nodeId: 1 },
  { unique: true, sparse: true }
);

module.exports = mongoose.model("ThresholdConfig", ThresholdConfigSchema);
