'use strict';

const Client      = require('../../../../client-management/client/Client');
const redisCache  = require('../../../../../common/utils/redisCache');
const {
  isConsultantForClient,
  isConsultantAdminForClient,
} = require('../../data-collection/utils/submissionPermissions');
const { isModuleSubscriptionActive } = require('../../../../../common/utils/Permissions/modulePermission');

const _PERM_TTL_SECONDS = 300; // 5-minute permission cache

async function _resolveAccess(role, user, clientId) {
  if (role === 'super_admin') return true;
  if (role === 'consultant_admin') return isConsultantAdminForClient(user, clientId);
  if (role === 'consultant')       return isConsultantForClient(user, clientId);
  if (['client_admin', 'client_employee_head', 'contributor', 'reviewer', 'approver', 'viewer', 'auditor'].includes(role)) {
    return user.clientId === clientId;
  }
  return false;
}

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

    const role   = user.userType;
    const userId = (user._id || user.id).toString();

    // Viewer/auditor: check JWT flag before any DB query (no DB needed)
    if (role === 'viewer' || role === 'auditor') {
      const esgSummaryEnabled = user.esgAccessControls?.modules?.esg_summary?.enabled === true;
      if (!esgSummaryEnabled) {
        return res.status(403).json({
          success: false,
          message: 'ESG summary access has not been granted. Contact your administrator.',
          accessDenied: 'esg_summary_not_enabled',
        });
      }
    }

    // ── Redis-cached permission check (5-min TTL) ─────────────────────────────
    const permKey    = `esg:perm:${clientId}:${userId}:${role}`;
    const permCached = await redisCache.get(permKey);

    let isSandbox, subscriptionActive, hasAccess;

    if (permCached) {
      ({ isSandbox, subscriptionActive, hasAccess } = permCached);
    } else {
      // Parallelize: fetch only subscription-relevant fields + resolve role access concurrently.
      // accountDetails is encrypted as a single blob — cannot use .lean() (skips decryption hook)
      // and cannot project a sub-path; select the whole field so the plugin decrypts it.
      const [client, accessResult] = await Promise.all([
        Client.findOne({ clientId })
          .select('clientId sandbox accountDetails'),
        _resolveAccess(role, user, clientId),
      ]);

      if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

      isSandbox          = client.sandbox === true || String(client.clientId || '').startsWith('Sandbox_');
      subscriptionActive = isModuleSubscriptionActive(client, 'esg_link');
      hasAccess          = accessResult;

      await redisCache.set(permKey, { isSandbox, subscriptionActive, hasAccess }, _PERM_TTL_SECONDS);
    }

    if (!isSandbox && !subscriptionActive) {
      return res.status(403).json({ success: false, message: 'ESGLink subscription is not active', subscriptionExpired: true });
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
      // Full-access roles see all queues (proxy view, can pass ?userId=xxx).
      // Includes client_admin (their own client) and auditor (read-only audit view).
      isFullAccess: ['super_admin', 'consultant_admin', 'consultant', 'client_admin', 'client_employee_head', 'auditor'].includes(role),
      allowedLayers,
      userId: (user._id || user.id).toString(),
    };

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Portfolio guard: auth + role check for cross-client routes (no clientId in params).
 * Sets req.esgSummaryCtx with role and userId so controller can use it.
 */
function checkPortfolioPermission(req, res, next) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ success: false, message: 'Unauthenticated' });

    const role = user.userType;
    if (!['super_admin', 'consultant_admin', 'consultant'].includes(role)) {
      return res.status(403).json({ success: false, message: 'Consultant access only' });
    }

    req.esgSummaryCtx = {
      role,
      clientId:     null,
      isFullAccess: true,
      allowedLayers: ['approved', 'reviewer_pending', 'approver_pending', 'draft'],
      userId:       (user._id || user.id).toString(),
    };

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Restricts a route to consultant_admin, consultant, and super_admin only.
 * Must run after checkEsgSummaryPermission (relies on req.esgSummaryCtx).
 * Used for portfolio-level routes that span multiple clients.
 */
function consultantOnly(req, res, next) {
  const { role } = req.esgSummaryCtx || {};
  if (!['super_admin', 'consultant_admin', 'consultant'].includes(role)) {
    return res.status(403).json({ success: false, message: 'Consultant access only' });
  }
  return next();
}

/**
 * Restricts a route to client_admin and above (plus auditor for read-only audit views).
 * Used for analytics routes not meant for reviewers/approvers/contributors.
 */
function adminAndAbove(req, res, next) {
  const { role } = req.esgSummaryCtx || {};
  if (!['super_admin', 'consultant_admin', 'consultant', 'client_admin', 'client_employee_head', 'auditor'].includes(role)) {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  return next();
}

module.exports = { checkEsgSummaryPermission, computeAllowedLayers, checkPortfolioPermission, consultantOnly, adminAndAbove };
