'use strict';

const ComplianceYearRegister = require('../models/ComplianceYearRegister');
const ApprovalWorkflowLog = require('../models/ApprovalWorkflowLog');
const TargetMaster = require('../models/TargetMaster');
const { assertCanClose } = require('../validators/complianceValidator');
const {
  ComplianceStatus, TargetFamily, ApprovableEntityType,
  WorkflowEventType, RecalculationTrigger,
} = require('../constants/enums');
const { ERRORS } = require('../constants/messages');
const recalcService = require('./recalculationService');

async function createComplianceYear(data, user) {
  const target = await TargetMaster.findById(data.target_id);
  if (!target) { const e = new Error('Target not found.'); e.status = 404; throw e; }
  if (target.target_family !== TargetFamily.Regulatory_Compliance_Target) {
    const e = new Error('Compliance years can only be created for Regulatory Compliance targets.');
    e.status = 422; throw e;
  }
  if (!data.compliance_year) { const e = new Error('compliance_year is required.'); e.status = 422; throw e; }

  const record = await ComplianceYearRegister.create({
    ...data,
    clientId:        target.clientId,
    target_gei:      target.target_intensity_value,
    closure_status:  ComplianceStatus.OPEN,
    created_by:      user._id,
  });
  return record;
}

/**
 * Computes GEI metrics and freezes the compliance year.
 */
async function closeComplianceYear(recordId, user) {
  const record = await ComplianceYearRegister.findById(recordId);
  if (!record) { const e = new Error('Compliance year record not found.'); e.status = 404; throw e; }

  const errors = await assertCanClose(record);
  if (errors.length) { const e = new Error(errors.join(' | ')); e.status = 422; throw e; }

  // Compute GEI metrics
  const achieved_gei  = record.actual_emissions / record.output_value;
  const gap           = (achieved_gei - record.target_gei) * record.output_value;
  const credit_need   = Math.max(0, gap);
  const credit_surplus= Math.max(0, -gap);

  record.achieved_gei   = achieved_gei;
  record.gap            = gap;
  record.credit_need    = credit_need;
  record.credit_surplus = credit_surplus;
  record.closure_status = ComplianceStatus.CLOSED;
  record.closed_by      = user._id;
  record.closed_at      = new Date();
  await record.save();

  await ApprovalWorkflowLog.create({
    clientId:      record.clientId,
    entity_type:   ApprovableEntityType.ComplianceYearRegister,
    entity_id:     String(record._id),
    action_code:   WorkflowEventType.APPROVED,
    actor_id:      user._id,
    actor_role:    user.userType,
    status_before: ComplianceStatus.OPEN,
    status_after:  ComplianceStatus.CLOSED,
    timestamp:     new Date(),
  });
  return record;
}

/**
 * Reopens a closed compliance year — creates a RecalculationEvent.
 */
async function reopenComplianceYear(recordId, justification, user) {
  const record = await ComplianceYearRegister.findById(recordId);
  if (!record) { const e = new Error('Compliance year record not found.'); e.status = 404; throw e; }
  if (record.closure_status !== ComplianceStatus.CLOSED) {
    const e = new Error('Only CLOSED compliance years can be reopened.'); e.status = 422; throw e;
  }

  // Create governed recalculation event
  await recalcService.createRecalcEvent({
    clientId:     record.clientId,
    target_id:    record.target_id,
    trigger_type: RecalculationTrigger.Compliance_Year_Reopen,
    justification,
  }, user);

  record.closure_status = ComplianceStatus.REOPENED;
  await record.save();

  await ApprovalWorkflowLog.create({
    clientId:      record.clientId,
    entity_type:   ApprovableEntityType.ComplianceYearRegister,
    entity_id:     String(record._id),
    action_code:   WorkflowEventType.RECALCULATION_INITIATED,
    actor_id:      user._id,
    actor_role:    user.userType,
    status_before: ComplianceStatus.CLOSED,
    status_after:  ComplianceStatus.REOPENED,
    timestamp:     new Date(),
  });
  return record;
}

async function listComplianceYears(clientId, targetId) {
  const query = { clientId };
  if (targetId) query.target_id = targetId;
  return ComplianceYearRegister.find(query).sort({ compliance_year: -1 });
}

async function getComplianceYearById(recordId) {
  const record = await ComplianceYearRegister.findById(recordId);
  if (!record) { const e = new Error('Compliance year record not found.'); e.status = 404; throw e; }
  return record;
}

module.exports = {
  createComplianceYear,
  closeComplianceYear,
  reopenComplianceYear,
  listComplianceYears,
  getComplianceYearById,
};
