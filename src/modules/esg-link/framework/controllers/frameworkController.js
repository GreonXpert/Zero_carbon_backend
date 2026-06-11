'use strict';

const EsgFramework              = require('../models/Framework.model');
const { canManageFrameworkLibrary } = require('../services/frameworkAccessService');

const createFramework = async (req, res) => {
  try {
    const perm = canManageFrameworkLibrary(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { frameworkCode, frameworkName, frameworkType, country, authority, description, version, status } = req.body;
    if (!frameworkCode) return res.status(400).json({ message: 'frameworkCode is required' });
    if (!frameworkName) return res.status(400).json({ message: 'frameworkName is required' });

    const exists = await EsgFramework.findOne({ frameworkCode: frameworkCode.toUpperCase() }).lean();
    if (exists) return res.status(409).json({ message: `Framework with code "${frameworkCode}" already exists` });

    const allowedStatuses = ['draft', 'active', 'retired'];
    const framework = await EsgFramework.create({
      frameworkCode: frameworkCode.toUpperCase(),
      frameworkName,
      frameworkType: frameworkType || 'mandatory',
      country:       country       || null,
      authority:     authority     || null,
      description:   description   || null,
      version:       version       || '1.0',
      status:        allowedStatuses.includes(status) ? status : 'draft',
      createdBy:     req.user._id,
    });

    return res.status(201).json({ success: true, message: 'Framework created', data: framework });
  } catch (err) {
    console.error('[frameworkController] createFramework:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const listFrameworks = async (req, res) => {
  try {
    const { status, showDeleted } = req.query;
    const query = {};
    if (showDeleted === 'true') {
      query.isDeleted = true;
    } else {
      query.isDeleted = { $ne: true };
      if (status) query.status = status;
    }

    const frameworks = await EsgFramework.find(query).sort({ createdAt: -1 }).lean();
    return res.status(200).json({ success: true, data: frameworks });
  } catch (err) {
    console.error('[frameworkController] listFrameworks:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const getFrameworkById = async (req, res) => {
  try {
    const framework = await EsgFramework.findById(req.params.frameworkId).lean();
    if (!framework) return res.status(404).json({ message: 'Framework not found' });
    return res.status(200).json({ success: true, data: framework });
  } catch (err) {
    console.error('[frameworkController] getFrameworkById:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const updateFramework = async (req, res) => {
  try {
    const perm = canManageFrameworkLibrary(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { frameworkName, frameworkType, country, authority, description, version, status } = req.body;

    const framework = await EsgFramework.findByIdAndUpdate(
      req.params.frameworkId,
      { $set: { frameworkName, frameworkType, country, authority, description, version, status } },
      { new: true, runValidators: true }
    );

    if (!framework) return res.status(404).json({ message: 'Framework not found' });
    return res.status(200).json({ success: true, message: 'Framework updated', data: framework });
  } catch (err) {
    console.error('[frameworkController] updateFramework:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const activateFramework = async (req, res) => {
  try {
    const perm = canManageFrameworkLibrary(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { comment } = req.body;
    if (!comment || !comment.trim()) {
      return res.status(400).json({ message: 'Approval comment is required' });
    }

    const existing = await EsgFramework.findOne({ _id: req.params.frameworkId, isDeleted: { $ne: true } }).lean();
    if (!existing) return res.status(404).json({ message: 'Framework not found' });

    const historyEntry = {
      fromStatus: existing.status,
      toStatus:   'active',
      changedBy:  req.user._id,
      changedAt:  new Date(),
      comment:    comment.trim(),
    };

    const framework = await EsgFramework.findByIdAndUpdate(
      req.params.frameworkId,
      {
        $set: {
          status:          'active',
          approvedBy:      req.user._id,
          approvedAt:      new Date(),
          approvedComment: comment.trim(),
        },
        $push: { statusHistory: historyEntry },
      },
      { new: true }
    );

    return res.status(200).json({ success: true, message: 'Framework activated', data: framework });
  } catch (err) {
    console.error('[frameworkController] activateFramework:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const changeFrameworkStatus = async (req, res) => {
  try {
    const perm = canManageFrameworkLibrary(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { status, comment } = req.body;
    const allowed = ['draft', 'active', 'retired'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: `Invalid status. Allowed: ${allowed.join(', ')}` });
    }

    const existing = await EsgFramework.findOne({ _id: req.params.frameworkId, isDeleted: { $ne: true } }).lean();
    if (!existing) return res.status(404).json({ message: 'Framework not found' });
    if (existing.status === status) {
      return res.status(400).json({ message: `Framework is already in "${status}" status` });
    }

    const historyEntry = {
      fromStatus: existing.status,
      toStatus:   status,
      changedBy:  req.user._id,
      changedAt:  new Date(),
      comment:    comment ? comment.trim() : null,
    };

    const updateFields = { status };
    if (status === 'active') {
      updateFields.approvedBy      = req.user._id;
      updateFields.approvedAt      = new Date();
      updateFields.approvedComment = comment ? comment.trim() : null;
    }

    const framework = await EsgFramework.findByIdAndUpdate(
      req.params.frameworkId,
      { $set: updateFields, $push: { statusHistory: historyEntry } },
      { new: true }
    );

    return res.status(200).json({ success: true, message: `Framework status changed to "${status}"`, data: framework });
  } catch (err) {
    console.error('[frameworkController] changeFrameworkStatus:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const deleteFramework = async (req, res) => {
  try {
    const perm = canManageFrameworkLibrary(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const framework = await EsgFramework.findOneAndUpdate(
      { _id: req.params.frameworkId, isDeleted: { $ne: true } },
      { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: req.user._id } },
      { new: true }
    );

    if (!framework) return res.status(404).json({ message: 'Framework not found or already deleted' });
    return res.status(200).json({ success: true, message: 'Framework deleted', data: framework });
  } catch (err) {
    console.error('[frameworkController] deleteFramework:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const restoreFramework = async (req, res) => {
  try {
    const perm = canManageFrameworkLibrary(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const framework = await EsgFramework.findOneAndUpdate(
      { _id: req.params.frameworkId, isDeleted: true },
      { $set: { isDeleted: false, deletedAt: null, deletedBy: null } },
      { new: true }
    );

    if (!framework) return res.status(404).json({ message: 'Framework not found or not deleted' });
    return res.status(200).json({ success: true, message: 'Framework restored', data: framework });
  } catch (err) {
    console.error('[frameworkController] restoreFramework:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Seed endpoint — creates BRSR framework if not already present
const seedBrsrFramework = async (req, res) => {
  try {
    const perm = canManageFrameworkLibrary(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { seedBrsr } = require('../seed/brsrSeed');
    const result = await seedBrsr(req.user._id);
    return res.status(200).json({ success: true, message: 'BRSR seed completed', data: result });
  } catch (err) {
    console.error('[frameworkController] seedBrsrFramework:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

module.exports = { createFramework, listFrameworks, getFrameworkById, updateFramework, activateFramework, changeFrameworkStatus, deleteFramework, restoreFramework, seedBrsrFramework };
