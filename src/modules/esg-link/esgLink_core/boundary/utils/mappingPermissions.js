'use strict';
/**
 * mappingPermissions.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Permission helpers for ESGLink Core Step 3 — Metric Mapping operations.
 *
 *   canManageMapping(user, clientId)
 *     → super_admin, consultant_admin, consultant assigned to clientId
 *     → Used for: add metric, update mapping, delete mapping
 *
 *   canManageWorkflowDefaults(user, clientId)
 *     → super_admin, consultant_admin only
 *     → Used for: update node-level reviewer/approver defaults
 *
 *   canViewAssignedMetrics(user, clientId)
 *     → super_admin, consultant_admin, consultant assigned to clientId
 *     → Used for: my-assigned-metrics, get one mapping
 *
 * All return { allowed: boolean, reason: string }
 */

const { canManageFlowchart } = require('../../../../../common/utils/Permissions/permissions');

/**
 * canManageMapping
 * Allowed: super_admin, consultant_admin, consultant assigned to clientId
 */
const canManageMapping = async (user, clientId) => {
  if (user.userType === 'super_admin') {
    return { allowed: true, reason: 'Super admin access' };
  }
  if (user.userType === 'consultant_admin') {
    return canManageFlowchart(user, clientId);
  }
  if (user.userType === 'consultant') {
    return canManageFlowchart(user, clientId);
  }
  return { allowed: false, reason: 'Only super_admin, consultant_admin, or assigned consultant can manage mappings' };
};

/**
 * canManageWorkflowDefaults
 * Allowed: super_admin, consultant_admin only
 * Consultants cannot change node-level defaults.
 */
const canManageWorkflowDefaults = async (user, clientId) => {
  if (user.userType === 'super_admin') {
    return { allowed: true, reason: 'Super admin access' };
  }
  if (user.userType === 'consultant_admin') {
    return canManageFlowchart(user, clientId);
  }
  return { allowed: false, reason: 'Only super_admin or consultant_admin can update node workflow defaults' };
};

/**
 * canViewAssignedMetrics
 * Allowed: super_admin, consultant_admin, consultant assigned to clientId,
 *          AND contributor / reviewer / approver belonging to that client.
 * Assignee filtering (which mappings they see) is enforced in the controller.
 */
const canViewAssignedMetrics = async (user, clientId) => {
  // ESGLink workflow users (contributor / reviewer / approver) are the primary
  // audience for this endpoint — they should always be able to view their own assignments.
  const ESG_ASSIGNEE_TYPES = ['contributor', 'reviewer', 'approver'];
  if (ESG_ASSIGNEE_TYPES.includes(user.userType)) {
    if (String(user.clientId) === String(clientId)) {
      return { allowed: true, reason: 'ESGLink assignee access' };
    }
    return { allowed: false, reason: 'User does not belong to this client' };
  }
  // Consultants and admins use the existing manage-mapping check
  return canManageMapping(user, clientId);
};

module.exports = {
  canManageMapping,
  canManageWorkflowDefaults,
  canViewAssignedMetrics,
};
