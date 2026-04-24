'use strict';

const SourceAllocation = require('../models/SourceAllocation');
const ApprovalWorkflowLog = require('../models/ApprovalWorkflowLog');
const OrgSettings = require('../models/OrgSettings');
const { validateAllocationRow, validateAllocationSum } = require('../validators/allocationValidator');
const { AllocationStatus, ApprovableEntityType, WorkflowEventType } = require('../constants/enums');
const { ERRORS } = require('../constants/messages');
const pathwayService = require('./pathwayService');
const { normalizeAllocationPayload } = require('../utils/allocationMapper');

function logEntry(alloc, action, actor, before, after, comment = null) {
  return {
    clientId:      alloc.clientId,
    entity_type:   ApprovableEntityType.SourceAllocation,
    entity_id:     String(alloc._id),
    action_code:   action,
    actor_id:      actor._id,
    actor_role:    actor.userType,
    status_before: before,
    status_after:  after,
    comment,
    timestamp:     new Date(),
  };
}
// function normalizeAllocationPayload(data) {
//   const scopeDetailAllocationPct =
//     data.scopeDetailAllocationPct ??
//     data.allocated_pct ??
//     100;

//   return {
//     ...data,

//     // backward-compatible value used by existing reconciliation logic
//     allocated_pct: Number(data.allocated_pct ?? scopeDetailAllocationPct),

//     scopeAllocationPct: Number(data.scopeAllocationPct ?? 100),
//     categoryAllocationPct: Number(data.categoryAllocationPct ?? 100),
//     nodeAllocationPct: Number(data.nodeAllocationPct ?? 100),
//     scopeDetailAllocationPct: Number(scopeDetailAllocationPct),

//     absoluteAllocatedValue: Number(data.absoluteAllocatedValue ?? 0),

//     // optional backward-compatible mapping
//     source_code: data.source_code || data.scopeIdentifier || data.nodeId,
//     category_code: data.category_code || data.categoryName || 'UNCATEGORIZED',
//     facility_id: data.facility_id || data.nodeId,
//   };
// }

async function createAllocation(targetId, data, user) {

  const payload = normalizeAllocationPayload(data);

  const errors = validateAllocationRow(data);
  if (errors.length) { const e = new Error(errors.join(' | ')); e.status = 422; throw e; }

  const alloc = await SourceAllocation.create({
    ...payload,
    target_id:              targetId,
    clientId:               data.clientId,
    reconciliation_status:  AllocationStatus.DRAFT,
    version:                1,
    created_by:             user._id,
    updated_by:             user._id,
  });

  await ApprovalWorkflowLog.create(logEntry(alloc, WorkflowEventType.CREATED, user, null, AllocationStatus.DRAFT));
  return alloc;
}

async function updateAllocation(allocationId, data, user) {
  const payload = normalizeAllocationPayload(data);
  const alloc = await SourceAllocation.findById(allocationId);
  if (!alloc || alloc.isDeleted) { const e = new Error('Allocation not found.'); e.status = 404; throw e; }
  if (alloc.reconciliation_status !== AllocationStatus.DRAFT) {
    const e = new Error('Only DRAFT allocations can be updated.'); e.status = 422; throw e;
  }
  if (data.version !== undefined && alloc.version !== data.version) {
    const e = new Error(ERRORS.OPTIMISTIC_CONCURRENCY); e.status = 409; throw e;
  }

Object.assign(alloc, payload, {
  version: alloc.version + 1,
  updated_by: user._id,
});
  await alloc.save();
  return alloc;
}

async function submitAllocation(allocationId, user) {
  const alloc = await SourceAllocation.findById(allocationId);
  if (!alloc) { const e = new Error('Allocation not found.'); e.status = 404; throw e; }
  if (alloc.reconciliation_status !== AllocationStatus.DRAFT) {
    const e = new Error('Only DRAFT allocations can be submitted.'); e.status = 422; throw e;
  }

  // Reconciliation check
  const siblings = await SourceAllocation.find({
  target_id: alloc.target_id,
  chartType: alloc.chartType,
  scopeIdentifier: alloc.scopeIdentifier,
  isDeleted: false,
});
  const settings = await OrgSettings.findOne({ clientId: alloc.clientId });
  const tolerance = settings?.allocation_tolerance_pct ?? 0.005;
  const pcts = siblings.map(s => s.allocated_pct);
  const check = validateAllocationSum(pcts, tolerance);
  if (!check.valid) {
    alloc.reconciliation_status = AllocationStatus.DRAFT;
    await alloc.save();
    const e = new Error(check.message); e.status = 422; throw e;
  }

  const prev = alloc.reconciliation_status;
  alloc.reconciliation_status = AllocationStatus.SUBMITTED;
  alloc.updated_by = user._id;
  await alloc.save();

  await ApprovalWorkflowLog.create(logEntry(alloc, WorkflowEventType.SUBMITTED, user, prev, AllocationStatus.SUBMITTED));
  return alloc;
}

async function approveAllocation(allocationId, user) {
  const alloc = await SourceAllocation.findById(allocationId);
  if (!alloc) { const e = new Error('Allocation not found.'); e.status = 404; throw e; }
  if (alloc.reconciliation_status !== AllocationStatus.SUBMITTED) {
    const e = new Error('Only SUBMITTED allocations can be approved.'); e.status = 422; throw e;
  }

  const prev = alloc.reconciliation_status;
  alloc.reconciliation_status = AllocationStatus.APPROVED;
  alloc.updated_by = user._id;
  await alloc.save();

  await ApprovalWorkflowLog.create(logEntry(alloc, WorkflowEventType.APPROVED, user, prev, AllocationStatus.APPROVED));

  // Re-derive operational budgets after allocation approval
  const pathwayRows = await pathwayService.getPathway(String(alloc.target_id));
  if (pathwayRows.length) {
    await pathwayService.deriveOperationalBudgets(String(alloc.target_id), alloc.clientId, pathwayRows);
  }

  return alloc;
}

async function listAllocations(targetId) {
  return SourceAllocation.find({ target_id: targetId, isDeleted: false });
}

async function getAllocationById(allocationId) {
  const alloc = await SourceAllocation.findById(allocationId);
  if (!alloc || alloc.isDeleted) { const e = new Error('Allocation not found.'); e.status = 404; throw e; }
  return alloc;
}

module.exports = {
  createAllocation,
  updateAllocation,
  submitAllocation,
  approveAllocation,
  listAllocations,
  getAllocationById,
};
