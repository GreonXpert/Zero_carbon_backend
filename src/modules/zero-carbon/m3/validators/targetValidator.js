'use strict';

const {
  FRAMEWORK_FAMILY_GATE,
  FRAMEWORK_METHOD_GATE,
  INTENSITY_METHODS,
  REDUCTION_PCT_METHODS,
  ScopeBoundary,
} = require('../constants/enums');
const { ERRORS } = require('../constants/messages');

/**
 * Validates the payload for creating or updating a TargetMaster.
 * Returns an array of error strings (empty = valid).
 */
function validateTargetPayload(data) {
  const errors = [];

  const {
    target_family,
    framework_name,
    method_name,
    base_year,
    target_year,
    interim_years = [],
    scope_boundary,
    scope3_coverage_pct,
    target_reduction_pct,
    denominator_unit,
  } = data;

  // Framework ↔ TargetFamily gating
  if (framework_name && target_family) {
    const allowed = FRAMEWORK_FAMILY_GATE[framework_name] || [];
    if (!allowed.includes(target_family)) {
      errors.push(ERRORS.INVALID_FRAMEWORK_FAMILY);
    }
  }

  // Framework ↔ Method gating
  if (framework_name && method_name) {
    const allowed = FRAMEWORK_METHOD_GATE[framework_name] || [];
    if (!allowed.includes(method_name)) {
      errors.push(ERRORS.INVALID_FRAMEWORK_METHOD);
    }
  }

  // Target year must be after base year
  if (base_year && target_year && target_year <= base_year) {
    errors.push(ERRORS.TARGET_YEAR_PAST);
  }

  // Interim years must be strictly between base_year and target_year, ascending
  if (interim_years && interim_years.length > 0 && base_year && target_year) {
    const sorted = [...interim_years].sort((a, b) => a - b);
    const valid = sorted.every((y, i) => {
      const withinBounds = y > base_year && y < target_year;
      const ascending = i === 0 || y > sorted[i - 1];
      return withinBounds && ascending;
    });
    if (!valid) errors.push(ERRORS.INTERIM_YEARS_INVALID);
  }

  // Scope 3 coverage required when S3 is in boundary
  if (scope_boundary && [ScopeBoundary.S1S2S3, ScopeBoundary.S3].includes(scope_boundary)) {
    if (scope3_coverage_pct == null) {
      errors.push(ERRORS.SCOPE3_COVERAGE_REQUIRED);
    }
  }

  // Absolute Contraction requires reduction_pct
  if (method_name && REDUCTION_PCT_METHODS.has(method_name)) {
    if (target_reduction_pct == null) {
      errors.push(ERRORS.REDUCTION_PCT_REQUIRED);
    }
  }

  // Intensity-based methods require denominator
  if (method_name && INTENSITY_METHODS.has(method_name)) {
    if (!denominator_unit) {
      errors.push(ERRORS.DENOMINATOR_REQUIRED);
    }
  }

  return errors;
}

/**
 * Validates optimistic concurrency — throws 409 if versions mismatch.
 */
function assertVersionMatch(stored, incoming) {
  if (incoming !== undefined && stored !== incoming) {
    const err = new Error(ERRORS.OPTIMISTIC_CONCURRENCY);
    err.status = 409;
    throw err;
  }
}

module.exports = { validateTargetPayload, assertVersionMatch };
