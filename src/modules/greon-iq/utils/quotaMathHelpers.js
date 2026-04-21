'use strict';

// ============================================================================
// quotaMathHelpers.js — GreOn IQ quota math, period keys, and credit weights
//
// DESIGN PRINCIPLES:
//   - All formula constants are defined here and exported. Never hardcode
//     credit values or divisors in service files.
//   - All date math uses Asia/Kolkata (IST) so period keys and reset
//     boundaries align with the configured cron schedule.
//   - weeklyLimit  = floor(monthlyLimit / WEEKLY_DIVISOR)
//   - dailyLimit   = floor(weeklyLimit  / DAILY_DIVISOR)
//   - Both divisors are constants in this file — changing them here
//     automatically propagates without any schema migration.
// ============================================================================

// ── Limit formula divisors (configurable here — do not duplicate elsewhere) ───
const WEEKLY_DIVISOR = 4;  // weeklyLimit = floor(monthlyLimit / 4)
const DAILY_DIVISOR  = 7;  // dailyLimit  = floor(weeklyLimit  / 7)

// ── Token-band adjustment rate ────────────────────────────────────────────────
// Added credits = floor(totalAiTokens / TOKEN_BAND_SIZE) * TOKEN_BAND_RATE
const TOKEN_BAND_SIZE = 1000;
const TOKEN_BAND_RATE = 0.1;

// ── Base credit weights per action type ───────────────────────────────────────
// These are the source-of-truth values. quotaUsageService reads from here.
const BASE_CREDITS = {
  simple_qa:      1,
  qa_table:       2,
  qa_chart_table: 3,
  cross_module:   4,
  report_preview: 5,
  export_pdf:     3,  // +3 on top of report_preview
  export_docx:    3,  // +3
  export_excel:   2,  // +2
};

// ── IST timezone identifier ───────────────────────────────────────────────────
const IST_TIMEZONE = 'Asia/Kolkata';

/**
 * Derive weekly limit from monthly limit.
 * @param {number} monthlyLimit
 * @returns {number}
 */
function deriveWeekly(monthlyLimit) {
  return Math.floor(monthlyLimit / WEEKLY_DIVISOR);
}

/**
 * Derive daily limit from weekly limit.
 * @param {number} weeklyLimit
 * @returns {number}
 */
function deriveDaily(weeklyLimit) {
  return Math.floor(weeklyLimit / DAILY_DIVISOR);
}

/**
 * Compute base credits for an action type.
 * For exports, pass the base action ('report_preview') + export type separately
 * and sum them in the caller.
 * @param {string} actionType
 * @returns {number}
 */
function getBaseCredits(actionType) {
  return BASE_CREDITS[actionType] ?? 1;
}

/**
 * Compute the token-band adjustment credit from raw AI token counts.
 * Returns 0 if token data is unavailable.
 * @param {number} tokensIn
 * @param {number} tokensOut
 * @returns {number}
 */
function getTokenBandAdjustment(tokensIn = 0, tokensOut = 0) {
  const total = (tokensIn || 0) + (tokensOut || 0);
  return Math.floor(total / TOKEN_BAND_SIZE) * TOKEN_BAND_RATE;
}

/**
 * Get the monthly period key in IST for a given date.
 * Format: 'YYYY-MM'
 * @param {Date} [date]
 * @returns {string}
 */
function getPeriodKey(date = new Date()) {
  const d = new Date(date.toLocaleString('en-US', { timeZone: IST_TIMEZONE }));
  const year  = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Get the ISO week key in IST for a given date.
 * Format: 'YYYY-Www'  (e.g. '2026-W17')
 * Week starts on Monday (ISO 8601).
 * @param {Date} [date]
 * @returns {string}
 */
function getWeekKey(date = new Date()) {
  const d = new Date(date.toLocaleString('en-US', { timeZone: IST_TIMEZONE }));
  // ISO week calculation
  const dayOfWeek = d.getDay() || 7;             // Mon=1 … Sun=7
  d.setDate(d.getDate() + 4 - dayOfWeek);        // Set to Thursday of current week
  const yearStart  = new Date(d.getFullYear(), 0, 1);
  const weekNumber = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
}

/**
 * Get the start-of-day Date in IST for a given date.
 * Used by quotaUsageService when querying daily totals.
 * @param {Date} [date]
 * @returns {Date}  UTC-equivalent Date representing 00:00 IST
 */
function getISTDayStart(date = new Date()) {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const utcMs  = date.getTime() - (date.getTime() % 86400000);
  const istDay = new Date(utcMs);
  // Adjust to IST midnight
  const istStr = new Date(date.toLocaleString('en-US', { timeZone: IST_TIMEZONE }));
  istStr.setHours(0, 0, 0, 0);
  // Convert back to UTC
  return new Date(istStr.getTime() - IST_OFFSET_MS);
}

/**
 * Get the ISO Date string for the next weekly reset (Mon 00:00 IST).
 * @param {Date} [from]
 * @returns {Date}
 */
function getNextWeeklyReset(from = new Date()) {
  const ist = new Date(from.toLocaleString('en-US', { timeZone: IST_TIMEZONE }));
  const dayOfWeek = ist.getDay() || 7;
  const daysUntilMonday = (8 - dayOfWeek) % 7 || 7;
  ist.setDate(ist.getDate() + daysUntilMonday);
  ist.setHours(0, 0, 0, 0);
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

/**
 * Get the Date for the next monthly reset (1st of next month 00:00 IST).
 * @param {Date} [from]
 * @returns {Date}
 */
function getNextMonthlyReset(from = new Date()) {
  const ist = new Date(from.toLocaleString('en-US', { timeZone: IST_TIMEZONE }));
  ist.setMonth(ist.getMonth() + 1, 1);
  ist.setHours(0, 0, 0, 0);
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

module.exports = {
  // Constants
  WEEKLY_DIVISOR,
  DAILY_DIVISOR,
  TOKEN_BAND_SIZE,
  TOKEN_BAND_RATE,
  BASE_CREDITS,
  IST_TIMEZONE,
  // Functions
  deriveWeekly,
  deriveDaily,
  getBaseCredits,
  getTokenBandAdjustment,
  getPeriodKey,
  getWeekKey,
  getISTDayStart,
  getNextWeeklyReset,
  getNextMonthlyReset,
};
