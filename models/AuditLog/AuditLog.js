'use strict';
// models/AuditLog/AuditLog.js
//
// Central audit / activity log for GreonXpert / Zero Carbon Backend.
//
// DESIGN GOALS:
//   - Single collection that answers: who did what, when, on which client/module/record
//   - Queryable by any combination of: clientId, actor, module, action, date range
//   - Role-scoped reads enforced at query level (not here)
//   - Super-admin-only deletes
//   - Intentionally lightweight: no massive before/after payloads stored inline;
//     use changeSummary (string) + metadata (small object) instead
//   - TTL index optional — comment-in the `expiresAt` field if retention is needed

const mongoose = require('mongoose');

// ── Allowed enum values (extend freely; fail-open enums = just a string field) ──

const MODULE_ENUM = [
  'auth',
  'user_management',
  'organization_flowchart',
  'process_flowchart',
  'transport_flowchart',
  'data_entry',
  'net_reduction',
  'reduction',
  'formula',
  'sbti',
  'emission_summary',
  'api_integration',
  'iot_integration',
  'reports',
  'tickets',
  'system',
  'other',
];

const ACTION_ENUM = [
  'login',
  'logout',
  'login_failed',
  'otp_sent',
  'otp_verified',
  'password_changed',
  'create',
  'update',
  'delete',
  'import',
  'export',
  'connect',
  'disconnect',
  'assign',
  'unassign',
  'approve',
  'reject',
  'calculate',
  'recalculate',
  'view',          // optional lightweight view tracking (high-volume — use sparingly)
  'other',
];

const SOURCE_ENUM = ['manual', 'api', 'iot', 'system', 'cron', 'socket'];

const STATUS_ENUM = ['success', 'failure'];

const SEVERITY_ENUM = ['info', 'warning', 'critical'];

// ── Schema ────────────────────────────────────────────────────────────────────

