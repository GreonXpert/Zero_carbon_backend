'use strict';

const mongoose = require('mongoose');

const RAG_AUDIT_ACTIONS = [
  'TEMPLATE_CREATED', 'TEMPLATE_UPDATED', 'TEMPLATE_PUBLISHED',
  'TEMPLATE_ARCHIVED', 'TEMPLATE_DELETED',
  'TEMPLATE_VERSION_CREATED', 'TEMPLATE_VERSION_PUBLISHED',
  'REPORT_GENERATED', 'REPORT_REGENERATED', 'REPORT_EDITED',
  'REPORT_FINALIZED', 'REPORT_DELETED',
  'REPORT_EXPORTED_PDF', 'REPORT_EXPORTED_DOCX',
  'BRANDING_CREATED', 'BRANDING_UPDATED', 'BRANDING_SET_DEFAULT',
  'BRANDING_LOGO_UPLOADED', 'BRANDING_COVER_UPLOADED'
];

const ragAuditLogSchema = new mongoose.Schema(
  {
    action: { type: String, enum: RAG_AUDIT_ACTIONS, required: true },

    actor: {
      userId:         { type: mongoose.Schema.Types.ObjectId },
      email:          { type: String },
      role:           { type: String },
      // clientId is a custom string (e.g. "Greon008"), NOT a MongoDB ObjectId
      organizationId: { type: String }
    },

    resource: {
      type:           { type: String, enum: ['template', 'templateVersion', 'report', 'branding'] },
      id:             { type: mongoose.Schema.Types.ObjectId },
      // clientId is a custom string (e.g. "Greon008"), NOT a MongoDB ObjectId
      organizationId: { type: String }
    },

    before:   { type: mongoose.Schema.Types.Mixed, default: null },
    after:    { type: mongoose.Schema.Types.Mixed, default: null },

    context: {
      ip:        { type: String },
      userAgent: { type: String },
      requestId: { type: String },
      sessionId: { type: String }
    },

    metadata:  { type: mongoose.Schema.Types.Mixed, default: {} },
    timestamp: { type: Date, default: Date.now, required: true }
  },
  {
    timestamps: false,
    versionKey: false
  }
);

// Immutability guards — no updates or deletes allowed
['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne'].forEach(method => {
  ragAuditLogSchema.pre(method, function () {
    throw new Error('RagAuditLog is immutable — update operations are not permitted.');
  });
});

ragAuditLogSchema.pre('deleteOne', function () {
  throw new Error('RagAuditLog is immutable — delete operations are not permitted.');
});

// Indexes
ragAuditLogSchema.index({ timestamp: -1 });
ragAuditLogSchema.index({ 'actor.userId': 1, timestamp: -1 });
ragAuditLogSchema.index({ 'resource.id': 1, timestamp: -1 });
ragAuditLogSchema.index({ action: 1, timestamp: -1 });
ragAuditLogSchema.index({ 'actor.organizationId': 1, timestamp: -1 });
// TTL: 7 years retention
ragAuditLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 220752000 });

module.exports = mongoose.model('RagAuditLog', ragAuditLogSchema, 'rag_audit_logs');
module.exports.RAG_AUDIT_ACTIONS = RAG_AUDIT_ACTIONS;
