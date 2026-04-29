'use strict';

const ClientFrameworkInstance     = require('../models/ClientFrameworkInstance.model');
const EsgFramework                = require('../models/Framework.model');
const { canActivateClientFramework, canViewClientBrsr } = require('../services/frameworkAccessService');
const { getReadinessDashboard }   = require('../services/brsrReadinessService');

const activateFramework = async (req, res) => {
  try {
    const { clientId } = req.params;
    const perm = await canActivateClientFramework(req.user, clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { frameworkCode, periodId, reportingYear } = req.body;
    if (!frameworkCode)  return res.status(400).json({ message: 'frameworkCode is required' });
    if (!periodId)       return res.status(400).json({ message: 'periodId is required' });
    if (!reportingYear)  return res.status(400).json({ message: 'reportingYear is required' });

    const framework = await EsgFramework.findOne({ frameworkCode: frameworkCode.toUpperCase(), status: 'active' }).lean();
    if (!framework) {
      return res.status(404).json({ message: `No active framework found with code "${frameworkCode}"` });
    }

    const existing = await ClientFrameworkInstance.findOne({
      clientId,
      frameworkCode: frameworkCode.toUpperCase(),
      periodId,
    }).lean();
    if (existing) {
      return res.status(409).json({ message: 'Framework already activated for this client and period', data: existing });
    }

    // Year-gate: block activation if any previous period is still in-progress
    const inProgress = await ClientFrameworkInstance.findOne({
      clientId,
      frameworkCode: frameworkCode.toUpperCase(),
      status: { $nin: ['completed', 'cancelled'] },
    }).lean();
    if (inProgress) {
      return res.status(400).json({
        message: `Cannot start a new BRSR period while period "${inProgress.periodId}" is still in progress. Complete or cancel the previous year first.`,
        data: { blockedByPeriodId: inProgress.periodId, blockedByStatus: inProgress.status },
      });
    }

    const instance = await ClientFrameworkInstance.create({
      clientId,
      frameworkId:   framework._id,
      frameworkCode: frameworkCode.toUpperCase(),
      periodId,
      reportingYear: Number(reportingYear),
      status:        'active',
      activatedBy:   req.user._id,
      activatedAt:   new Date(),
    });

    return res.status(201).json({ success: true, message: 'Framework activated', data: instance });
  } catch (err) {
    console.error('[clientFrameworkController] activateFramework:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const getStatus = async (req, res) => {
  try {
    const { clientId } = req.params;
    const perm = await canViewClientBrsr(req.user, clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { frameworkCode, periodId } = req.query;
    const query = { clientId };
    if (frameworkCode) query.frameworkCode = frameworkCode.toUpperCase();
    if (periodId)      query.periodId      = periodId;

    const instances = await ClientFrameworkInstance.find(query).lean();
    return res.status(200).json({ success: true, data: instances });
  } catch (err) {
    console.error('[clientFrameworkController] getStatus:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const getReadiness = async (req, res) => {
  try {
    const { clientId } = req.params;
    const perm = await canViewClientBrsr(req.user, clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { frameworkCode, periodId } = req.query;
    if (!frameworkCode) return res.status(400).json({ message: 'frameworkCode query param is required' });
    if (!periodId)      return res.status(400).json({ message: 'periodId query param is required' });

    const dashboard = await getReadinessDashboard(clientId, frameworkCode.toUpperCase(), periodId);
    return res.status(200).json({ success: true, data: dashboard });
  } catch (err) {
    console.error('[clientFrameworkController] getReadiness:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const lockFramework = async (req, res) => {
  try {
    const { clientId } = req.params;
    const perm = await canActivateClientFramework(req.user, clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { frameworkCode, periodId } = req.body;
    if (!frameworkCode) return res.status(400).json({ message: 'frameworkCode is required' });
    if (!periodId)      return res.status(400).json({ message: 'periodId is required' });

    const instance = await ClientFrameworkInstance.findOneAndUpdate(
      { clientId, frameworkCode: frameworkCode.toUpperCase(), periodId, status: 'active' },
      { $set: { status: 'locked', lockedBy: req.user._id, lockedAt: new Date() } },
      { new: true }
    );
    if (!instance) return res.status(404).json({ message: 'Active framework instance not found' });

    return res.status(200).json({ success: true, message: 'Framework locked', data: instance });
  } catch (err) {
    console.error('[clientFrameworkController] lockFramework:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const reopenFramework = async (req, res) => {
  try {
    const { clientId } = req.params;
    const perm = await canActivateClientFramework(req.user, clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { frameworkCode, periodId } = req.body;
    if (!frameworkCode) return res.status(400).json({ message: 'frameworkCode is required' });
    if (!periodId)      return res.status(400).json({ message: 'periodId is required' });

    const instance = await ClientFrameworkInstance.findOneAndUpdate(
      { clientId, frameworkCode: frameworkCode.toUpperCase(), periodId, status: 'locked' },
      { $set: { status: 'active', lockedBy: null, lockedAt: null } },
      { new: true }
    );
    if (!instance) return res.status(404).json({ message: 'Locked framework instance not found' });

    return res.status(200).json({ success: true, message: 'Framework reopened', data: instance });
  } catch (err) {
    console.error('[clientFrameworkController] reopenFramework:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

module.exports = { activateFramework, getStatus, getReadiness, lockFramework, reopenFramework };
