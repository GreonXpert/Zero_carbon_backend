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
