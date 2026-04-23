'use strict';

const complianceService = require('../services/complianceService');
const TargetMaster = require('../models/TargetMaster');
const { assertWriteAccess, assertCanApprove, resolveClientId } = require('../utils/m3Permission');

const ok  = (res, data, s = 200) => res.status(s).json({ success: true, data });
const err = (res, e) => res.status(e.status || 500).json({ success: false, message: e.message });

exports.createComplianceYear = async (req, res) => {
  try {
    // Derive clientId from the target — consultant_admin has no clientId in their JWT
    if (!req.body.target_id) {
      return res.status(422).json({ success: false, message: 'target_id is required.' });
    }
    const target = await TargetMaster.findById(req.body.target_id);
    if (!target) return res.status(404).json({ success: false, message: 'Target not found.' });
    const clientId = target.clientId;
    await assertWriteAccess(req, clientId);
    const data = await complianceService.createComplianceYear({ ...req.body, clientId }, req.user);
    ok(res, data, 201);
  } catch (e) { err(res, e); }
};

exports.listComplianceYears = async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const data = await complianceService.listComplianceYears(clientId, req.query.target_id);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.getComplianceYear = async (req, res) => {
  try {
    const data = await complianceService.getComplianceYearById(req.params.id);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.closeComplianceYear = async (req, res) => {
  try {
    const record = await complianceService.getComplianceYearById(req.params.id);
    await assertWriteAccess(req, record.clientId);
    assertCanApprove(req);
    const data = await complianceService.closeComplianceYear(req.params.id, req.user);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.reopenComplianceYear = async (req, res) => {
  try {
    const record = await complianceService.getComplianceYearById(req.params.id);
    await assertWriteAccess(req, record.clientId);
    assertCanApprove(req);
    const data = await complianceService.reopenComplianceYear(req.params.id, req.body.justification, req.user);
    ok(res, data);
  } catch (e) { err(res, e); }
};
