'use strict';

// ============================================================================
// creditWalletService.js — atomic credit wallet operations for GreOn IQ
//
// All mutations use MongoDB conditional findOneAndUpdate to prevent race
// conditions without application-level locking.
//
// Deductions use a { balance: { $gte: amount } } filter — if the filter
// doesn't match (insufficient balance) the update returns null and we
// throw CreditInsufficientError instead of overdrafting.
// ============================================================================

const GreonIQCreditWallet      = require('../models/GreonIQCreditWallet');
const GreonIQCreditTransaction = require('../models/GreonIQCreditTransaction');

// ── Custom error ──────────────────────────────────────────────────────────────
class CreditInsufficientError extends Error {
  constructor(balance, required) {
    super(`Insufficient GreOn IQ credits. Balance: ${balance}, required: ${required}.`);
    this.name    = 'CreditInsufficientError';
    this.code    = 'QUOTA_EXHAUSTED';
    this.balance = balance;
    this.required = required;
  }
}

/**
 * Get or create the credit wallet for a user.
 * Idempotent — safe to call multiple times for the same user.
 *
 * @param {string|ObjectId} userId
 * @param {'consultant'|'client_admin'|'client_employee_head'} userType
 * @param {string|null} clientId
 * @returns {Promise<object>}  — wallet document (lean)
 */
async function getOrCreateWallet(userId, userType, clientId = null) {
  const wallet = await GreonIQCreditWallet.findOneAndUpdate(
    { userId },
    {
      $setOnInsert: {
        userId,
        userType,
        clientId: clientId || null,
        balance:       0,
        lifetimeAdded: 0,
        lifetimeUsed:  0,
        isActive:      true,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  return wallet;
}

/**
 * Add credits to a user's wallet (atomic).
 * Creates a GreonIQCreditTransaction record.
 *
 * @param {string|ObjectId} userId
 * @param {number}          amount      — positive integer
 * @param {string}          type        — GreonIQCreditTransaction type
 * @param {object}          [metadata]
 * @returns {Promise<{ newBalance: number, transactionId: string }>}
 */
async function addCredits(userId, amount, type, metadata = {}) {
  if (!amount || amount <= 0) {
    throw new Error('addCredits: amount must be a positive number.');
  }

  const updated = await GreonIQCreditWallet.findOneAndUpdate(
    { userId },
    {
      $inc: {
        balance:       amount,
        lifetimeAdded: amount,
      },
    },
    { new: true }
  ).lean();

  if (!updated) {
    throw new Error(`No credit wallet found for userId ${userId}. Call getOrCreateWallet first.`);
  }

  const tx = await GreonIQCreditTransaction.create({
    walletId:     updated._id,
    userId,
    type,
    amount,
    balanceAfter: updated.balance,
    metadata,
  });

  return { newBalance: updated.balance, transactionId: String(tx._id) };
}

/**
 * Deduct credits from a user's wallet (atomic, overdraft-safe).
 * Throws CreditInsufficientError if balance < amount.
 * Creates a GreonIQCreditTransaction record on success.
 *
 * @param {string|ObjectId} userId
 * @param {number}          amount      — positive integer to deduct
 * @param {object}          [metadata]
 * @returns {Promise<{ newBalance: number, transactionId: string }>}
 */
async function deductCredits(userId, amount, metadata = {}) {
  if (!amount || amount <= 0) {
    throw new Error('deductCredits: amount must be a positive number.');
  }

  // Conditional update: only succeeds when balance >= amount
  const updated = await GreonIQCreditWallet.findOneAndUpdate(
    { userId, balance: { $gte: amount } },
    {
      $inc: {
        balance:      -amount,
        lifetimeUsed:  amount,
      },
    },
    { new: true }
  ).lean();

  if (!updated) {
    // Could be missing wallet OR insufficient balance; check which
    const wallet = await GreonIQCreditWallet.findOne({ userId }).lean();
    const current = wallet?.balance ?? 0;
    throw new CreditInsufficientError(current, amount);
  }

  const tx = await GreonIQCreditTransaction.create({
    walletId:     updated._id,
    userId,
    type:         'query_deduction',
    amount:       -amount,
    balanceAfter: updated.balance,
    metadata,
  });

  return { newBalance: updated.balance, transactionId: String(tx._id) };
}

/**
 * Get the current credit balance for a user.
 * Returns 0 if no wallet exists (safe default — caller decides to deny or not).
 *
 * @param {string|ObjectId} userId
 * @returns {Promise<number>}
 */
async function getBalance(userId) {
  const wallet = await GreonIQCreditWallet.findOne({ userId }, { balance: 1 }).lean();
  return wallet?.balance ?? 0;
}

/**
 * Returns true if the user has at least minAmount credits.
 *
 * @param {string|ObjectId} userId
 * @param {number}          minAmount
 * @returns {Promise<boolean>}
 */
async function hasEnoughCredits(userId, minAmount) {
  const balance = await getBalance(userId);
  return balance >= minAmount;
}

/**
 * Get wallet details including lifetime stats.
 *
 * @param {string|ObjectId} userId
 * @returns {Promise<object|null>}
 */
async function getWallet(userId) {
  return GreonIQCreditWallet.findOne({ userId }).lean();
}

/**
 * Manually adjust credits (add or remove).
 * Used by super_admin / consultant_admin via POST /quota/adjust.
 * Negative amount = deduction; positive = addition.
 * Prevents balance going below 0.
 *
 * @param {string|ObjectId} userId
 * @param {number}          amount    — can be negative
 * @param {string}          reason
 * @param {string|ObjectId} triggeredBy
 * @returns {Promise<{ newBalance: number, transactionId: string }>}
 */
async function manualAdjust(userId, amount, reason, triggeredBy) {
  if (amount === 0) throw new Error('manualAdjust: amount cannot be zero.');

  let updated;
  if (amount > 0) {
    updated = await GreonIQCreditWallet.findOneAndUpdate(
      { userId },
      { $inc: { balance: amount, lifetimeAdded: amount } },
      { new: true }
    ).lean();
  } else {
    const deduction = Math.abs(amount);
    updated = await GreonIQCreditWallet.findOneAndUpdate(
      { userId, balance: { $gte: deduction } },
      { $inc: { balance: amount, lifetimeUsed: deduction } },
      { new: true }
    ).lean();

    if (!updated) {
      const wallet = await GreonIQCreditWallet.findOne({ userId }).lean();
      throw new CreditInsufficientError(wallet?.balance ?? 0, deduction);
    }
  }

  if (!updated) {
    throw new Error(`No credit wallet found for userId ${userId}.`);
  }

  const tx = await GreonIQCreditTransaction.create({
    walletId:     updated._id,
    userId,
    type:         'manual_adjustment',
    amount,
    balanceAfter: updated.balance,
    metadata:     { reason, triggeredBy: String(triggeredBy) },
  });

  return { newBalance: updated.balance, transactionId: String(tx._id) };
}

module.exports = {
  CreditInsufficientError,
  getOrCreateWallet,
  addCredits,
  deductCredits,
  getBalance,
  hasEnoughCredits,
  getWallet,
  manualAdjust,
};
