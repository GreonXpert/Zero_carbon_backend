'use strict';

// ============================================================================
// M3 Net Zero — All Enums and Status Constants
// Source: Net_Zero_Developer_Guide_Enterprise §11
// ============================================================================

const TargetFamily = Object.freeze({
  SBTi_Modeled:                'SBTi_Modeled',
  SBTi_Validated:              'SBTi_Validated',
  Internal_Management_Target:  'Internal_Management_Target',
  Regulatory_Compliance_Target:'Regulatory_Compliance_Target',
  Residual_Neutrality_Target:  'Residual_Neutrality_Target',
});

const FrameworkName = Object.freeze({
  SBTI:             'SBTI',
  ISO_14068:        'ISO_14068',
  ISO_NZG:          'ISO_NZG',
  REG_CCTS:         'REG_CCTS',
  INTERNAL_CUSTOM:  'INTERNAL_CUSTOM',
});

const MethodName = Object.freeze({
  Absolute_Contraction:        'Absolute_Contraction',
  SDA:                         'SDA',
  Regulatory_GEI:              'Regulatory_GEI',
  RE_Tracking:                 'RE_Tracking',
  Supplier_Engagement_Tracking:'Supplier_Engagement_Tracking',
  FLAG:                        'FLAG',
  Internal_Custom:             'Internal_Custom',
});

const LifecycleStatus = Object.freeze({
  DRAFT:            'DRAFT',
  ACTIVE:           'ACTIVE',
  SUPERSEDED:       'SUPERSEDED',
  ARCHIVED:         'ARCHIVED',
  RECALC_PENDING:   'RECALC_PENDING',
});

const ApprovalStatus = Object.freeze({
  SUBMITTED:              'SUBMITTED',
  UNDER_REVIEW:           'UNDER_REVIEW',
  RETURNED_FOR_REVISION:  'RETURNED_FOR_REVISION',
  APPROVED:               'APPROVED',
  PUBLISHED:              'PUBLISHED',
});

// Backward-looking only
const ProgressStatus = Object.freeze({
  On_Track:        'On_Track',
  Off_Track:       'Off_Track',
  Ahead_of_Target: 'Ahead_of_Target',
});

// Forward-looking only — separate from ProgressStatus
const ForecastStatus = Object.freeze({
  On_Track: 'On_Track',
  At_Risk:  'At_Risk',
  Off_Track: 'Off_Track',
});

const ComplianceStatus = Object.freeze({
  OPEN:     'OPEN',
  CLOSED:   'CLOSED',
  REOPENED: 'REOPENED',
});

const RecalculationTrigger = Object.freeze({
  Framework_Version_Upgrade:         'Framework_Version_Upgrade',
  Method_Parameter_Change:           'Method_Parameter_Change',
  Data_Restatement:                  'Data_Restatement',
  Scope_Boundary_Change:             'Scope_Boundary_Change',
  Baseline_Recalculation:            'Baseline_Recalculation',
  Allocation_Reconciliation_Failure: 'Allocation_Reconciliation_Failure',
  Compliance_Year_Reopen:            'Compliance_Year_Reopen',
  Initiative_Data_Change:            'Initiative_Data_Change',
  Other:                             'Other',
});

const SnapshotType = Object.freeze({
  ANNUAL:    'ANNUAL',
  MONTHLY:   'MONTHLY',
  QUARTERLY: 'QUARTERLY',
  DAILY:     'DAILY',
  LIVE:      'LIVE',
});

const AllocationStatus = Object.freeze({
  DRAFT:     'DRAFT',
  SUBMITTED: 'SUBMITTED',
  APPROVED:  'APPROVED',
  ACTIVE:    'ACTIVE',
});

const BudgetGranularity = Object.freeze({
  ANNUAL:    'ANNUAL',
  QUARTERLY: 'QUARTERLY',
  MONTHLY:   'MONTHLY',
  DAILY:     'DAILY',
});

const SeasonalityMethod = Object.freeze({
  EQUAL:          'EQUAL',
  M1_HISTORICAL:  'M1_HISTORICAL',
  CUSTOM_CURVE:   'CUSTOM_CURVE',
});

