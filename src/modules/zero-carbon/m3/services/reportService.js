'use strict';

// ============================================================================
// Report Service — Read-only, lens-based read models
// Three-layer firewall enforced:
//   - Transition lens (TargetMaster + PathwayAnnual + Snapshots)
//   - Compliance lens (ComplianceYearRegister + OutputActivityRecord + CreditLedger)
//   - Residual lens (ResidualPosition + CreditLedger)
// Operational/live layers NEVER appear in formal external reports.
// Credits NEVER net into pathway gaps.
// ============================================================================

const TargetMaster = require('../models/TargetMaster');
const PathwayAnnual = require('../models/PathwayAnnual');
const SourceAllocation = require('../models/SourceAllocation');
const InitiativeAttribution = require('../models/InitiativeAttribution');
const ProgressSnapshot = require('../models/ProgressSnapshot');
const ForecastSnapshot = require('../models/ForecastSnapshot');
const ComplianceYearRegister = require('../models/ComplianceYearRegister');
const OutputActivityRecord = require('../models/OutputActivityRecord');
const CreditLedger = require('../models/CreditLedger');
const EvidenceAttachment = require('../models/EvidenceAttachment');
const ApprovalWorkflowLog = require('../models/ApprovalWorkflowLog');
const TargetRevision = require('../models/TargetRevision');
const ResidualPosition = require('../models/ResidualPosition');
const DataQualityFlag = require('../models/DataQualityFlag');
const { SnapshotType, LifecycleStatus, Severity } = require('../constants/enums');

// ── Transition Lens ───────────────────────────────────────────────────────────

async function getTargetSummaryReport(clientId, filters = {}) {
  const query = { clientId, isDeleted: false };
  if (filters.lifecycle_status) query.lifecycle_status = filters.lifecycle_status;
  const targets = await TargetMaster.find(query);

  const results = await Promise.all(targets.map(async (t) => {
    const [pathway, latestProgress, latestForecast, dqBlockers] = await Promise.all([
      PathwayAnnual.find({ target_id: t._id }).sort({ calendar_year: 1 }),
      ProgressSnapshot.findOne({
        target_id:     t._id,
        snapshot_type: { $in: [SnapshotType.ANNUAL, SnapshotType.MONTHLY] },
      }).sort({ snapshot_date: -1 }),
      ForecastSnapshot.findOne({ target_id: t._id }).sort({ forecast_date: -1 }),
      DataQualityFlag.countDocuments({
        entity_type: 'TargetMaster',
        entity_id:   String(t._id),
        severity:    Severity.BLOCKER,
        resolved:    false,
      }),
    ]);

    return {
      target:                 t,
      pathway,
      latestProgress,
      pathway_years_count:    pathway.length,
      latest_progress_status: latestProgress?.progress_status ?? null,
      latest_gap_pct:         latestProgress?.gap_pct ?? null,
      latest_forecast_status: latestForecast?.forecast_status ?? null,
      at_risk_indicator:      latestForecast?.at_risk_indicator ?? false,
      dq_blocker_count:       dqBlockers,
    };
  }));

  return results;
}

// ── Compliance Lens ──────────────────────────────────────────────────────────

async function getComplianceYearReport(clientId, filters = {}) {
  const query = { clientId };
  if (filters.target_id) query.target_id = filters.target_id;
  if (filters.compliance_year) query.compliance_year = filters.compliance_year;
  const records = await ComplianceYearRegister.find(query);

  return Promise.all(records.map(async (r) => {
    const [output, credits, outputRecordsCount, openDqFlags] = await Promise.all([
      OutputActivityRecord.findOne({
        target_id:     r.target_id,
        calendar_year: r.compliance_year,
      }),
      CreditLedger.find({ clientId, residual_position_id: null }).limit(10),
      OutputActivityRecord.countDocuments({ target_id: r.target_id }),
      DataQualityFlag.countDocuments({
        entity_type: 'ComplianceYearRegister',
        entity_id:   String(r._id),
        resolved:    false,
      }),
    ]);

    // Compute credit surplus / need vs allowed_emissions
    const totalCredits = credits.reduce((s, c) => s + (c.credit_amount || 0), 0);
    const allowed      = r.allowed_emissions ?? 0;
    const actual       = r.actual_emissions ?? 0;
    const gap          = actual - allowed;
    const creditSurplus = gap <= 0 ? Math.abs(gap) : 0;
    const creditNeed    = gap > 0  ? gap : 0;

    return {
      record: r,
      output,
      credits,
      credit_surplus:                creditSurplus,
      credit_need:                   creditNeed,
      output_activity_records_count: outputRecordsCount,
      open_dq_flags_count:           openDqFlags,
    };
  }));
}

