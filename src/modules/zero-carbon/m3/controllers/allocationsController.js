'use strict';

const allocationService = require('../services/allocationService');
const targetService = require('../services/targetService');
const { assertWriteAccess, assertCanApprove, assertCanDraftAllocation, resolveClientId } = require('../utils/m3Permission');

const ok  = (res, data, s = 200) => res.status(s).json({ success: true, data });
const err = (res, e) => res.status(e.status || 500).json({ success: false, message: e.message });

exports.createAllocation = async (req, res) => {
  try {
    const target = await targetService.getTargetById(req.params.targetId);
    await assertWriteAccess(req, target.clientId);
    assertCanDraftAllocation(req);
    const data = await allocationService.createAllocation(
      req.params.targetId,
      { ...req.body, clientId: target.clientId },
      req.user
    );
    ok(res, data, 201);
  } catch (e) { err(res, e); }
};

exports.listAllocations = async (req, res) => {
  try {
    const data = await allocationService.listAllocations(req.params.targetId);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.getAllocation = async (req, res) => {
  try {
    const data = await allocationService.getAllocationById(req.params.allocationId);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.updateAllocation = async (req, res) => {
  try {
    const alloc = await allocationService.getAllocationById(req.params.allocationId);
    await assertWriteAccess(req, alloc.clientId);
    const data = await allocationService.updateAllocation(req.params.allocationId, req.body, req.user);
    ok(res, data);
  } catch (e) { err(res, e); }
};

/**
 * POST /targets/:targetId/allocations/bulk
 * Body: { rows: GeneratedRow[], chartType, chartId }
 *
 * Upserts all rows in one request. Existing DRAFT rows are updated;
 * missing rows are created; SUBMITTED/APPROVED rows are skipped.
 */
exports.bulkUpsertAllocations = async (req, res) => {
  try {
    const target = await targetService.getTargetById(req.params.targetId);
    await assertWriteAccess(req, target.clientId);
    assertCanDraftAllocation(req);

    const { rows = [], chartType, chartId } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      const e = new Error('rows array is required and must not be empty.'); e.status = 422; throw e;
    }
    if (!chartType) {
      const e = new Error('chartType is required.'); e.status = 422; throw e;
    }

    const result = await allocationService.bulkUpsertAllocations(
      req.params.targetId,
      target.clientId,
      rows,
      chartType,
      chartId || null,
      req.user
    );

    ok(res, result, 200);
  } catch (e) { err(res, e); }
};

exports.submitAllocation = async (req, res) => {
  try {
    const alloc = await allocationService.getAllocationById(req.params.allocationId);
    await assertWriteAccess(req, alloc.clientId);
    const data = await allocationService.submitAllocation(req.params.allocationId, req.user);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.approveAllocation = async (req, res) => {
  try {
    const alloc = await allocationService.getAllocationById(req.params.allocationId);
    await assertWriteAccess(req, alloc.clientId);
    assertCanApprove(req);
    const data = await allocationService.approveAllocation(req.params.allocationId, req.user);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.approveAllAllocations = async (req, res) => {
  try {
    const target = await targetService.getTargetById(req.params.targetId);
    await assertWriteAccess(req, target.clientId);
    assertCanApprove(req);
    const data = await allocationService.approveAllAllocations(req.params.targetId, req.user);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.deleteAllocation = async (req, res) => {
  try {
    const alloc = await allocationService.getAllocationById(req.params.allocationId);
    await assertWriteAccess(req, alloc.clientId);
    const data = await allocationService.deleteAllocation(req.params.allocationId, req.user);
    ok(res, data);
  } catch (e) { err(res, e); }
};
