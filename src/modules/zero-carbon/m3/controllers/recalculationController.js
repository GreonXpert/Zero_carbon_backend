'use strict';

const recalcService = require('../services/recalculationService');
const targetService = require('../services/targetService');
const TargetMaster = require('../models/TargetMaster');
const { assertWriteAccess, assertCanApprove, resolveClientId } = require('../utils/m3Permission');

const ok  = (res, data, s = 200) => res.status(s).json({ success: true, data });
const err = (res, e) => res.status(e.status || 500).json({ success: false, message: e.message });

exports.createRecalcEvent = async (req, res) => {
  try {
    // Derive clientId from the target — consultant_admin has no clientId in their JWT
    if (!req.body.target_id) {
      return res.status(422).json({ success: false, message: 'target_id is required.' });
    }
    const target = await TargetMaster.findById(req.body.target_id);
    if (!target) return res.status(404).json({ success: false, message: 'Target not found.' });
    const clientId = target.clientId;
    await assertWriteAccess(req, clientId);
    const data = await recalcService.createRecalcEvent({ ...req.body, clientId }, req.user);
    ok(res, data, 201);
  } catch (e) { err(res, e); }
};

exports.listRecalcEvents = async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const data = await recalcService.listRecalcEvents(clientId, req.query.target_id);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.getRecalcEvent = async (req, res) => {
  try {
    const data = await recalcService.getRecalcEventById(req.params.id);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.approveRecalcEvent = async (req, res) => {
  try {
    const event = await recalcService.getRecalcEventById(req.params.id);
    await assertWriteAccess(req, event.clientId);
    assertCanApprove(req);
    const data = await recalcService.approveRecalcEvent(req.params.id, req.user);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.rejectRecalcEvent = async (req, res) => {
  try {
    const event = await recalcService.getRecalcEventById(req.params.id);
    await assertWriteAccess(req, event.clientId);
    assertCanApprove(req);
    const data = await recalcService.rejectRecalcEvent(req.params.id, req.body.comment, req.user);
    ok(res, data);
  } catch (e) { err(res, e); }
};
