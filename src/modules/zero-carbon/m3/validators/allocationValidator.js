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
function isValidPct(value) {
  return value == null || (Number(value) >= 0 && Number(value) <= 100);
}

function validateAllocationRow(data) {
  const errors = [];

  if (!data.chartType) errors.push('chartType is required.');
  if (!['organizationFlowchart', 'processFlowchart'].includes(data.chartType)) {
    errors.push('chartType must be organizationFlowchart or processFlowchart.');
  }

  if (!data.nodeId) errors.push('nodeId is required.');
  if (!data.scopeIdentifier) errors.push('scopeIdentifier is required.');

  if (!isValidPct(data.scopeAllocationPct)) {
    errors.push('scopeAllocationPct must be between 0 and 100.');
  }

  if (!isValidPct(data.categoryAllocationPct)) {
    errors.push('categoryAllocationPct must be between 0 and 100.');
  }

  if (!isValidPct(data.nodeAllocationPct)) {
    errors.push('nodeAllocationPct must be between 0 and 100.');
  }

  if (!isValidPct(data.scopeDetailAllocationPct)) {
    errors.push('scopeDetailAllocationPct must be between 0 and 100.');
  }

  if (data.absoluteAllocatedValue != null && Number(data.absoluteAllocatedValue) < 0) {
    errors.push('absoluteAllocatedValue must be greater than or equal to 0.');
  }

  // backward compatibility
  if (data.allocated_pct == null && data.scopeDetailAllocationPct != null) {
    data.allocated_pct = data.scopeDetailAllocationPct;
  }

  if (data.allocated_pct == null || data.allocated_pct < 0 || data.allocated_pct > 100) {
    errors.push('allocated_pct must be between 0 and 100.');
  }

  return errors;
}

module.exports = { validateAllocationSum, validateAllocationRow };
