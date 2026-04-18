'use strict';

/**
 * ESG-aware frequency + period helper.
 *
 * Wraps the Zero Carbon dataFrequencyHelper for window calculation,
 * and adds ESG-specific period label generation and reminder classification.
 */

const {
  getCurrentWindowForFrequency,
  isDataMissingForCurrentWindow,
} = require('../../../../zero-carbon/data-collection/utils/dataFrequencyHelper');

// ─── Period Label Generation ──────────────────────────────────────────────────

/**
 * Generate the canonical period label for a given date and frequency.
 * Monthly  → "2024-03"
 * Quarterly → "2024-Q1"
 * Annually / Yearly → "2024"
 * Weekly   → "2024-W03"
 * Daily    → "2024-03-15"
 */
function getPeriodLabel(frequency, date = new Date()) {
  const d = new Date(date);
  const year = d.getFullYear();

  switch (frequency) {
    case 'daily':
      return `${year}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    case 'weekly': {
      const startOfYear = new Date(year, 0, 1);
      const weekNum = Math.ceil(
        ((d - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7
      );
      return `${year}-W${String(weekNum).padStart(2, '0')}`;
    }

    case 'monthly':
      return `${year}-${String(d.getMonth() + 1).padStart(2, '0')}`;

    case 'quarterly': {
      const q = Math.floor(d.getMonth() / 3) + 1;
      return `${year}-Q${q}`;
    }

    case 'semiannual': {
      const h = d.getMonth() < 6 ? 'H1' : 'H2';
      return `${year}-${h}`;
    }

    case 'annually':
    case 'yearly':
    default:
      return `${year}`;
  }
}

/**
 * Classify reminder type for a mapping's current period.
 * Returns 'due' | 'overdue' | 'missed' | null (if data exists).
 *
 * @param {string} frequency
 * @param {Date|null} lastApprovedAt  - date of latest approved submission
 * @param {Date|null} lastSubmittedAt - date of latest any-status submission
 * @param {Date} now
 */
function classifyReminder(frequency, lastApprovedAt, lastSubmittedAt, now = new Date()) {
  const window = getCurrentWindowForFrequency(frequency, now);
  if (!window) return null;

  const { from, to } = window;
  const hasApproved = lastApprovedAt && lastApprovedAt >= from && lastApprovedAt <= to;
  const hasSubmitted = lastSubmittedAt && lastSubmittedAt >= from;

  if (hasApproved) return null; // data exists and approved — no reminder needed

  const isWindowPast = now > to;

  if (isWindowPast) {
    return hasSubmitted ? 'overdue' : 'missed'; // submitted but not approved = overdue; nothing at all = missed
  }

  return hasSubmitted ? null : 'due'; // within window, nothing submitted = due reminder
}

module.exports = {
  getCurrentWindowForFrequency, // re-export for convenience
  isDataMissingForCurrentWindow,
  getPeriodLabel,
  classifyReminder,
};
