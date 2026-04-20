'use strict';

const Client = require('../../../../client-management/client/Client');
const {
  isConsultantForClient,
  isConsultantAdminForClient,
} = require('../../data-collection/utils/submissionPermissions');
const { isModuleSubscriptionActive } = require('../../../../../common/utils/Permissions/modulePermission');

function computeAllowedLayers(userType) {
  switch (userType) {
    case 'super_admin':
    case 'consultant_admin':
    case 'consultant':
      return ['approved', 'reviewer_pending', 'approver_pending', 'draft'];
    case 'client_admin':
      return ['approved', 'reviewer_pending', 'approver_pending'];
    case 'reviewer':
      return ['approved', 'reviewer_pending'];
    case 'approver':
      return ['approved', 'approver_pending'];
    case 'contributor':
      return ['approved', 'draft'];
    case 'viewer':
    case 'auditor':
    default:
      return ['approved'];
  }
}

async function checkEsgSummaryPermission(req, res, next) {
  try {
    const user     = req.user;
    const clientId = req.params.clientId;

    if (!user)     return res.status(401).json({ success: false, message: 'Unauthenticated' });
    if (!clientId) return res.status(400).json({ success: false, message: 'clientId is required' });

    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const isSandbox = client.sandbox === true || String(client.clientId || '').startsWith('Sandbox_');
    if (!isSandbox && !isModuleSubscriptionActive(client, 'esg_link')) {
      return res.status(403).json({ success: false, message: 'ESGLink subscription is not active', subscriptionExpired: true });
    }

    const role = user.userType;
    let hasAccess = false;

    if (role === 'super_admin') {
      hasAccess = true;
    } else if (role === 'consultant_admin') {
      hasAccess = await isConsultantAdminForClient(user, clientId);
    } else if (role === 'consultant') {
      hasAccess = await isConsultantForClient(user, clientId);
    } else if (['client_admin', 'viewer', 'auditor', 'contributor', 'reviewer', 'approver'].includes(role)) {
      hasAccess = user.clientId === clientId;
    }

    if (!hasAccess) {
      return res.status(403).json({ success: false, message: 'Access denied to ESG summary for this client' });
    }

    const roleLayers = computeAllowedLayers(role);
    let allowedLayers = roleLayers;
    if (req.query.layers) {
      const requested = req.query.layers.split(',').map((l) => l.trim());
      allowedLayers   = requested.filter((l) => roleLayers.includes(l));
    }

    req.esgSummaryCtx = {
      role,
      clientId,
      isFullAccess: ['super_admin', 'consultant_admin', 'consultant'].includes(role),
      allowedLayers,
      userId: (user._id || user.id).toString(),
    };

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { checkEsgSummaryPermission, computeAllowedLayers };