// ── Source Accountability Report ─────────────────────────────────────────────

async function getSourceAccountabilityReport(clientId, targetId) {
  const allocations = await SourceAllocation.find({
    clientId,
    target_id: targetId,
    isDeleted: false,
  }).lean();

  return allocations.map(a => ({
    allocation_id: a._id,
    target_id: a.target_id,
    clientId: a.clientId,

    chartType: a.chartType,
    chartId: a.chartId,
    nodeId: a.nodeId,
    nodeLabel: a.nodeLabel,

    scopeIdentifier: a.scopeIdentifier,
    scopeType: a.scopeType,
    categoryName: a.categoryName,
    activity: a.activity,

    scopeAllocationPct: a.scopeAllocationPct,
    categoryAllocationPct: a.categoryAllocationPct,
    nodeAllocationPct: a.nodeAllocationPct,
    scopeDetailAllocationPct: a.scopeDetailAllocationPct,

    allocated_pct: a.allocated_pct,
    absoluteAllocatedValue: a.absoluteAllocatedValue,

    reconciliation_status: a.reconciliation_status,
    version: a.version,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  }));
}

// ── Initiative Reduction Impact Report ───────────────────────────────────────

async function getInitiativeReductionReport(clientId, targetId) {
  const query = { clientId, isDeleted: false };
  if (targetId) query.target_id = targetId;
  const attributions = await InitiativeAttribution.find(query);
  return attributions;
}

// ── Forecast Risk Report ──────────────────────────────────────────────────────

async function getForecastRiskReport(clientId, filters = {}) {
  const query = { clientId };
  if (filters.target_id) query.target_id = filters.target_id;
  const snapshots = await ForecastSnapshot.find(query).sort({ forecast_date: -1 });
  // Return snapshots with enterprise fields included (forecast_method, confidence_lower/upper are now on the model)
  return snapshots.map(s => ({
    ...s.toObject(),
    forecast_method:    s.forecast_method,
    confidence_lower:   s.confidence_lower,
    confidence_upper:   s.confidence_upper,
    basis_period_start: s.basis_period_start,
    basis_period_end:   s.basis_period_end,
  }));
}

// ── Audit Evidence Package ────────────────────────────────────────────────────

async function getAuditEvidencePackage(clientId, targetId) {
  const [revisions, logs, attachments, target, dqFlags, outputRecords] = await Promise.all([
    TargetRevision.find({ target_id: targetId }).sort({ revision_no: -1 }),
    ApprovalWorkflowLog.find({
      clientId, entity_type: 'TargetMaster', entity_id: String(targetId),
    }).sort({ timestamp: -1 }),
    EvidenceAttachment.find({
      clientId, entity_type: 'TargetMaster', entity_id: String(targetId),
    }).sort({ uploaded_at: -1 }),
    TargetMaster.findById(targetId),
    DataQualityFlag.find({
      entity_type: 'TargetMaster',
      entity_id:   String(targetId),
    }).sort({ created_at: -1 }),
    OutputActivityRecord.find({ target_id: targetId }).sort({ calendar_year: -1 }),
  ]);
  return { target, revisions, logs, attachments, dq_flags: dqFlags, output_records: outputRecords };
}

module.exports = {
  getTargetSummaryReport,
  getComplianceYearReport,
  getSourceAccountabilityReport,
  getInitiativeReductionReport,
  getForecastRiskReport,
  getAuditEvidencePackage,
};
