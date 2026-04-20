'use strict';

const svc = require('../services/rollUpService');

const WRITE_ROLES = new Set(['super_admin', 'consultant_admin']);

function requireWriteRole(req, res) {
  if (!req.user || !WRITE_ROLES.has(req.user.userType)) {
    res.status(403).json({ success: false, message: 'Only super_admin or consultant_admin can manage rollUpBehaviors' });
    return false;
  }
  return true;
}

async function listBehaviors(req, res) {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const behaviors = await svc.listBehaviors({ includeInactive });
    res.json({ success: true, data: behaviors });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

async function createBehavior(req, res) {
  if (!requireWriteRole(req, res)) return;
  const { code, label, description } = req.body;
  if (!code || !label) {
    return res.status(400).json({ success: false, message: 'code and label are required' });
  }
  try {
    const doc = await svc.createBehavior({ code, label, description, createdBy: req.user._id });
    res.status(201).json({ success: true, data: doc });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
}

async function updateBehavior(req, res) {
  if (!requireWriteRole(req, res)) return;
  const { label, description, isActive } = req.body;
  try {
    const doc = await svc.updateBehavior(req.params.id, { label, description, isActive, updatedBy: req.user._id });
    res.json({ success: true, data: doc });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
}

async function deleteBehavior(req, res) {
  if (!requireWriteRole(req, res)) return;
  try {
    await svc.deleteBehavior(req.params.id, req.user._id);
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
}

module.exports = { listBehaviors, createBehavior, updateBehavior, deleteBehavior };
