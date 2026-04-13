// services/verification/normalizationService.js

/**
 * Normalizes a raw emission/reduction value to a daily baseline so that
 * entries collected at different frequencies can be compared fairly.
 *
 * Supported frequencies come directly from the project's actual enums:
 *   DataCollectionConfig / Flowchart: ['real-time', 'daily', 'weekly', 'monthly', 'quarterly', 'annually']
 *   EmployeeCommuting Tier 2 extra:   ['half-yearly']
 */

const FREQUENCY_DIVISORS = {
  "real-time":   1,    // treated the same as daily
  "daily":       1,
  "weekly":      7,
  "monthly":     30,
  "quarterly":   90,
  "half-yearly": 182,
  "annually":    365
};

/**
 * Convert a raw value recorded at `frequency` cadence to its daily equivalent.
 *
 * @param {number} rawValue - The raw numeric value as submitted
 * @param {string} frequency - Collection frequency string
 * @returns {number} Daily-normalized value
 */
function normalizeToDailyValue(rawValue, frequency) {
  if (typeof rawValue !== "number" || !isFinite(rawValue)) return 0;

  const divisor = FREQUENCY_DIVISORS[frequency];

  // Unknown / unsupported frequency → default to monthly (30 days)
  if (!divisor) {
    return rawValue / 30;
  }

  return rawValue / divisor;
}

/**
 * Returns whether the given frequency string is recognized.
 * One-time or empty frequencies are not suitable for threshold comparison.
 *
 * @param {string} frequency
 * @returns {boolean}
 */
function isSupportedFrequency(frequency) {
  return Object.prototype.hasOwnProperty.call(FREQUENCY_DIVISORS, frequency);
}

module.exports = { normalizeToDailyValue, isSupportedFrequency, FREQUENCY_DIVISORS };
