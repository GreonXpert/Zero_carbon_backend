'use strict';

const InitiativeAttribution = require('../models/InitiativeAttribution');
const targetService = require('../services/targetService');
const { assertWriteAccess, resolveClientId } = require('../utils/m3Permission');

const ok  = (res, data, s = 200) => res.status(s).json({ success: true, data });
const err = (res, e) => res.status(e.status || 500).json({ success: false, message: e.message });

exports.createAttribution = async (req, res) => {
  try {
    if (!req.body.target_id || !req.body.initiative_id) {
      return res.status(422).json({ success: false, message: 'target_id and initiative_id are required.' });
    }
    // Derive clientId from target — consultant_admin has no clientId in their JWT
    const target = await targetService.getTargetById(req.body.target_id);
    const clientId = target.clientId;
    await assertWriteAccess(req, clientId);
    const data = await InitiativeAttribution.create({
      ...req.body,
      clientId,
      created_by: req.user._id,
      updated_by: req.user._id,
    });
    ok(res, data, 201);
  } catch (e) { err(res, e); }
};

exports.updateAttribution = async (req, res) => {
  try {
    const attr = await InitiativeAttribution.findById(req.params.id);
    if (!attr || attr.isDeleted) return res.status(404).json({ success: false, message: 'Not found.' });
    await assertWriteAccess(req, attr.clientId);
    Object.assign(attr, req.body, { updated_by: req.user._id });
    await attr.save();
    ok(res, attr);
  } catch (e) { err(res, e); }
};

exports.getAttribution = async (req, res) => {
  try {
    const data = await InitiativeAttribution.findById(req.params.id);
    if (!data || data.isDeleted) return res.status(404).json({ success: false, message: 'Not found.' });
    ok(res, data);
  } catch (e) { err(res, e); }
};
