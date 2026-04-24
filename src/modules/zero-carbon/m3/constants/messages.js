'use strict';

// ============================================================================
// M3 Net Zero — Locked Error / Warning / Blocker Messages
// Source: Net_Zero_Developer_Guide_Enterprise §18
// ============================================================================

const ERRORS = Object.freeze({
  BASE_YEAR_NOT_APPROVED:
    'Base year emissions not approved. Submit inventory closure in M1 first.',

  TARGET_YEAR_PAST:
    'Target year cannot be in the past.',

  ALLOCATION_SUM_TOLERANCE: (actual, tolerance) =>
    `Sum of allocations (${actual}%) outside tolerance (100% ± ${tolerance * 100}%). Reconcile before submit.`,

  OUTPUT_DATA_REQUIRED:
    'Output data required for GEI calculation. Provide OutputActivityRecord or upload manual entry.',

  VALIDATION_EVIDENCE_REQUIRED:
    'Cannot publish SBTi Validated target without validation evidence.',

  CONSULTANT_CANNOT_APPROVE:
    'Permission denied: Consultant cannot approve targets.',

  EDIT_LOCKED_RECALC:
    'Target is edit-locked while a recalculation is pending. Approve or reject the recalculation event first.',

  INVALID_FRAMEWORK_FAMILY:
    'The selected target family is not permitted for the chosen framework.',

  INVALID_FRAMEWORK_METHOD:
    'The selected method is not permitted for the chosen framework.',

  INTERIM_YEARS_INVALID:
    'Interim years must be strictly between base year and target year in ascending order.',

  SCOPE3_COVERAGE_REQUIRED:
    'Scope 3 coverage percentage is required when Scope 3 is included in the boundary.',

  REDUCTION_PCT_REQUIRED:
    'Target reduction percentage is required for Absolute Contraction method.',

  DENOMINATOR_REQUIRED:
    'Denominator (output activity) is required for intensity-based methods (SDA / Regulatory GEI).',

  TARGET_CODE_DUPLICATE:
    'A target with this code already exists for this organisation.',

  OPTIMISTIC_CONCURRENCY:
    'The record has been modified by another process. Please reload and retry.',

  COMPLIANCE_YEAR_CLOSED:
    'This compliance year is closed. Fields cannot be modified.',

  COMPLIANCE_YEAR_BLOCKER:
    'Compliance year cannot close while blockers exist. Remediate or override.',

  OPERATIONAL_BUDGET_MANUAL_WRITE:
    'Operational budgets are system-derived only. Manual writes are not permitted.',

  TEAM_USER_NO_ALLOCATION:
    'Team User cannot draft allocations.',

  READ_ONLY_ROLE:
    'Read-only access for your role.',

  CREDIT_PURPOSE_INVALID:
    'PATHWAY_COMPLIANCE is not a valid credit purpose.',

  RECALC_OTHER_REQUIRES_JUSTIFICATION:
    'A justification is required when trigger type is Other.',

  SBTI_VALIDATED_PUBLISH_REQUIRES_CERT:
    'Cannot publish SBTi Validated target without a validation certificate attachment.',

  BASE_YEAR_EMISSIONS_REQUIRED_PUBLISH:
    'Base year emissions must be set before a target can be published.',

  RETURN_COMMENT_REQUIRED:
    'A comment is required when returning a target for revision.',

  REJECT_COMMENT_REQUIRED:
    'A comment is required when rejecting a recalculation event.',

  EFFECTIVE_DATE_INVALID:
    'effective_from must not be later than effective_to.',
});

const WARNINGS = Object.freeze({
  SCOPE3_COVERAGE_LOW: (actual, threshold) =>
    `Scope 3 coverage (${actual}%) below threshold (${threshold}%). Review boundary definition.`,

  STALE_LIVE_DATA:
    'Live data stale >1 business day. Forecast may be inaccurate.',

  SEASONALITY_FALLBACK:
    "Seasonality profile 'M1_HISTORICAL' requires ≥1 complete prior year. Falling back to EQUAL.",

  FRAMEWORK_VERSION_OUTDATED: (newVersion) =>
    `Framework version outdated. Consider upgrade to ${newVersion}.`,

  FORECAST_AT_RISK:
    'At-risk forecast: projected emissions exceed allowed by 5%+. Review initiatives or reset targets.',
});

const BLOCKERS = Object.freeze({
  COMPLIANCE_YEAR_HAS_BLOCKERS:
    'Compliance year cannot close while blockers exist. Remediate or override.',
});

module.exports = { ERRORS, WARNINGS, BLOCKERS };
