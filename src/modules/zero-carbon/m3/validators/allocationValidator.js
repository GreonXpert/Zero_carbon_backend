'use strict';

const { ERRORS } = require('../constants/messages');

/**
 * Validates that the sum of allocated_pct across all allocations for a target
 * is within the configured tolerance of 100%.
 *
 * @param {number[]} pctArray   - Array of allocated_pct values
 * @param {number}   tolerance  - e.g. 0.005 (= 0.5%)
 * @returns {{ valid: boolean, sum: number, message: string|null }}
 */
function validateAllocationSum(pctArray, tolerance = 0.005) {
  const sum = pctArray.reduce((acc, v) => acc + (v || 0), 0);
  const lower = 100 - tolerance * 100;
  const upper = 100 + tolerance * 100;
  if (sum < lower || sum > upper) {
    return {
      valid: false,
      sum,
      message: ERRORS.ALLOCATION_SUM_TOLERANCE(sum.toFixed(2), tolerance),
    };
  }
  return { valid: true, sum, message: null };
}

/**
 * Validates individual allocation row fields.
 */
function validateAllocationRow(data) {
  const errors = [];
  if (!data.source_code) errors.push('source_code is required.');
  if (!data.category_code) errors.push('category_code is required.');
  if (!data.facility_id) errors.push('facility_id is required.');
  if (data.allocated_pct == null || data.allocated_pct < 0 || data.allocated_pct > 100) {
    errors.push('allocated_pct must be between 0 and 100.');
  }
  return errors;
}

module.exports = { validateAllocationSum, validateAllocationRow };
