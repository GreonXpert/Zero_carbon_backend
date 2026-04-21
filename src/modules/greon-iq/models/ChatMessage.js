'use strict';

// ============================================================================
// ChatMessage — one message (user prompt or assistant response) within a session
//
// role 'user'      : the raw question submitted by the user
// role 'assistant' : the composed response from GreOn IQ
//
// Only assistant messages carry tables, charts, reportPreview, exclusions,
// followupQuestions, quotaUsed, and aiMeta. User messages carry only content.
// ============================================================================

const mongoose = require('mongoose');

// ── Table column descriptor ───────────────────────────────────────────────────
const TableColumnSchema = new mongoose.Schema(
  {
    key:   { type: String, required: true },
    label: { type: String, required: true },
  },
  { _id: false }
);

// ── Full table payload ────────────────────────────────────────────────────────
const TableSchema = new mongoose.Schema(
  {
    id:         { type: String },
    title:      { type: String },
    columns:    { type: [TableColumnSchema], default: [] },
    rows:       { type: [mongoose.Schema.Types.Mixed], default: [] },
    totalRows:  { type: Number, default: 0 },
    exportable: { type: Boolean, default: true },
    pagination: {
      page:     { type: Number, default: 1 },
      pageSize: { type: Number, default: 20 },
    },
  },
  { _id: false }
);

// ── Chart series entry ────────────────────────────────────────────────────────
const ChartSeriesSchema = new mongoose.Schema(
  {
    name: { type: String },
    data: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { _id: false }
);

// ── Full chart spec (frontend-renderable JSON) ────────────────────────────────
const ChartSchema = new mongoose.Schema(
  {
    id:     { type: String },
    type:   { type: String, enum: ['bar', 'line', 'pie', 'stacked_bar', 'trend', 'top_n'] },
    title:  { type: String },
    xAxis:  { type: [String], default: [] },
    series: { type: [ChartSeriesSchema], default: [] },
    unit:   { type: String, default: 'tCO2e' },
  },
  { _id: false }
);

// ── DeepSeek token metadata (stored after every AI call) ─────────────────────
const AiMetaSchema = new mongoose.Schema(
  {
    model:      { type: String },
    tokensIn:   { type: Number, default: 0 },
    tokensOut:  { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 },
  },
  { _id: false }
);

// ── Lightweight trace (returned in API response) ──────────────────────────────
const TraceSchema = new mongoose.Schema(
  {
    clientId:    { type: String },
    modulesUsed: { type: [String], default: [] },
    dateRange:   { type: mongoose.Schema.Types.Mixed },
    intent:      { type: String },
    product:     { type: String },
  },
  { _id: false }
);

// ── Main schema ───────────────────────────────────────────────────────────────
const ChatMessageSchema = new mongoose.Schema(
  {
    sessionId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'ChatSession',
      required: true,
      index:    true,
    },
    userId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    },
    clientId: {
      type:     String,
      required: true,
    },
    role: {
      type:     String,
      enum:     ['user', 'assistant'],
      required: true,
    },
    // Raw question text (role=user) or composed answer text (role=assistant)
    content: {
      type:     String,
      required: true,
    },
    outputMode: {
      type: String,
      enum: ['plain', 'table', 'chart', 'report', 'cross_module', null],
      default: null,
    },
    // Populated only on role=assistant
    tables:           { type: [TableSchema],  default: [] },
    charts:           { type: [ChartSchema],  default: [] },
    reportPreview:    { type: String,         default: null }, // markdown string
    exclusions:       { type: [String],       default: [] },
    followupQuestions:{ type: [String],       default: [] },
    // Credits consumed by this assistant message
    quotaUsed:        { type: Number,         default: 0 },
    trace:            { type: TraceSchema,    default: null },
    aiMeta:           { type: AiMetaSchema,   default: null },
  },
  {
    timestamps: true,
    // Exclude large arrays from default projections when listing history
  }
);

ChatMessageSchema.index({ sessionId: 1, createdAt: 1 });

module.exports = mongoose.model('ChatMessage', ChatMessageSchema);
