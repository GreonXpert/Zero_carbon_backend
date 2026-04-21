'use strict';

// ============================================================================
// quotaUsageService.js — Enforces and records quota consumption
//
// checkQuota()  — reads UsageLedger to decide if limit is reached (no write)
// deductQuota() — atomically appends a UsageLedger record after success
//
// Period keys use IST-aware helpers from quotaMathHelpers.js.
// Unlimited roles skip all limit checks but still get ledger entries for
// audit/reporting purposes (with isUnlimited=true flag).
// ============================================================================

const GreOnIQUsageLedger = require('../models/GreOnIQUsageLedger');
const {
  getPeriodKey, getWeekKey, getTokenBandAdjustment, getNextWeeklyReset, getNextMonthlyReset,
} = require('../utils/quotaMathHelpers');

/**
 * Check whether the user has remaining quota for this period.
 * Does NOT write anything to the DB.
 *
 * @param {string} userId
 * @param {string} clientId
 * @param {object} enabledCheck  — from quotaResolutionService.isGreonIQEnabled()
 * @returns {Promise<{ allowed: boolean, period?: string, resetAt?: Date }>}
 */
async function checkQuota(userId, clientId, enabledCheck) {
  if (enabledCheck.isUnlimited) return { allowed: true };

  const now       = new Date();
  const periodKey = getPeriodKey(now);
  const weekKey   = getWeekKey(now);

  // Sum credits consumed this month and this week in parallel
  const [monthlyUsed, weeklyUsed, dailyUsed] = await Promise.all([
    _sumCredits({ userId, clientId, periodKey }),
    _sumCredits({ userId, clientId, weekKey }),
    _sumCredits({ userId, clientId, periodKey, weekKey, dailyOnly: true, date: now }),
  ]);

  if (enabledCheck.dailyLimit !== null && dailyUsed >= enabledCheck.dailyLimit) {
    return { allowed: false, period: 'daily', resetAt: _nextMidnightIST(now) };
  }
  if (enabledCheck.weeklyLimit !== null && weeklyUsed >= enabledCheck.weeklyLimit) {
    return { allowed: false, period: 'weekly', resetAt: getNextWeeklyReset() };
  }
  if (enabledCheck.monthlyLimit !== null && monthlyUsed >= enabledCheck.monthlyLimit) {
    return { allowed: false, period: 'monthly', resetAt: getNextMonthlyReset() };
  }

  return { allowed: true };
}

/**
 * Record a credit deduction after a successful query.
 * Always appends — never mutates existing records.
 *
 * @param {string} userId
 * @param {string} clientId
 * @param {object} opts
 * @returns {Promise<{ totalCredits: number }>}
 */
async function deductQuota(userId, clientId, opts) {
  const { sessionId, actionType, baseCredits, tokensIn, tokensOut, enabledCheck } = opts;
  const now               = new Date();
  const tokenBandAdjust   = getTokenBandAdjustment(tokensIn + tokensOut);
  const totalCredits      = enabledCheck?.isUnlimited
    ? 0   // unlimited roles: record 0 consumed (no ledger pressure)
    : baseCredits + tokenBandAdjust;

  await GreOnIQUsageLedger.create({
    userId,
    clientId,
    sessionId:            sessionId || null,
    actionType,
    baseCredits,
    tokenBandAdjustment:  tokenBandAdjust,
    totalCredits,
    periodKey:            getPeriodKey(now),
    weekKey:              getWeekKey(now),
    aiTokensIn:           tokensIn  || 0,
    aiTokensOut:          tokensOut || 0,
    isUnlimited:          enabledCheck?.isUnlimited || false,
  });

  return { totalCredits };
}

/**
 * Get usage summary for a user (own usage breakdown).
 * @param {string} userId
 * @param {string} clientId
 * @returns {Promise<{ daily: number, weekly: number, monthly: number }>}
 */
async function getUsageSummary(userId, clientId) {
  const now       = new Date();
  const periodKey = getPeriodKey(now);
  const weekKey   = getWeekKey(now);

  const [monthly, weekly, daily] = await Promise.all([
    _sumCredits({ userId, clientId, periodKey }),
    _sumCredits({ userId, clientId, weekKey }),
    _sumCredits({ userId, clientId, periodKey, weekKey, dailyOnly: true, date: now }),
  ]);

  return { daily, weekly, monthly };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _sumCredits(filter) {
  const match = { userId: String(filter.userId), clientId: String(filter.clientId) };
  if (filter.periodKey) match.periodKey = filter.periodKey;
  if (filter.weekKey)   match.weekKey   = filter.weekKey;

  if (filter.dailyOnly && filter.date) {
    // IST day start
    const ist       = new Date(filter.date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const dayStart  = new Date(ist);
    dayStart.setHours(0, 0, 0, 0);
    // Convert back to UTC
    const offsetMs  = filter.date.getTime() - ist.getTime();
    const dayStartUTC = new Date(dayStart.getTime() + offsetMs);
    match.createdAt = { $gte: dayStartUTC };
  }

  const agg = await GreOnIQUsageLedger.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$totalCredits' } } },
  ]);
  return agg[0]?.total || 0;
}

function _nextMidnightIST(now) {
  const ist      = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const tomorrow = new Date(ist);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const offsetMs = now.getTime() - ist.getTime();
  return new Date(tomorrow.getTime() + offsetMs);
}

module.exports = { checkQuota, deductQuota, getUsageSummary };
