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
const { SnapshotType, LifecycleStatus } = require('../constants/enums');

// ── Transition Lens ───────────────────────────────────────────────────────────

async function getTargetSummaryReport(clientId, filters = {}) {
  const query = { clientId, isDeleted: false };
  if (filters.lifecycle_status) query.lifecycle_status = filters.lifecycle_status;
  const targets = await TargetMaster.find(query);

  const results = await Promise.all(targets.map(async (t) => {
    const pathway = await PathwayAnnual.find({ target_id: t._id }).sort({ calendar_year: 1 });
    const latestProgress = await ProgressSnapshot.findOne({
      target_id:     t._id,
      snapshot_type: { $in: [SnapshotType.ANNUAL, SnapshotType.MONTHLY] },
    }).sort({ snapshot_date: -1 });

    return {
      target: t,
      pathway,
      latestProgress,
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
    const output = await OutputActivityRecord.findOne({
      target_id:    r.target_id,
      calendar_year:r.compliance_year,
    });
    const credits = await CreditLedger.find({ clientId, residual_position_id: null })
      .limit(10);
    return { record: r, output, credits };
  }));
}

// ── Source Accountability Report ─────────────────────────────────────────────

async function getSourceAccountabilityReport(clientId, targetId) {
  const allocations = await SourceAllocation.find({ clientId, target_id: targetId, isDeleted: false });
  return allocations;
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
  return ForecastSnapshot.find(query).sort({ forecast_date: -1 });
}

// ── Audit Evidence Package ────────────────────────────────────────────────────

async function getAuditEvidencePackage(clientId, targetId) {
  const [revisions, logs, attachments, target] = await Promise.all([
    TargetRevision.find({ target_id: targetId }).sort({ revision_no: -1 }),
    ApprovalWorkflowLog.find({
      clientId, entity_type: 'TargetMaster', entity_id: String(targetId),
    }).sort({ timestamp: -1 }),
    EvidenceAttachment.find({
      clientId, entity_type: 'TargetMaster', entity_id: String(targetId),
    }).sort({ uploaded_at: -1 }),
    TargetMaster.findById(targetId),
  ]);
  return { target, revisions, logs, attachments };
}

module.exports = {
  getTargetSummaryReport,
  getComplianceYearReport,
  getSourceAccountabilityReport,
  getInitiativeReductionReport,
  getForecastRiskReport,
  getAuditEvidencePackage,
};
