'use strict';

// ============================================================================
// quotaResolutionService.js — Resolves effective quota limits for a user
//
// Resolution order:
//   1. Unlimited roles (super_admin, consultant_admin) → bypass all limits
//   2. Active GreOnIQQuotaAllocation for the user+client → use allocation limits
//   3. ConsultantClientQuota greonIQ limits for the client → use client pool defaults
//   4. No record found → greonIQEnabled = false (deny)
//
// This service only READS limits — it does not consume or reset them.
// ============================================================================

const GreOnIQQuotaAllocation = require('../models/GreOnIQQuotaAllocation');
const ConsultantClientQuota  = require('../../client-management/quota/ConsultantClientQuota');
const { deriveWeekly, deriveDaily } = require('../utils/quotaMathHelpers');

const UNLIMITED_ROLES = new Set(['super_admin', 'consultant_admin']);

/**
 * Check whether GreOn IQ is enabled for the user+client combination.
 * Returns enabledCheck object used downstream by quotaUsageService.
 *
 * @param {object} user        — req.user (mongoose doc or plain object)
 * @param {string} clientId
 * @returns {Promise<{ enabled: boolean, isUnlimited: boolean, allocation: object|null,
 *                     monthlyLimit: number|null, weeklyLimit: number|null, dailyLimit: number|null }>}
 */
async function isGreonIQEnabled(user, clientId) {
  // ── Unlimited roles bypass quota entirely ─────────────────────────────────
  // String() coercion guards against Mongoose SchemaType proxies or undefined.
  const userType = String(user.userType || '');
  if (UNLIMITED_ROLES.has(userType)) {
    return {
      enabled:      true,
      isUnlimited:  true,
      allocation:   null,
      monthlyLimit: null,
      weeklyLimit:  null,
      dailyLimit:   null,
    };
  }

  // ── Look for an active per-user allocation ────────────────────────────────
  const allocation = await GreOnIQQuotaAllocation.findOne({
    targetUserId: user._id,
    clientId,
    isActive: true,
    $or: [
      { expiresAt: null },
      { expiresAt: { $gte: new Date() } },
    ],
  }).lean();

  if (allocation) {
    return {
      enabled:      true,
      isUnlimited:  false,
      allocation,
      monthlyLimit: allocation.monthlyCredits,
      weeklyLimit:  allocation.weeklyCredits  || deriveWeekly(allocation.monthlyCredits),
      dailyLimit:   allocation.dailyCredits   || deriveDaily(deriveWeekly(allocation.monthlyCredits)),
    };
  }

  // ── Fall back to client-level pool ────────────────────────────────────────
  const clientQuota = await ConsultantClientQuota.findOne({ clientId }).lean();

  if (clientQuota?.limits?.greonIQEnabled) {
    const monthly = clientQuota.limits.greonIQMonthlyLimit || 0;
    return {
      enabled:      true,
      isUnlimited:  false,
      allocation:   null,
      monthlyLimit: monthly,
      weeklyLimit:  deriveWeekly(monthly),
      dailyLimit:   deriveDaily(deriveWeekly(monthly)),
    };
  }

  // ── No allocation + not enabled at client level ───────────────────────────
  return {
    enabled:      false,
    isUnlimited:  false,
    allocation:   null,
    monthlyLimit: null,
    weeklyLimit:  null,
    dailyLimit:   null,
  };
}

/**
 * Get the chatRetentionLimit for a user (from allocation or client default).
 * @param {object} user
 * @param {string} clientId
 * @returns {Promise<number>}  — number of sessions to retain (10–100)
 */
async function getChatRetentionLimit(user, clientId) {
  if (UNLIMITED_ROLES.has(user.userType)) return 100;

  const allocation = await GreOnIQQuotaAllocation.findOne({
    targetUserId: user._id,
    clientId,
    isActive: true,
  }).lean();
  if (allocation?.chatRetentionLimit) return allocation.chatRetentionLimit;

  const clientQuota = await ConsultantClientQuota.findOne({ clientId }).lean();
  return clientQuota?.limits?.greonIQChatRetentionLimit || 10;
}

module.exports = { isGreonIQEnabled, getChatRetentionLimit };
