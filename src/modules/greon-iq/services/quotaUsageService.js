'use strict';

// ============================================================================
// quotaUsageService.js — Enforces and records credit consumption
//
// checkQuota()  — checks wallet balance before a query (no write)
// deductQuota() — atomically deducts credits after a successful query,
//                 and appends a GreOnIQUsageLedger record for analytics
//
// Credit cost is determined purely by total AI tokens consumed (not action
// type), using getTokenCreditCost() from quotaMathHelpers.
//
// Unlimited roles (super_admin, consultant_admin) skip deduction but still
// get a ledger entry with totalCredits=0 for audit purposes.
// ============================================================================

const GreOnIQUsageLedger = require('../models/GreOnIQUsageLedger');
const { deductCredits, getBalance } = require('./creditWalletService');
const { getTokenCreditCost, getPeriodKey, getWeekKey } = require('../utils/quotaMathHelpers');

/**
 * Check whether the user has remaining credits for the next query.
 * Does NOT write anything to the DB.
 *
 * @param {string} userId
 * @param {string} _clientId   — kept for API compatibility
 * @param {object} enabledCheck — from quotaResolutionService.isGreonIQEnabled()
 * @returns {Promise<{ allowed: boolean, balance?: number }>}
 */
async function checkQuota(userId, _clientId, enabledCheck) {
  if (enabledCheck.isUnlimited) return { allowed: true };

  // enabledCheck.balance is already loaded; re-check live to catch race between
  // the gate check and the actual query start
  const balance = await getBalance(userId);
  return { allowed: balance > 0, balance };
}

/**
 * Deduct credits and record a usage ledger entry after a successful query.
 * Always appends a ledger record (even for unlimited roles, with 0 credits).
 *
 * @param {string} userId
 * @param {string} clientId
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} [opts.messageId]
 * @param {string} opts.actionType
 * @param {number} opts.tokensIn
 * @param {number} opts.tokensOut
 * @param {object} opts.enabledCheck   — from isGreonIQEnabled()
 * @returns {Promise<{ creditsUsed: number, newBalance: number|null }>}
 */
async function deductQuota(userId, clientId, opts) {
  const { sessionId, messageId, actionType, tokensIn, tokensOut, enabledCheck } = opts;
  const now         = new Date();
  const totalTokens = (tokensIn || 0) + (tokensOut || 0);

  let creditsUsed = 0;
  let newBalance  = null;

  if (!enabledCheck.isUnlimited) {
    creditsUsed = getTokenCreditCost(totalTokens);

    const result = await deductCredits(userId, creditsUsed, {
      clientId,
      sessionId:  sessionId || null,
      messageId:  messageId || null,
      tokensIn:   tokensIn  || 0,
      tokensOut:  tokensOut || 0,
    });
    newBalance = result.newBalance;
  }

  // Always write to UsageLedger for analytics / audit trail
  await GreOnIQUsageLedger.create({
    userId,
    clientId,
    sessionId:          sessionId || null,
    messageId:          messageId || null,
    actionType,
    baseCredits:        creditsUsed,   // reuse field — stores token-based cost
    tokenBandAdjustment: 0,            // legacy field — zeroed out in new model
    totalCredits:       creditsUsed,
    periodKey:          getPeriodKey(now),
    weekKey:            getWeekKey(now),
    aiTokensIn:         tokensIn  || 0,
    aiTokensOut:        tokensOut || 0,
  });

  return { creditsUsed, newBalance };
}

/**
 * Get usage and wallet summary for a user.
 *
 * @param {string|ObjectId} userId
 * @param {string}          _clientId — kept for API compatibility
 * @returns {Promise<{ balance: number, lifetimeAdded: number, lifetimeUsed: number, totalQueries: number }>}
 */
async function getUsageSummary(userId, _clientId) {
  const { getWallet } = require('./creditWalletService');
  const wallet = await getWallet(userId);

  const totalQueries = await GreOnIQUsageLedger.countDocuments({ userId: String(userId) });

  return {
    balance:       wallet?.balance       ?? 0,
    lifetimeAdded: wallet?.lifetimeAdded ?? 0,
    lifetimeUsed:  wallet?.lifetimeUsed  ?? 0,
    totalQueries,
  };
}

module.exports = { checkQuota, deductQuota, getUsageSummary };
