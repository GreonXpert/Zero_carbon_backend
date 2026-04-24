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

/**
 * GET /initiative-attributions?target_id=xxx&clientId=xxx
 * Lists all non-deleted attributions for the given target (or client).
 */
exports.listAttributions = async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const query    = { isDeleted: false };
    if (req.query.target_id)    query.target_id    = req.query.target_id;
    if (clientId)               query.clientId     = clientId;
    if (req.query.initiative_id) query.initiative_id = req.query.initiative_id;
    if (req.query.verification_status) query.verification_status = req.query.verification_status;

    const data = await InitiativeAttribution.find(query).sort({ createdAt: -1 });
    ok(res, data);
  } catch (e) { err(res, e); }
};
