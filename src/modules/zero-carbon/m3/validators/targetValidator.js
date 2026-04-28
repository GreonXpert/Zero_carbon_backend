'use strict';

const {
  FRAMEWORK_FAMILY_GATE,
  FRAMEWORK_METHOD_GATE,
  INTENSITY_METHODS,
  REDUCTION_PCT_METHODS,
  PCT_TARGET_METHODS,
  MethodName,
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
    effective_from,
    effective_to,
    // RE Tracking
    target_re_pct,
    // Supplier Engagement
    target_supplier_engagement_pct,
    // SDA
    sda_sector,
  } = data;

  // ── Framework ↔ TargetFamily gating ────────────────────────────────────────
  if (framework_name && target_family) {
    const allowed = FRAMEWORK_FAMILY_GATE[framework_name] || [];
    if (!allowed.includes(target_family)) errors.push(ERRORS.INVALID_FRAMEWORK_FAMILY);
  }

  // ── Framework ↔ Method gating ───────────────────────────────────────────────
  if (framework_name && method_name) {
    const allowed = FRAMEWORK_METHOD_GATE[framework_name] || [];
    if (!allowed.includes(method_name)) errors.push(ERRORS.INVALID_FRAMEWORK_METHOD);
  }

  // ── Year ordering ───────────────────────────────────────────────────────────
  if (base_year && target_year && target_year <= base_year) errors.push(ERRORS.TARGET_YEAR_PAST);

  if (interim_years?.length > 0 && base_year && target_year) {
    const sorted = [...interim_years].sort((a, b) => a - b);
    const valid = sorted.every((y, i) =>
      y > base_year && y < target_year && (i === 0 || y > sorted[i - 1])
    );
    if (!valid) errors.push(ERRORS.INTERIM_YEARS_INVALID);
  }

  // ── Scope 3 coverage ───────────────────────────────────────────────────────
  if (scope_boundary && [ScopeBoundary.S1S2S3, ScopeBoundary.S3].includes(scope_boundary)) {
    if (scope3_coverage_pct == null) errors.push(ERRORS.SCOPE3_COVERAGE_REQUIRED);
  }

  // ── Method-specific required fields ────────────────────────────────────────

  // Absolute Contraction / FLAG / Internal Custom → target_reduction_pct
  if (method_name && REDUCTION_PCT_METHODS.has(method_name)) {
    if (target_reduction_pct == null) errors.push(ERRORS.REDUCTION_PCT_REQUIRED);
  }

  // SDA / Regulatory GEI → denominator_unit + target_intensity_value
  if (method_name && INTENSITY_METHODS.has(method_name)) {
    if (!denominator_unit) errors.push(ERRORS.DENOMINATOR_REQUIRED);
    if (data.target_intensity_value == null) {
      errors.push('target_intensity_value is required for intensity-based methods.');
    }
  }

  // SDA additionally requires a sector
  if (method_name === MethodName.SDA && !sda_sector) {
    errors.push('sda_sector is required for the SDA method.');
  }

  // RE Tracking → target_re_pct
  if (method_name === MethodName.RE_Tracking) {
    if (target_re_pct == null) errors.push('target_re_pct is required for RE Tracking.');
  }

  // Supplier Engagement → target_supplier_engagement_pct
  if (method_name === MethodName.Supplier_Engagement_Tracking) {
    if (target_supplier_engagement_pct == null) {
      errors.push('target_supplier_engagement_pct is required for Supplier Engagement Tracking.');
    }
  }

  // Effective date ordering
  if (effective_from && effective_to) {
    const from = new Date(effective_from);
    const to   = new Date(effective_to);
    if (!isNaN(from) && !isNaN(to) && from > to) errors.push(ERRORS.EFFECTIVE_DATE_INVALID);
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
