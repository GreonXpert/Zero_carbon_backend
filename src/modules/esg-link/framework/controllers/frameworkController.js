'use strict';

const EsgFramework              = require('../models/Framework.model');
const { canManageFrameworkLibrary } = require('../services/frameworkAccessService');

const createFramework = async (req, res) => {
  try {
    const perm = canManageFrameworkLibrary(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { frameworkCode, frameworkName, frameworkType, country, authority, description, version } = req.body;
    if (!frameworkCode) return res.status(400).json({ message: 'frameworkCode is required' });
    if (!frameworkName) return res.status(400).json({ message: 'frameworkName is required' });

    const exists = await EsgFramework.findOne({ frameworkCode: frameworkCode.toUpperCase() }).lean();
    if (exists) return res.status(409).json({ message: `Framework with code "${frameworkCode}" already exists` });

    const framework = await EsgFramework.create({
      frameworkCode: frameworkCode.toUpperCase(),
      frameworkName,
      frameworkType: frameworkType || 'mandatory',
      country:       country       || null,
      authority:     authority     || null,
      description:   description   || null,
      version:       version       || '1.0',
      status:        'draft',
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
    const { status } = req.query;
    const query = {};
    if (status) query.status = status;

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

module.exports = { createFramework, listFrameworks, getFrameworkById, updateFramework, seedBrsrFramework };
