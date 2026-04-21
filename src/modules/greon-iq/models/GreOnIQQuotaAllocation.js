'use strict';

// ============================================================================
// GreOnIQQuotaAllocation — per-user GreOn IQ credit allocation record
//
// HIERARCHY:
//   super_admin        → unlimited (no allocation record needed)
//   consultant_admin   → own personal allocation set by super_admin
//                        + sets client-level pool budget per client
//   consultant         → receives client pool budget from consultant_admin,
//                        distributes to users in their assigned client
//   client_admin       → can also distribute to users within their client
//   all other roles    → receive an individual allocation from consultant
//                        or client_admin
//
// CONFLICT PREVENTION:
//   Only one ACTIVE allocation is allowed per (targetUserId, clientId) pair.
//   The sparse unique index on { targetUserId, clientId } where isActive=true
//   enforces this at the database level.
//   Before creating a new allocation, quotaAllocationService must deactivate
//   any existing active allocation for that user+client.
//
// UNLIMITED ROLES:
//   super_admin and consultant_admin bypass this collection entirely.
//   Their access is resolved in quotaResolutionService by role check,
//   not by looking up an allocation record.
// ============================================================================

const mongoose = require('mongoose');

const GreOnIQQuotaAllocationSchema = new mongoose.Schema(
  {
    // ── Who receives the allocation ───────────────────────────────────────────
    targetUserId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
      index:    true,
    },
    targetUserType: {
      type: String,
      enum: [
        'consultant',
        'client_admin',
        'client_employee_head',
        'employee',
        'viewer',
        'auditor',
        'contributor',
        'reviewer',
        'approver',
      ],
      required: true,
    },
    clientId: {
      type:     String,
      required: true,
      index:    true,
    },

    // ── Who made the allocation ───────────────────────────────────────────────
    allocatedBy: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    },
    allocatorRole: {
      type: String,
      enum: ['super_admin', 'consultant_admin', 'consultant', 'client_admin'],
      required: true,
    },

    // ── Credit limits ─────────────────────────────────────────────────────────
    // monthlyCredits is the source of truth.
    // weeklyCredits and dailyCredits are auto-derived by quotaMathHelpers and
    // stored here for fast enforcement without recalculation on every request.
    monthlyCredits: {
      type:     Number,
      required: true,
      min:      1,
    },
    weeklyCredits: {
      type: Number,
      min:  0,
    },
    dailyCredits: {
      type: Number,
      min:  0,
    },

    // ── Chat history retention ────────────────────────────────────────────────
    // Number of sessions to retain per user. Min 10, max 100, default 10.
    chatRetentionLimit: {
      type:    Number,
      default: 10,
      min:     10,
      max:     100,
    },

    // ── State ─────────────────────────────────────────────────────────────────
    isActive: {
      type:    Boolean,
      default: true,
      index:   true,
    },
    activeSince: {
      type:    Date,
      default: () => new Date(),
    },
    // Optional: allocation can have an expiry date (null = no expiry)
    expiresAt: {
      type:    Date,
      default: null,
    },

    // ── Meta ──────────────────────────────────────────────────────────────────
    notes: {
      type:      String,
      default:   '',
      maxlength: 500,
    },
  },
  { timestamps: true }
);

// Enforce single active allocation per user per client at the DB level.
// Sparse: only applies when isActive = true, so historical (inactive) records
// do not block creating a fresh allocation for the same user+client.
GreOnIQQuotaAllocationSchema.index(
  { targetUserId: 1, clientId: 1 },
  {
    unique:                    true,
    partialFilterExpression:   { isActive: true },
    name:                      'unique_active_allocation_per_user_client',
  }
);

// Fast lookup: all active allocations made by a specific allocator
GreOnIQQuotaAllocationSchema.index({ allocatedBy: 1, clientId: 1, isActive: 1 });

module.exports = mongoose.model('GreOnIQQuotaAllocation', GreOnIQQuotaAllocationSchema);
