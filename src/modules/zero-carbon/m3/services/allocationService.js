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

/** Auto-generate source_code: {clientId}_ALLOC_{zero-padded-serial} */
async function generateSourceCode(clientId) {
  const count = await SourceAllocation.countDocuments({ clientId, isDeleted: false });
  return `${clientId}_ALLOC_${String(count + 1).padStart(4, '0')}`;
}

/** Strip keys whose value is undefined so Object.assign never wipes existing fields */
function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

async function createAllocation(targetId, data, user) {
  const source_code = data.source_code || (await generateSourceCode(data.clientId));
  const payload = normalizeAllocationPayload({ ...data, source_code });

  const errors = validateAllocationRow(payload);
  if (errors.length) { const e = new Error(errors.join(' | ')); e.status = 422; throw e; }

  const alloc = await SourceAllocation.create({
    ...payload,
    target_id:             targetId,
    clientId:              data.clientId,
    reconciliation_status: AllocationStatus.DRAFT,
    version:               1,
    created_by:            user._id,
    updated_by:            user._id,
  });

  await ApprovalWorkflowLog.create(logEntry(alloc, WorkflowEventType.CREATED, user, null, AllocationStatus.DRAFT));
  return alloc;
}

async function updateAllocation(allocationId, data, user) {
  const alloc = await SourceAllocation.findById(allocationId);
  if (!alloc || alloc.isDeleted) { const e = new Error('Allocation not found.'); e.status = 404; throw e; }
  if (alloc.reconciliation_status !== AllocationStatus.DRAFT) {
    const e = new Error('Only DRAFT allocations can be updated.'); e.status = 422; throw e;
  }
  if (data.version !== undefined && alloc.version !== data.version) {
    const e = new Error(ERRORS.OPTIMISTIC_CONCURRENCY); e.status = 409; throw e;
  }

  // Normalize but never overwrite source_code from the immutable existing value
  const normalized = normalizeAllocationPayload(data);
  delete normalized.source_code;  // source_code is set once at create, never changed
  const safePayload = stripUndefined(normalized);

  Object.assign(alloc, safePayload, {
    version:    alloc.version + 1,
    updated_by: user._id,
  });
  await alloc.save();

  return alloc;
}

/**
 * Bulk upsert — create or update all rows in one call.
 */
async function bulkUpsertAllocations(targetId, clientId, rows, chartType, chartId, user) {
  const results = [];
  const errors  = [];

  for (const row of rows) {
    try {
      const existing = await SourceAllocation.findOne({
        target_id:       targetId,
        nodeId:          row.nodeId,
        scopeIdentifier: row.scopeIdentifier,
        chartType,
        isDeleted:       false,
      });

      let saved;
      if (!existing) {
        saved = await createAllocation(targetId, { ...row, clientId, chartType, chartId }, user);
      } else if (existing.reconciliation_status === AllocationStatus.DRAFT) {
        saved = await updateAllocation(String(existing._id), { ...row, version: existing.version }, user);
      } else {
        saved = existing;
      }
      results.push(saved);
    } catch (e) {
      errors.push({ nodeId: row.nodeId, scopeIdentifier: row.scopeIdentifier, message: e.message });
    }
  }

  return { saved: results, errors };
}

async function submitAllocation(allocationId, user) {
  const alloc = await SourceAllocation.findById(allocationId);
  if (!alloc) { const e = new Error('Allocation not found.'); e.status = 404; throw e; }
  if (alloc.reconciliation_status !== AllocationStatus.DRAFT) {
    const e = new Error('Only DRAFT allocations can be submitted.'); e.status = 422; throw e;
  }

  const siblings = await SourceAllocation.find({
    target_id:       alloc.target_id,
    chartType:       alloc.chartType,
    scopeIdentifier: alloc.scopeIdentifier,
    isDeleted:       false,
  });

  const settings  = await OrgSettings.findOne({ clientId: alloc.clientId });
  const tolerance = settings?.allocation_tolerance_pct ?? 0.005;
  const pcts      = siblings.map(s => s.allocated_pct);

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

  // Budget derivation runs in the background — response does not depend on it
  pathwayService.getPathway(String(alloc.target_id))
    .then(rows => rows.length && pathwayService.deriveOperationalBudgets(String(alloc.target_id), alloc.clientId, rows))
    .catch(e => console.error('[approveAllocation] budget derivation error:', e.message));

  return alloc;
}

async function approveAllAllocations(targetId, user) {
  const allocations = await SourceAllocation.find({
    target_id:             targetId,
    reconciliation_status: AllocationStatus.SUBMITTED,
    isDeleted:             false,
  }).lean();

  if (!allocations.length) {
    const e = new Error('No SUBMITTED allocations found for this target.'); e.status = 422; throw e;
  }

  const ids     = allocations.map(a => a._id);
  const clientId = allocations[0].clientId;

  // Update all statuses in one query
  await SourceAllocation.updateMany(
    { _id: { $in: ids } },
    { $set: { reconciliation_status: AllocationStatus.APPROVED, updated_by: user._id } }
  );

  // Batch-insert workflow logs
  await ApprovalWorkflowLog.insertMany(
    allocations.map(alloc => logEntry(alloc, WorkflowEventType.APPROVED, user, AllocationStatus.SUBMITTED, AllocationStatus.APPROVED))
  );

  // Derive budgets once for the target in the background
  pathwayService.getPathway(targetId)
    .then(rows => rows.length && pathwayService.deriveOperationalBudgets(targetId, clientId, rows))
    .catch(e => console.error('[approveAllAllocations] budget derivation error:', e.message));

  return { approved: allocations.length, ids };
}

async function deleteAllocation(allocationId, user) {
  const alloc = await SourceAllocation.findById(allocationId);
  if (!alloc || alloc.isDeleted) { const e = new Error('Allocation not found.'); e.status = 404; throw e; }
  if (alloc.reconciliation_status !== AllocationStatus.DRAFT) {
    const e = new Error('Only DRAFT allocations can be deleted.'); e.status = 422; throw e;
  }
  alloc.isDeleted = true;
  alloc.updated_by = user._id;
  await alloc.save();
  return { deleted: true, id: allocationId };
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
  bulkUpsertAllocations,
  submitAllocation,
  approveAllocation,
  approveAllAllocations,
  deleteAllocation,
  listAllocations,
  getAllocationById,
};
