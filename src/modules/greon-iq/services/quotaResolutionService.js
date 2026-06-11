'use strict';

// ============================================================================
// quotaResolutionService.js — Resolves effective quota access for a user
//
// Resolution order:
//   1. Unlimited roles (super_admin, consultant_admin) → bypass all limits
//   2. Credited roles (consultant, client_admin, client_employee_head)
//      → check GreonIQCreditWallet balance
//   3. All other roles are blocked by greonIQAccessGate before reaching here
//
// This service only READS wallet state — it does not consume credits.
// ============================================================================

const { getBalance, getWallet } = require('./creditWalletService');

const UNLIMITED_ROLES = new Set(['super_admin', 'consultant_admin']);
const CREDITED_ROLES  = new Set(['consultant', 'client_admin', 'client_employee_head']);

/**
 * Check whether GreOn IQ is enabled for the user.
 * Returns enabledCheck object used downstream by quotaUsageService.
 *
 * @param {object} user      — req.user (mongoose doc or plain object)
 * @param {string} _clientId — kept for API compatibility (unused — wallet keyed by userId)
 * @returns {Promise<{ enabled: boolean, isUnlimited: boolean, balance: number|null }>}
 */
async function isGreonIQEnabled(user, _clientId) {
  const userType = String(user.userType || '');

  if (UNLIMITED_ROLES.has(userType)) {
    return { enabled: true, isUnlimited: true, balance: null };
  }

  if (CREDITED_ROLES.has(userType)) {
    const balance = await getBalance(user._id);
    return {
      enabled:     balance > 0,
      isUnlimited: false,
      balance,
    };
  }

  // Roles blocked by greonIQAccessGate never reach here,
  // but return disabled as a safe fallback.
  return { enabled: false, isUnlimited: false, balance: 0 };
}

/**
 * Get the chatRetentionLimit for a user.
 * Unlimited roles get 100; credited roles get 50; others 10.
 *
 * @param {object} user
 * @param {string} _clientId — kept for API compatibility
 * @returns {Promise<number>}
 */
async function getChatRetentionLimit(user, _clientId) {
  const userType = String(user.userType || '');
  if (UNLIMITED_ROLES.has(userType)) return 100;
  if (CREDITED_ROLES.has(userType))  return 50;
  return 10;
}

module.exports = { isGreonIQEnabled, getChatRetentionLimit, UNLIMITED_ROLES, CREDITED_ROLES };
