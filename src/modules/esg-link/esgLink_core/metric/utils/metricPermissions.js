'use strict';
/**
 * metricPermissions.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Permission helpers for ESGLink Core Metric Library operations.
 *
 * Three helper functions are exported:
 *
 *   canManageGlobalMetric(user)
 *     → super_admin or consultant_admin
 *     → Used for: create / update / publish / retire / delete global metrics
 *
 *   canManageClientMetric(user, clientId)
 *     → super_admin, consultant_admin, or consultant assigned to clientId
 *     → Used for: create / update / retire client-scoped custom metrics
 *
 *   canViewClientMetrics(user, clientId)
 *     → all of canManageClientMetric + client_admin viewing their own client
 *     → Used for: list and get metric by ID for client-scoped metrics
 *
 * All async functions return { allowed: boolean, reason: string }
 * to match the pattern established by canManageBoundary.
 */

const { canManageFlowchart } = require('../../../../../common/utils/Permissions/permissions');

/**
 * canManageGlobalMetric
 * Allowed: super_admin, consultant_admin
 * @param {object} user - req.user
 * @returns {{ allowed: boolean, reason: string }}
 */
const canManageGlobalMetric = (user) => {
  if (user.userType === 'super_admin') {
    return { allowed: true, reason: 'Super admin access' };
  }
  if (user.userType === 'consultant_admin') {
    return { allowed: true, reason: 'Consultant admin access' };
  }
  return { allowed: false, reason: 'Only super_admin or consultant_admin can manage global metrics' };
};

/**
 * canManageClientMetric
 * Allowed: super_admin, consultant_admin, consultant assigned to clientId
 * @param {object} user     - req.user
 * @param {string} clientId - client string ID (e.g. "Greon008")
 * @returns {Promise<{ allowed: boolean, reason: string }>}
 */
const canManageClientMetric = async (user, clientId) => {
  // super_admin and consultant_admin always allowed
  const globalCheck = canManageGlobalMetric(user);
  if (globalCheck.allowed) return globalCheck;

  // consultant: must be assigned to the client (reuse canManageFlowchart logic)
  if (user.userType === 'consultant') {
    return canManageFlowchart(user, clientId);
  }

  return { allowed: false, reason: 'Insufficient permissions to manage client metrics' };
};

/**
 * canViewClientMetrics
 * Allowed: all of canManageClientMetric + client_admin for their own client
 * @param {object} user     - req.user
 * @param {string} clientId - client string ID
 * @returns {Promise<{ allowed: boolean, reason: string }>}
 */
const canViewClientMetrics = async (user, clientId) => {
  // client_admin can view their own client's metrics
  if (user.userType === 'client_admin') {
    const userClientId = user.clientId ? String(user.clientId) : null;
    if (userClientId && userClientId === String(clientId)) {
      return { allowed: true, reason: 'Client admin viewing own client metrics' };
    }
    return { allowed: false, reason: 'Client admin can only view their own client metrics' };
  }

  // All manage roles can also view
  return canManageClientMetric(user, clientId);
};

/**
 * canApproveMetricChange
 * Allowed: super_admin only — reviews pending global metric approval requests
 * @param {object} user - req.user
 * @returns {{ allowed: boolean, reason: string }}
 */
const canApproveMetricChange = (user) => {
  if (user.userType === 'super_admin') {
    return { allowed: true, reason: 'Super admin access' };
  }
  return { allowed: false, reason: 'Only super_admin can approve or reject global metric change requests' };
};

module.exports = {
  canManageGlobalMetric,
  canManageClientMetric,
  canViewClientMetrics,
  canApproveMetricChange,
};
