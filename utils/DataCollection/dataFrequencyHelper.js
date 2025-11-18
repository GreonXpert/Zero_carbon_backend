// utils/DataCollection/dataFrequencyHelper.js
const moment = require('moment');

/**
 * Map collectionFrequency to a { from, to } window for "current" period.
 * Supports: 'real-time', 'daily', 'weekly', 'monthly', 'quarterly', 'annually'
 */
function getCurrentWindowForFrequency(collectionFrequency, now = new Date()) {
  const freq = (collectionFrequency || 'monthly').toLowerCase();
  const m = moment.utc(now);

  let from, to;

  switch (freq) {
    case 'real-time':
      // you can tighten this (e.g. last 1 hour) if you want
      from = m.clone().subtract(1, 'day').startOf('day');
      to   = m.clone().endOf('day');
      break;

    case 'daily':
      from = m.clone().startOf('day');
      to   = m.clone().endOf('day');
      break;

    case 'weekly':
      // ISO week
      from = m.clone().startOf('isoWeek');
      to   = m.clone().endOf('isoWeek');
      break;

    case 'monthly':
      from = m.clone().startOf('month');
      to   = m.clone().endOf('month');
      break;

    case 'quarterly': {
      const quarter = m.quarter(); // 1..4
      from = m.clone().quarter(quarter).startOf('quarter');
      to   = m.clone().quarter(quarter).endOf('quarter');
      break;
    }

    case 'annually':
      from = m.clone().startOf('year');
      to   = m.clone().endOf('year');
      break;

    default:
      from = m.clone().startOf('month');
      to   = m.clone().endOf('month');
      break;
  }

  return { from: from.toDate(), to: to.toDate(), frequency: freq };
}

/**
 * Check if a last entry is missing for this frequency in the current window.
 * If there is no lastEntryAt → definitely missing.
 * If lastEntryAt is before the current window's 'from' → missing.
 */
function isDataMissingForCurrentWindow(collectionFrequency, lastEntryAt, now = new Date()) {
  const { from } = getCurrentWindowForFrequency(collectionFrequency, now);
  if (!lastEntryAt) return true;
  const last = new Date(lastEntryAt);
  return last < from;
}

module.exports = {
  getCurrentWindowForFrequency,
  isDataMissingForCurrentWindow,
};