const DQFlagCode = Object.freeze({
  MISSING_BASE_YEAR:               'MISSING_BASE_YEAR',
  MISSING_OUTPUT_DATA:             'MISSING_OUTPUT_DATA',
  INCOMPLETE_ALLOCATION:           'INCOMPLETE_ALLOCATION',
  STALE_LIVE_DATA:                 'STALE_LIVE_DATA',
  SCOPE3_COVERAGE_BELOW_THRESHOLD: 'SCOPE3_COVERAGE_BELOW_THRESHOLD',
  FORECAST_DATA_UNAVAILABLE:       'FORECAST_DATA_UNAVAILABLE',
  EVIDENCE_MISSING:                'EVIDENCE_MISSING',
});

const Severity = Object.freeze({
  INFO:    'INFO',
  WARNING: 'WARNING',
  BLOCKER: 'BLOCKER',
});

const WorkflowEventType = Object.freeze({
  CREATED:                   'CREATED',
  SUBMITTED:                 'SUBMITTED',
  REVIEWED:                  'REVIEWED',
  RETURNED:                  'RETURNED',
  APPROVED:                  'APPROVED',
  PUBLISHED:                 'PUBLISHED',
  ACTIVATED:                 'ACTIVATED',
  RECALCULATION_INITIATED:   'RECALCULATION_INITIATED',
  RECALCULATION_APPROVED:    'RECALCULATION_APPROVED',
});

const ApprovableEntityType = Object.freeze({
  TargetMaster:            'TargetMaster',
  SourceAllocation:        'SourceAllocation',
  ComplianceYearRegister:  'ComplianceYearRegister',
  InitiativeAttribution:   'InitiativeAttribution',
  CreditLedger:            'CreditLedger',
  RecalculationEvent:      'RecalculationEvent',
});

const CreditPurpose = Object.freeze({
  VERIFIED_REMOVALS:  'VERIFIED_REMOVALS',
  PURCHASED_CREDITS:  'PURCHASED_CREDITS',
  INTERNAL_OFFSET:    'INTERNAL_OFFSET',
  // PATHWAY_COMPLIANCE is explicitly excluded per guide
});

const ApprovalDepth = Object.freeze({
  SINGLE_STEP: 'single_step',
  TWO_STEP:    'two_step',
});

const RecalcEventStatus = Object.freeze({
  PENDING:  'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
});

const SourceSystem = Object.freeze({
  M1:     'M1',
  MANUAL: 'Manual',
  ERP:    'ERP',
});

const ScopeBoundary = Object.freeze({
  S1:     'S1',
  S1S2:   'S1S2',
  S1S2S3: 'S1S2S3',
  S3:     'S3',
});

// ── Enterprise guide — new enums ─────────────────────────────────────────────

const MetricType = Object.freeze({
  ABSOLUTE_EMISSIONS:        'ABSOLUTE_EMISSIONS',
  GEI_INTENSITY:             'GEI_INTENSITY',
  PHYSICAL_INTENSITY:        'PHYSICAL_INTENSITY',
  RENEWABLE_ELECTRICITY_PCT: 'RENEWABLE_ELECTRICITY_PCT',
  SUPPLIER_ENGAGEMENT_PCT:   'SUPPLIER_ENGAGEMENT_PCT',
  FLAG_METRIC:               'FLAG_METRIC',
  RESIDUAL_EMISSIONS:        'RESIDUAL_EMISSIONS',
  NEUTRALIZATION_REQUIREMENT:'NEUTRALIZATION_REQUIREMENT',
});

const OrgBoundaryBasis = Object.freeze({
  OPERATIONAL_CONTROL: 'OPERATIONAL_CONTROL',
  FINANCIAL_CONTROL:   'FINANCIAL_CONTROL',
  EQUITY_SHARE:        'EQUITY_SHARE',
});

const TargetBoundaryLevel = Object.freeze({
  ORGANIZATION:  'ORGANIZATION',
  BUSINESS_UNIT: 'BUSINESS_UNIT',
  FACILITY:      'FACILITY',
  SOURCE:        'SOURCE',
});

