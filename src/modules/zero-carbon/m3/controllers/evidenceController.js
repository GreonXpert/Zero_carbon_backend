'use strict';

const EvidenceAttachment = require('../models/EvidenceAttachment');
const TargetMaster       = require('../models/TargetMaster');
const SourceAllocation   = require('../models/SourceAllocation');
const CreditLedger       = require('../models/CreditLedger');
const RecalculationEvent = require('../models/RecalculationEvent');
const { assertWriteAccess, resolveClientId } = require('../utils/m3Permission');

const ok  = (res, data, s = 200) => res.status(s).json({ success: true, data });
const err = (res, e) => res.status(e.status || 500).json({ success: false, message: e.message });

// Resolve clientId from the attached entity when caller is consultant_admin (no clientId in JWT)
async function clientIdFromEntity(entity_type, entity_id, req) {
  // Explicit clientId in body always wins
  if (req.body.clientId) return req.body.clientId;
  if (req.query.clientId) return req.query.clientId;
  if (req.user.clientId)  return req.user.clientId;

  const modelMap = {
    TargetMaster:            TargetMaster,
    SourceAllocation:        SourceAllocation,
    CreditLedger:            CreditLedger,
    RecalculationEvent:      RecalculationEvent,
  };
  const Model = modelMap[entity_type];
  if (!Model) return null;
  const doc = await Model.findById(entity_id).select('clientId').lean();
  return doc?.clientId || null;
}

exports.uploadAttachment = async (req, res) => {
  try {
    const { entity_type, entity_id, file_name, file_url, attachment_type } = req.body;
    if (!entity_type || !entity_id || !file_name || !file_url || !attachment_type) {
      return res.status(422).json({ success: false, message: 'entity_type, entity_id, file_name, file_url, and attachment_type are required.' });
    }
    const clientId = await clientIdFromEntity(entity_type, entity_id, req);
    if (!clientId) {
      return res.status(422).json({ success: false, message: 'Could not resolve clientId. Include clientId in the request body or ensure the entity exists.' });
    }
    await assertWriteAccess(req, clientId);
    const doc = await EvidenceAttachment.create({
      clientId,
      entity_type,
      entity_id,
      file_name,
      file_url,
      attachment_type,
      uploaded_by: req.user._id,
    });
    ok(res, doc, 201);
  } catch (e) { err(res, e); }
};

exports.listAttachments = async (req, res) => {
  try {
    const { entityType, entityId } = req.params;
    const data = await EvidenceAttachment.find({ entity_type: entityType, entity_id: entityId });
    ok(res, data);
  } catch (e) { err(res, e); }
};
