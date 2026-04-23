'use strict';

const reportService = require('../services/reportService');
const { resolveClientId } = require('../utils/m3Permission');

const ok  = (res, data) => res.status(200).json({ success: true, data });
const err = (res, e) => res.status(e.status || 500).json({ success: false, message: e.message });

exports.targetSummary = async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const data = await reportService.getTargetSummaryReport(clientId, req.query);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.complianceYearReport = async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const data = await reportService.getComplianceYearReport(clientId, req.query);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.sourceAccountability = async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const data = await reportService.getSourceAccountabilityReport(clientId, req.query.target_id);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.initiativeReduction = async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const data = await reportService.getInitiativeReductionReport(clientId, req.query.target_id);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.forecastRisk = async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const data = await reportService.getForecastRiskReport(clientId, req.query);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.auditEvidencePackage = async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const data = await reportService.getAuditEvidencePackage(clientId, req.query.target_id);
    ok(res, data);
  } catch (e) { err(res, e); }
};
