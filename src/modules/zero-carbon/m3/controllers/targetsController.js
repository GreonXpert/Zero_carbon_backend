'use strict';

const targetService = require('../services/targetService');
const pathwayService = require('../services/pathwayService');
const progressService = require('../services/progressService');
const forecastService = require('../services/forecastService');
const InitiativeAttribution = require('../models/InitiativeAttribution');
const EvidenceAttachment = require('../models/EvidenceAttachment');
const { assertWriteAccess, assertCanApprove, resolveClientId } = require('../utils/m3Permission');

const respond = (res, data, status = 200) => res.status(status).json({ success: true, data });
const err = (res, e) => res.status(e.status || 500).json({ success: false, message: e.message });

exports.createTarget = async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    await assertWriteAccess(req, clientId);
    const target = await targetService.createTarget({ ...req.body, clientId }, req.user);
    respond(res, target, 201);
  } catch (e) { err(res, e); }
};

exports.listTargets = async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const data = await targetService.listTargets(clientId, req.query);
    respond(res, data);
  } catch (e) { err(res, e); }
};

exports.getTarget = async (req, res) => {
  try {
    const data = await targetService.getTargetById(req.params.targetId);
    respond(res, data);
  } catch (e) { err(res, e); }
};

exports.updateTarget = async (req, res) => {
  try {
    const target = await targetService.getTargetById(req.params.targetId);
    await assertWriteAccess(req, target.clientId);
    const updated = await targetService.updateTarget(req.params.targetId, req.body, req.user);
    respond(res, updated);
  } catch (e) { err(res, e); }
};

exports.submitTarget = async (req, res) => {
  try {
    const target = await targetService.getTargetById(req.params.targetId);
    await assertWriteAccess(req, target.clientId);
    const updated = await targetService.submitTarget(req.params.targetId, req.user);
    respond(res, updated);
  } catch (e) { err(res, e); }
};

exports.reviewTarget = async (req, res) => {
  try {
    const target = await targetService.getTargetById(req.params.targetId);
    await assertWriteAccess(req, target.clientId);
    assertCanApprove(req);
    const updated = await targetService.reviewTarget(req.params.targetId, req.user);
    respond(res, updated);
  } catch (e) { err(res, e); }
};

exports.returnTarget = async (req, res) => {
  try {
    const target = await targetService.getTargetById(req.params.targetId);
    await assertWriteAccess(req, target.clientId);
    assertCanApprove(req);
    const updated = await targetService.returnTarget(req.params.targetId, req.body.comment, req.user);
    respond(res, updated);
  } catch (e) { err(res, e); }
};

exports.approveTarget = async (req, res) => {
  try {
    const target = await targetService.getTargetById(req.params.targetId);
    await assertWriteAccess(req, target.clientId);
    assertCanApprove(req);
    const updated = await targetService.approveTarget(req.params.targetId, req.body.comment, req.user);
    respond(res, updated);
  } catch (e) { err(res, e); }
};

exports.publishTarget = async (req, res) => {
  try {
    const target = await targetService.getTargetById(req.params.targetId);
    await assertWriteAccess(req, target.clientId);
    assertCanApprove(req);
    const updated = await targetService.publishTarget(req.params.targetId, req.body.comment, req.user);
    respond(res, updated);
  } catch (e) { err(res, e); }
};

exports.archiveTarget = async (req, res) => {
  try {
    const target = await targetService.getTargetById(req.params.targetId);
    await assertWriteAccess(req, target.clientId);
    assertCanApprove(req);
    const updated = await targetService.archiveTarget(req.params.targetId, req.user);
    respond(res, updated);
  } catch (e) { err(res, e); }
};

exports.getRevisions = async (req, res) => {
  try {
    const data = await targetService.getRevisions(req.params.targetId);
    respond(res, data);
  } catch (e) { err(res, e); }
};

exports.getPathway = async (req, res) => {
  try {
    const data = await pathwayService.getPathway(req.params.targetId);
    respond(res, data);
  } catch (e) { err(res, e); }
};

exports.getOperationalBudgets = async (req, res) => {
  try {
    const data = await pathwayService.getOperationalBudgets(req.params.targetId, req.query.granularity);
    respond(res, data);
  } catch (e) { err(res, e); }
};

exports.getProgress = async (req, res) => {
  try {
    const data = await progressService.getProgress(req.params.targetId);
    respond(res, data);
  } catch (e) { err(res, e); }
};

exports.getForecast = async (req, res) => {
  try {
    const data = await forecastService.getForecast(req.params.targetId);
    respond(res, data);
  } catch (e) { err(res, e); }
};

exports.getLive = async (req, res) => {
  try {
    const data = await progressService.getLiveSnapshot(req.params.targetId);
    respond(res, data);
  } catch (e) { err(res, e); }
};

exports.getHistory = async (req, res) => {
  try {
    const data = await targetService.getHistory(req.params.targetId);
    respond(res, data);
  } catch (e) { err(res, e); }
};

exports.getInitiatives = async (req, res) => {
  try {
    const data = await InitiativeAttribution.find({ target_id: req.params.targetId, isDeleted: false });
    respond(res, data);
  } catch (e) { err(res, e); }
};

exports.getAttachments = async (req, res) => {
  try {
    const data = await EvidenceAttachment.find({
      entity_type: 'TargetMaster',
      entity_id:   req.params.targetId,
    });
    respond(res, data);
  } catch (e) { err(res, e); }
};