const auditLogSchema = new mongoose.Schema(
  {
    // ── Scope identifiers ──────────────────────────────────────────────────
    clientId: {
      type: String,
      index: true,
      default: null,
      // null for platform-level events (super_admin actions not tied to a client)
    },

    // ── Actor (who did it) ─────────────────────────────────────────────────
    actorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    actorUserType: {
      type: String,
      required: true,
      // not enum — user types can evolve without schema migration
    },
    actorName: {
      type: String,
      required: true,
      // snapshot of userName at the time of the event
    },
    actorEmail: {
      type: String,
      default: null,
      // snapshot — useful for audit trails even after user deletion
    },

    // ── Ownership chain (for efficient role-scoped queries) ────────────────
    consultantAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
      // populated when the event belongs to a consultant-managed client
    },
    clientAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      // populated for events within a client org
    },

    // ── What happened ──────────────────────────────────────────────────────
    module: {
      type: String,
      enum: MODULE_ENUM,
      required: true,
      index: true,
    },
    entityType: {
      type: String,
      default: null,
      // e.g., 'Flowchart', 'ProcessFlowchart', 'DataEntry', 'User', ...
    },
    entityId: {
      type: String,  // store as string to handle both ObjectId and custom string IDs
      default: null,
      index: true,
    },
    action: {
      type: String,
      enum: ACTION_ENUM,
      required: true,
      index: true,
    },
    subAction: {
      type: String,
      default: null,
      // optional finer grain: e.g., 'manual_edit', 'api_key_connect', 'scope1_entry'
    },

    // ── Target user (for user management events) ───────────────────────────
    targetUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
      // e.g., when a client_admin creates an employee account
    },
    targetUserName: {
      type: String,
      default: null,
      // snapshot
    },
    targetUserType: {
      type: String,
      default: null,
    },

    // ── Change summary (safe, small — NOT raw documents) ──────────────────
    changeSummary: {
      type: String,
      maxlength: 500,
      default: null,
      // Human-readable: "Updated emission factor from 2.4 to 2.6 for scope1_electricity"
    },

    // ── Metadata (flexible, size-capped) ──────────────────────────────────
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      // Keep small. Examples:
      // { nodeId: '...', scopeIdentifier: 'scope1_electricity', inputType: 'manual' }
      // { integrationName: 'Schneider IoT', configId: '...' }
      // { period: { year: 2024, month: 3 } }
    },

    // ── Request context ────────────────────────────────────────────────────
    requestInfo: {
      method: { type: String, default: null },
      path:   { type: String, default: null },
      ip:     { type: String, default: null },
      userAgent: { type: String, maxlength: 300, default: null },
    },

    // ── Source & outcome ───────────────────────────────────────────────────
    source: {
      type: String,
      enum: SOURCE_ENUM,
      default: 'manual',
    },
    status: {
      type: String,
      enum: STATUS_ENUM,
      default: 'success',
    },
    severity: {
      type: String,
      enum: SEVERITY_ENUM,
      default: 'info',
    },
    errorMessage: {
      type: String,
      maxlength: 500,
      default: null,
    },

    // ── Soft-delete support (for super_admin log purge tracking) ───────────
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    deletedAt: { type: Date, default: null },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // ── Optional TTL field ─────────────────────────────────────────────────
    // Uncomment expiresAt + the TTL index below to enable automatic expiry.
    // expiresAt: { type: Date, default: null },
  },
  {
    timestamps: true,   // createdAt = event timestamp; updatedAt rarely changes
    versionKey: false,
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────

// Primary query patterns for role-scoped list endpoints
auditLogSchema.index({ clientId: 1, createdAt: -1 });
auditLogSchema.index({ clientId: 1, module: 1, createdAt: -1 });
auditLogSchema.index({ clientId: 1, actorUserId: 1, createdAt: -1 });
auditLogSchema.index({ consultantAdminId: 1, createdAt: -1 });
auditLogSchema.index({ actorUserId: 1, createdAt: -1 });
auditLogSchema.index({ module: 1, action: 1, createdAt: -1 });
auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index({ targetUserId: 1, createdAt: -1 });
auditLogSchema.index({ isDeleted: 1, createdAt: -1 });

// TTL index (optional — uncomment when retention policy is ready):
// auditLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, sparse: true });

// ── Static helpers ────────────────────────────────────────────────────────────

/**
 * AuditLog.buildMatchStage(filters)
 * Utility to build a MongoDB $match stage from controller filters.
 * All filters are optional.
 */
auditLogSchema.statics.buildMatchStage = function (filters = {}) {
  const match = { isDeleted: false };

  if (filters.clientId)      match.clientId      = filters.clientId;
  if (filters.actorUserId)   match.actorUserId   = new mongoose.Types.ObjectId(filters.actorUserId);
  if (filters.targetUserId)  match.targetUserId  = new mongoose.Types.ObjectId(filters.targetUserId);
  if (filters.consultantAdminId) match.consultantAdminId = new mongoose.Types.ObjectId(filters.consultantAdminId);
  if (filters.module)        match.module        = filters.module;
  if (filters.action)        match.action        = filters.action;
  if (filters.status)        match.status        = filters.status;
  if (filters.severity)      match.severity      = filters.severity;
  if (filters.source)        match.source        = filters.source;
  if (filters.entityType)    match.entityType    = filters.entityType;
  if (filters.entityId)      match.entityId      = filters.entityId;

  if (filters.startDate || filters.endDate) {
    match.createdAt = {};
    if (filters.startDate) match.createdAt.$gte = new Date(filters.startDate);
    if (filters.endDate)   match.createdAt.$lte = new Date(filters.endDate);
  }

  return match;
};

module.exports = mongoose.model('AuditLog', auditLogSchema);
module.exports.MODULE_ENUM  = MODULE_ENUM;
module.exports.ACTION_ENUM  = ACTION_ENUM;
module.exports.SOURCE_ENUM  = SOURCE_ENUM;
module.exports.SEVERITY_ENUM = SEVERITY_ENUM;