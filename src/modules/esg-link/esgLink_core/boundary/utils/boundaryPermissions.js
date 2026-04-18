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
 * More permissive — allows client users to view boundary.
 * For now, same as canManageBoundary. Expand later if client-read needed.
 */
const canViewBoundary = async (user, clientId) => {
  return canManageFlowchart(user, clientId);
};

module.exports = { canManageBoundary, canViewBoundary };
