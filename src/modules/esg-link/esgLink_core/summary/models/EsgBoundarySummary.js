'use strict';

const mongoose = require('mongoose');

const ContributingNodeSchema = new mongoose.Schema(
  {
    nodeId:    { type: String },
    nodeLabel: { type: String },
    value:     { type: Number, default: 0 },
    entryId:   { type: mongoose.Schema.Types.ObjectId, ref: 'EsgDataEntry' },
    decidedAt: { type: Date },
  },
  { _id: false }
);

const MetricGroupSchema = new mongoose.Schema(
  {
    metricId:          { type: mongoose.Schema.Types.ObjectId, ref: 'EsgMetric' },
    metricCode:        { type: String },
    metricName:        { type: String },
    esgCategory:       { type: String },
    subcategoryCode:   { type: String },
    metricType:        { type: String },
    primaryUnit:       { type: String },
    rollUpBehavior:    { type: String, default: 'sum' },
    boundaryScope:     { type: String, default: '' },
    combinedValue:     { type: Number, default: 0 },
    contributingNodes: [ContributingNodeSchema],
    entryCount:        { type: Number, default: 0 },
  },
  { _id: false }
);

const NodeMetricSchema = new mongoose.Schema(
  {
    metricId:        { type: mongoose.Schema.Types.ObjectId, ref: 'EsgMetric' },
    metricCode:      { type: String },
    metricName:      { type: String },
    esgCategory:     { type: String },
    subcategoryCode: { type: String },
    value:           { type: Number, default: 0 },
    unit:            { type: String },
    rollUpBehavior:  { type: String },
    entryCount:      { type: Number, default: 0 },
  },
  { _id: false }
);

const NodeSummarySchema = new mongoose.Schema(
  {
    nodeId:    { type: String },
    nodeLabel: { type: String },
    metrics:   [NodeMetricSchema],
  },
  { _id: false }
);

const CategorySummarySchema = new mongoose.Schema(
  {
    esgCategory: { type: String },
    total:       { type: Number, default: 0 },
    entryCount:  { type: Number, default: 0 },
  },
  { _id: false }
);

const BoundaryScopeSummarySchema = new mongoose.Schema(
  {
    boundaryScope: { type: String },   // e.g. 'Scope 1', 'Scope 2', 'Scope 3', or custom
    total:         { type: Number, default: 0 },
    entryCount:    { type: Number, default: 0 },
    metrics: [
      {
        metricId:       { type: mongoose.Schema.Types.ObjectId, ref: 'EsgMetric' },
        metricCode:     { type: String },
        metricName:     { type: String },
        esgCategory:    { type: String },
        subcategoryCode: { type: String },
        combinedValue:  { type: Number, default: 0 },
        primaryUnit:    { type: String },
      },
    ],
  },
  { _id: false }
);

const SummaryLayerSchema = new mongoose.Schema(
  {
    byMetric:        [MetricGroupSchema],
    byNode:          [NodeSummarySchema],
    byCategory:      [CategorySummarySchema],
    byBoundaryScope: [BoundaryScopeSummarySchema],
    totals: {
      E:       { type: Number, default: 0 },
      S:       { type: Number, default: 0 },
      G:       { type: Number, default: 0 },
      overall: { type: Number, default: 0 },
    },
  },
  { _id: false }
);

const esgBoundarySummarySchema = new mongoose.Schema(
  {
    clientId: {
      type:     String,
      required: true,
      index:    true,
    },
    boundaryDocId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'EsgLinkBoundary',
      required: true,
      index:    true,
    },
    periodYear: {
      type:     Number,
      required: true,
    },

    // workflowStatus = 'approved'
    approvedSummary:        { type: SummaryLayerSchema, default: () => ({}) },

    // submitted | under_review (no approvalDecisions) | clarification_requested | resubmitted
    reviewerPendingSummary: { type: SummaryLayerSchema, default: () => ({}) },

    // under_review with approvalDecisions populated
    approverPendingSummary: { type: SummaryLayerSchema, default: () => ({}) },

    // draft | submitted (before reviewer touch)
    draftSummary:           { type: SummaryLayerSchema, default: () => ({}) },

    lastComputedAt:        { type: Date, index: true },
    computationDurationMs: { type: Number },
    totalEntries:          { type: Number, default: 0 },
  },
  { timestamps: true }
);

esgBoundarySummarySchema.index({ clientId: 1, boundaryDocId: 1, periodYear: 1 }, { unique: true });

module.exports = mongoose.model('EsgBoundarySummary', esgBoundarySummarySchema);
