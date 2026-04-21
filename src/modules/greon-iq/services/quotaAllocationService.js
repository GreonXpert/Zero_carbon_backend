'use strict';

// ============================================================================
// quotaAllocationService.js — Allocates and transfers GreOn IQ credits
//
// Allocation rules:
//   - Only ONE active allocation per (targetUserId, clientId) at a time.
//     Enforced by partial unique index in GreOnIQQuotaAllocation model.
//   - Allocator hierarchy:
//       super_admin      → may allocate to consultant_admin
//       consultant_admin → may allocate client pool to consultant
//       consultant       → may allocate from client pool to client users
//       client_admin     → may allocate to users in own client
//   - consultant and client_admin cannot both allocate to the same user (DB unique index).
// ============================================================================

const GreOnIQQuotaAllocation = require('../models/GreOnIQQuotaAllocation');
const ConsultantClientQuota  = require('../../client-management/quota/ConsultantClientQuota');
const { deriveWeekly, deriveDaily } = require('../utils/quotaMathHelpers');

const ALLOWED_ALLOCATORS = new Set([
  'super_admin', 'consultant_admin', 'consultant', 'client_admin',
]);

const ALLOWED_TARGET_USER_TYPES = new Set([
  'consultant',
  'client_admin',
  'client_employee_head',
  'employee',
  'viewer',
  'auditor',
  'contributor',
  'reviewer',
  'approver',
]);


/**
 * Allocate credits to a target user.
 *
 * @param {object} allocator   — req.user (the person doing the allocation)
 * @param {object} params
 * @param {string} params.targetUserId
 * @param {string} params.clientId
 * @param {number} params.monthlyCredits
 * @param {number} [params.chatRetentionLimit]
 * @param {Date}   [params.expiresAt]
 * @returns {Promise<object>}
 */
async function allocate(allocator, params) {
  if (!ALLOWED_ALLOCATORS.has(allocator.userType)) {
    return { error: 'Your role is not permitted to allocate GreOn IQ credits.', code: 'FORBIDDEN' };
  }

  const {
    targetUserId,
    targetUserType,
    clientId,
    monthlyCredits,
    chatRetentionLimit,
    expiresAt
  } = params;

  if (!targetUserId || !targetUserType || !clientId || monthlyCredits == null) {
    return {
      error: 'targetUserId, targetUserType, clientId, and monthlyCredits are required.',
      code: 'VALIDATION_ERROR'
    };
  }

  if (!ALLOWED_TARGET_USER_TYPES.has(targetUserType)) {
    return {
      error: 'Invalid targetUserType.',
      code: 'VALIDATION_ERROR'
    };
  }

  if (monthlyCredits < 1) {
    return {
      error: 'monthlyCredits must be >= 1.',
      code: 'VALIDATION_ERROR'
    };
  }

  await GreOnIQQuotaAllocation.updateMany(
    { targetUserId, clientId, isActive: true },
    { $set: { isActive: false } }
  );

  const weekly = deriveWeekly(monthlyCredits);
  const daily  = deriveDaily(weekly);

  const allocation = await GreOnIQQuotaAllocation.create({
    targetUserId,
    targetUserType,
    clientId,
    allocatedBy: allocator._id,
    allocatorRole: allocator.userType,
    monthlyCredits,
    weeklyCredits: weekly,
    dailyCredits: daily,
    chatRetentionLimit: Math.min(Math.max(chatRetentionLimit || 10, 10), 100),
    isActive: true,
    activeSince: new Date(),
    expiresAt: expiresAt || null,
  });

  return { allocation };
}

async function revoke(targetUserId, clientId) {
  await GreOnIQQuotaAllocation.updateMany(
    { targetUserId, clientId, isActive: true },
    { $set: { isActive: false } }
  );
  return { revoked: true };
}


/**
 * Update an existing allocation's limits without deactivating it.
 * @param {string} allocationId
 * @param {object} updates  — { monthlyCredits?, chatRetentionLimit?, expiresAt? }
 */
async function update(allocationId, updates) {
  const allocation = await GreOnIQQuotaAllocation.findById(allocationId);
  if (!allocation) return { error: 'Allocation not found.', code: 'NOT_FOUND' };

  if (updates.monthlyCredits !== undefined) {
    allocation.monthlyCredits = updates.monthlyCredits;
    allocation.weeklyCredits  = deriveWeekly(updates.monthlyCredits);
    allocation.dailyCredits   = deriveDaily(allocation.weeklyCredits);
  }
  if (updates.chatRetentionLimit !== undefined) {
    allocation.chatRetentionLimit = Math.min(Math.max(updates.chatRetentionLimit, 10), 100);
  }
  if (updates.expiresAt !== undefined) {
    allocation.expiresAt = updates.expiresAt;
  }

  await allocation.save();
  return { allocation };
}

/**
 * Get all active allocations created by a given allocator.
 */
async function listByAllocator(allocatorId, clientId) {
  return GreOnIQQuotaAllocation.find({
    allocatedBy: allocatorId,
    ...(clientId ? { clientId } : {}),
    isActive: true,
  }).lean();
}

/**
 * Get the active allocation for a target user.
 */
async function getAllocationForUser(targetUserId, clientId) {
  return GreOnIQQuotaAllocation.findOne({
    targetUserId,
    clientId,
    isActive: true,
  }).lean();
}

module.exports = { allocate, revoke, update, listByAllocator, getAllocationForUser };
