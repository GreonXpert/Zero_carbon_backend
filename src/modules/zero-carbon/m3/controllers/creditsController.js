'use strict';

const residualService = require('../services/residualService');
const TargetMaster = require('../models/TargetMaster');
const { assertWriteAccess, assertCanApprove, resolveClientId } = require('../utils/m3Permission');

const ok  = (res, data, s = 200) => res.status(s).json({ success: true, data });
const err = (res, e) => res.status(e.status || 500).json({ success: false, message: e.message });

exports.listResidualPositions = async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const data = await residualService.listResidualPositions(clientId, req.query.target_id);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.getResidualPosition = async (req, res) => {
  try {
    const data = await residualService.getResidualPositionById(req.params.id);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.createResidualPosition = async (req, res) => {
  try {
    // Derive clientId from target — consultant_admin has no clientId in their JWT
    if (!req.body.target_id) {
      return res.status(422).json({ success: false, message: 'target_id is required.' });
    }
    const target = await TargetMaster.findById(req.body.target_id);
    if (!target) return res.status(404).json({ success: false, message: 'Target not found.' });
    const clientId = target.clientId;
    await assertWriteAccess(req, clientId);
    const data = await residualService.computeResidualPosition(
      { ...req.body, clientId }, req.user
    );
    ok(res, data, 201);
  } catch (e) { err(res, e); }
};

exports.createCredit = async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    await assertWriteAccess(req, clientId);
    const data = await residualService.createCredit({ ...req.body, clientId }, req.user);
    ok(res, data, 201);
  } catch (e) { err(res, e); }
};

exports.updateCredit = async (req, res) => {
  try {
    const credit = await residualService.getCreditById(req.params.id);
    await assertWriteAccess(req, credit.clientId);
    const data = await residualService.updateCredit(req.params.id, req.body, req.user);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.retireCredit = async (req, res) => {
  try {
    const credit = await residualService.getCreditById(req.params.id);
    await assertWriteAccess(req, credit.clientId);
    const data = await residualService.retireCredit(req.params.id, req.body.evidence_attachment_id, req.user);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.listCredits = async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const data = await residualService.listCredits(clientId, req.query);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.getCredit = async (req, res) => {
  try {
    const data = await residualService.getCreditById(req.params.id);
    ok(res, data);
  } catch (e) { err(res, e); }
};

// ── Phase 8: Credit lifecycle ─────────────────────────────────────────────────

exports.holdCredit = async (req, res) => {
  try {
    const credit = await residualService.getCreditById(req.params.id);
    await assertWriteAccess(req, credit.clientId);
    const data = await residualService.holdCredit(req.params.id, req.user);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.cancelCredit = async (req, res) => {
  try {
    const credit = await residualService.getCreditById(req.params.id);
    await assertWriteAccess(req, credit.clientId);
    const data = await residualService.cancelCredit(req.params.id, req.body.reason, req.user);
    ok(res, data);
  } catch (e) { err(res, e); }
};
