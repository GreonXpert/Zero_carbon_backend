'use strict';

const EsgFrameworkSection       = require('../models/FrameworkSection.model');
const EsgFramework              = require('../models/Framework.model');
const { canManageFrameworkLibrary } = require('../services/frameworkAccessService');

const createSection = async (req, res) => {
  try {
    const perm = canManageFrameworkLibrary(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const {
      frameworkId, frameworkCode, sectionCode, sectionName, description,
      parentSectionId, parentSectionCode, principleCode, displayOrder,
    } = req.body;

    if (!frameworkId)   return res.status(400).json({ message: 'frameworkId is required' });
    if (!frameworkCode) return res.status(400).json({ message: 'frameworkCode is required' });
    if (!sectionCode)   return res.status(400).json({ message: 'sectionCode is required' });
    if (!sectionName)   return res.status(400).json({ message: 'sectionName is required' });

    const exists = await EsgFrameworkSection.findOne({
      frameworkCode: frameworkCode.toUpperCase(),
      sectionCode,
    }).lean();
    if (exists) {
      return res.status(409).json({ message: `Section "${sectionCode}" already exists for framework "${frameworkCode}"` });
    }

    const section = await EsgFrameworkSection.create({
      frameworkId,
      frameworkCode: frameworkCode.toUpperCase(),
      sectionCode,
      sectionName,
      description:        description        || null,
      parentSectionId:    parentSectionId    || null,
      parentSectionCode:  parentSectionCode  || null,
      principleCode:      principleCode      || null,
      displayOrder:       displayOrder       || 0,
    });

    return res.status(201).json({ success: true, message: 'Section created', data: section });
  } catch (err) {
    console.error('[frameworkSectionController] createSection:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const listSections = async (req, res) => {
  try {
    const { frameworkId } = req.params;
    const { frameworkCode } = req.query;

    const query = {};
    if (frameworkId)   query.frameworkId   = frameworkId;
    if (frameworkCode) query.frameworkCode = frameworkCode.toUpperCase();

    const sections = await EsgFrameworkSection.find(query)
      .sort({ displayOrder: 1, sectionCode: 1 })
      .lean();

    return res.status(200).json({ success: true, data: sections });
  } catch (err) {
    console.error('[frameworkSectionController] listSections:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const updateSection = async (req, res) => {
  try {
    const perm = canManageFrameworkLibrary(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { sectionName, description, principleCode, displayOrder, status } = req.body;

    const section = await EsgFrameworkSection.findByIdAndUpdate(
      req.params.sectionId,
      { $set: { sectionName, description, principleCode, displayOrder, status } },
      { new: true, runValidators: true }
    );

    if (!section) return res.status(404).json({ message: 'Section not found' });
    return res.status(200).json({ success: true, message: 'Section updated', data: section });
  } catch (err) {
    console.error('[frameworkSectionController] updateSection:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

module.exports = { createSection, listSections, updateSection };