const CreditStatus = Object.freeze({
  ACTIVE:          'ACTIVE',
  HELD:            'HELD',
  CANCELLED:       'CANCELLED',
  TRANSFERRED_OUT: 'TRANSFERRED_OUT',
  RETIRED:         'RETIRED',
});

const ForecastMethod = Object.freeze({
  LINEAR_EXTRAPOLATION:  'LINEAR_EXTRAPOLATION',
  YTD_ANNUALIZED:        'YTD_ANNUALIZED',
  WEIGHTED_TRAILING_90D: 'WEIGHTED_TRAILING_90D',
  CUSTOM:                'CUSTOM',
});

const ComplianceObligationType = Object.freeze({
  REPORTING:     'REPORTING',
  CAP_AND_TRADE: 'CAP_AND_TRADE',
  CARBON_TAX:    'CARBON_TAX',
  PERMIT_BASED:  'PERMIT_BASED',
});

const MeasurementBasis = Object.freeze({
  DIRECT_MEASUREMENT: 'DIRECT_MEASUREMENT',
  CALCULATION:        'CALCULATION',
  ESTIMATION:         'ESTIMATION',
  M2_VERIFIED:        'M2_VERIFIED',
});

// ── Framework ↔ TargetFamily gating matrix ──────────────────────────────────
const FRAMEWORK_FAMILY_GATE = Object.freeze({
  [FrameworkName.SBTI]: [
    TargetFamily.SBTi_Modeled,
    TargetFamily.SBTi_Validated,
  ],
  [FrameworkName.ISO_14068]: [
    TargetFamily.Residual_Neutrality_Target,
  ],
  [FrameworkName.ISO_NZG]: [
    TargetFamily.SBTi_Modeled,
    TargetFamily.Internal_Management_Target,
  ],
  [FrameworkName.REG_CCTS]: [
    TargetFamily.Regulatory_Compliance_Target,
  ],
  [FrameworkName.INTERNAL_CUSTOM]: [
    TargetFamily.Internal_Management_Target,
  ],
});

// ── Framework ↔ Method gating matrix ────────────────────────────────────────
const FRAMEWORK_METHOD_GATE = Object.freeze({
  [FrameworkName.SBTI]: [
    MethodName.Absolute_Contraction,
    MethodName.SDA,
    MethodName.RE_Tracking,
    MethodName.Supplier_Engagement_Tracking,
    MethodName.FLAG,
  ],
  [FrameworkName.ISO_14068]: [
    MethodName.Absolute_Contraction,
    MethodName.Internal_Custom,
  ],
  [FrameworkName.ISO_NZG]: [
    MethodName.Absolute_Contraction,
    MethodName.Internal_Custom,
  ],
  [FrameworkName.REG_CCTS]: [
    MethodName.Regulatory_GEI,
  ],
  [FrameworkName.INTERNAL_CUSTOM]: [
    MethodName.Absolute_Contraction,
    MethodName.Internal_Custom,
  ],
});

// ── Intensity-based methods (require denominator) ───────────────────────────
const INTENSITY_METHODS = new Set([
  MethodName.SDA,
  MethodName.Regulatory_GEI,
]);

// ── Methods requiring target_reduction_pct ──────────────────────────────────
const REDUCTION_PCT_METHODS = new Set([
  MethodName.Absolute_Contraction,
]);

module.exports = {
  TargetFamily,
  FrameworkName,
  MethodName,
  LifecycleStatus,
  ApprovalStatus,
  ProgressStatus,
  ForecastStatus,
  ComplianceStatus,
  RecalculationTrigger,
  SnapshotType,
  AllocationStatus,
  BudgetGranularity,
  SeasonalityMethod,
  DQFlagCode,
  Severity,
  WorkflowEventType,
  ApprovableEntityType,
  CreditPurpose,
  ApprovalDepth,
  RecalcEventStatus,
  SourceSystem,
  ScopeBoundary,
  MetricType,
  OrgBoundaryBasis,
  TargetBoundaryLevel,
  CreditStatus,
  ForecastMethod,
  ComplianceObligationType,
  MeasurementBasis,
  FRAMEWORK_FAMILY_GATE,
  FRAMEWORK_METHOD_GATE,
  INTENSITY_METHODS,
  REDUCTION_PCT_METHODS,
};
