'use strict';
/**
 * EsgMetricApproval.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Stores pending approval requests for global metric mutations raised by
 * consultant_admin users. Super_admin must approve before the action executes.
 *
 * Lifecycle:
 *   consultant_admin requests create/update/publish/retire/delete
 *     → document created with status 'pending'
 *   super_admin approves
 *     → action executed on EsgMetric, status set to 'approved'
 *   super_admin rejects
 *     → status set to 'rejected', rejectionReason stored
 *
 * Constraint enforced in service layer:
 *   Only one 'pending' document per (metricId + actionType) at a time.
 *   For actionType 'create', metricId is null — only one pending create per
 *   unique proposedPayload combination is allowed (not strictly enforced at DB
 *   level; service checks for any pending 'create' requests from the same
 *   requestedBy user with same esgCategory+subcategoryCode).
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const EsgMetricApprovalSchema = new Schema(
  {
    actionType: {
      type:     String,
      enum:     ['create', 'update', 'publish', 'retire', 'delete'],
      required: true,
    },

    // null for actionType 'create' (metric does not yet exist)
    metricId: {
      type:    Schema.Types.ObjectId,
      ref:     'EsgMetric',
      default: null,
    },

    // Full metric fields for 'create'; delta fields for 'update';
    // empty object ({}) for 'publish' / 'retire' / 'delete'
    proposedPayload: {
      type:    Schema.Types.Mixed,
      default: {},
    },

    // Snapshot of EsgMetric at the time the request was raised.
    // Null for 'create' (metric doesn't exist yet).
    metricSnapshot: {
      type:    Schema.Types.Mixed,
      default: null,
    },

    requestedBy: {
      type:     Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    },

    // Snapshot of the requester's role at request time
    requestedByRole: {
      type:     String,
      required: true,
    },

    status: {
      type:    String,
      enum:    ['pending', 'approved', 'rejected'],
      default: 'pending',
    },

    // Populated when super_admin approves or rejects
    reviewedBy: {
      type:    Schema.Types.ObjectId,
      ref:     'User',
      default: null,
    },

    reviewedAt: {
      type:    Date,
      default: null,
    },

    rejectionReason: {
      type:    String,
      default: null,
    },
  },
  {
    timestamps:  true,
    collection:  'esg_metric_approvals',
    versionKey:  false,
  },
);

// Index for fast lookup of pending approvals per metric + action
EsgMetricApprovalSchema.index({ metricId: 1, actionType: 1, status: 1 });
EsgMetricApprovalSchema.index({ status: 1, createdAt: -1 });
EsgMetricApprovalSchema.index({ requestedBy: 1, status: 1 });

module.exports = mongoose.model('EsgMetricApproval', EsgMetricApprovalSchema);
