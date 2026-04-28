'use strict';

// ============================================================================
// M3 Permission Helper
// Wraps the repo's existing canManageFlowchart + adds M3-specific role guards
// ============================================================================

const { canManageFlowchart } = require('../../../../common/utils/Permissions/permissions');
const { ERRORS } = require('../constants/messages');

const WRITE_ROLES = new Set(['consultant_admin', 'consultant', 'client_admin', 'super_admin']);
// consultant_admin, client_admin, and consultant may approve allocations
const APPROVE_DENIED_ROLES = new Set(['full_user', 'team_user']);

/**
 * Throws HTTP-friendly error if the user cannot write for this clientId.
 * Reuses the existing canManageFlowchart ownership logic.
 */
async function assertWriteAccess(req, clientId) {
  if (!WRITE_ROLES.has(req.user.userType)) {
    const err = new Error(ERRORS.READ_ONLY_ROLE);
    err.status = 403;
    throw err;
  }
  // client_admin has full write access to their own client — canManageFlowchart doesn't handle this role
  if (req.user.userType === 'client_admin') {
    if (req.user.clientId !== clientId) {
      const err = new Error('Permission denied: client admin can only manage their own client.');
      err.status = 403;
      throw err;
    }
    return;
  }
  const perm = await canManageFlowchart(req.user, clientId);
  if (!perm.allowed) {
    const err = new Error(perm.reason || 'Permission denied');
    err.status = 403;
    throw err;
  }
}

/**
 * Throws 403 if the user is in a role that cannot approve targets or allocations.
 */
function assertCanApprove(req) {
  if (APPROVE_DENIED_ROLES.has(req.user.userType)) {
    const err = new Error(ERRORS.CONSULTANT_CANNOT_APPROVE);
    err.status = 403;
    throw err;
  }
}

/**
 * Throws 403 if a Team User tries to draft allocations.
 */
function assertCanDraftAllocation(req) {
  if (req.user.userType === 'team_user') {
    const err = new Error(ERRORS.TEAM_USER_NO_ALLOCATION);
    err.status = 403;
    throw err;
  }
}

/**
 * Throws 403 if the user cannot manage org-level settings (only client_admin / consultant_admin).
 */
function assertCanManageSettings(req) {
  const allowed = new Set(['client_admin', 'consultant_admin', 'super_admin']);
  if (!allowed.has(req.user.userType)) {
    const err = new Error('Only Client Admin or Consultant Admin can manage settings.');
    err.status = 403;
    throw err;
  }
}

/**
 * Reads clientId from query, params, or body — whichever is present.
 */
function resolveClientId(req) {
  return req.params.clientId || req.query.clientId || req.body.clientId || req.user.clientId;
}

module.exports = {
  assertWriteAccess,
  assertCanApprove,
  assertCanDraftAllocation,
  assertCanManageSettings,
  resolveClientId,
};
