'use strict';

const { canViewClientBrsr }     = require('../services/frameworkAccessService');
const { getReadinessDashboard } = require('../services/brsrReadinessService');

const getProgress = async (req, res) => {
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
    console.error('[progressController] getProgress:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

module.exports = { getProgress };
