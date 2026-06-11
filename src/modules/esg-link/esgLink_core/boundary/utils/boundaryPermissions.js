'use strict';
/**
 * boundaryPermissions.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Permission helpers for ESGLink Core boundary operations.
 * Reuses the same consultant/consultant_admin/super_admin logic as ZeroCarbon.
 */

const { canManageFlowchart } = require('../../../../../common/utils/Permissions/permissions');

/**
 * canManageBoundary
 * Returns { allowed: boolean, reason: string }
 * Allowed roles: super_admin, consultant_admin (own clients), consultant (assigned)
 *
 * Delegates to canManageFlowchart since the permission model is identical.
 */
const canManageBoundary = async (user, clientId) => {
  return canManageFlowchart(user, clientId);
};

/**
 * canViewBoundary
 * More permissive — allows client_admin to read their own boundary.
 * Write operations still require canManageBoundary (consultant/admin roles).
 */
const canViewBoundary = async (user, clientId) => {
  // client_admin can always view their own boundary
  if (user.userType === 'client_admin' && user.clientId === clientId) {
    return { allowed: true, reason: 'Client admin viewing own boundary' };
  }
  return canManageFlowchart(user, clientId);
};

module.exports = { canManageBoundary, canViewBoundary };
