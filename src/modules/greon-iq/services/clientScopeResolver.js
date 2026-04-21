'use strict';

// ============================================================================
// clientScopeResolver.js — Resolves the active clientId for a GreOn IQ request
//
// For consultant_admin / consultant, access is verified in two ways:
//   1. user.assignedClients array (fast, in-memory)
//   2. Client.leadInfo.consultantAdminId / assignedConsultantId / createdBy
//      (DB fallback — covers the case where the consultant_admin created the
//       client and is stored in the Client record but not yet in assignedClients)
// ============================================================================

const Client = require('../../client-management/client/Client');

const SINGLE_CLIENT_ROLES = [
  'client_admin', 'client_employee_head', 'employee',
  'viewer', 'auditor', 'contributor', 'reviewer', 'approver',
];

const MULTI_CLIENT_ROLES = ['super_admin', 'consultant_admin', 'consultant'];

/**
 * Resolve the active clientId for a GreOn IQ request.
 * Async because consultant access may require a DB lookup.
 *
 * @param {object} user           req.user
 * @param {string} [bodyClientId] clientId from request body
 * @returns {Promise<{ clientId: string }|{ error: string, code: string }>}
 */
async function resolveClientScope(user, bodyClientId) {
  const { userType, clientId: userClientId, assignedClients } = user;

  // ── Single-client roles ───────────────────────────────────────────────────
  if (SINGLE_CLIENT_ROLES.includes(userType)) {
    if (!userClientId) {
      return { error: 'Your account is not associated with a client. Contact your administrator.', code: 'NO_CLIENT_SCOPE' };
    }
    return { clientId: userClientId };
  }

  // ── Multi-client roles need explicit clientId ─────────────────────────────
  if (!bodyClientId) {
    return {
      error: 'Please specify a clientId in your request. Your role manages multiple clients — GreOn IQ needs to know which client\'s data to query.',
      code:  'CLIENT_ID_REQUIRED',
    };
  }

  // super_admin: unrestricted access to all clients
  if (userType === 'super_admin') {
    return { clientId: bodyClientId };
  }

  // ── consultant_admin / consultant: check user.assignedClients first ───────
  const assigned = Array.isArray(assignedClients) ? assignedClients : [];
  const inAssignedList = assigned.some((c) => String(c) === String(bodyClientId));
  if (inAssignedList) {
    return { clientId: bodyClientId };
  }

  // ── DB fallback: check Client record directly ─────────────────────────────
  // Covers consultant_admin who created the client (stored in leadInfo.consultantAdminId
  // or leadInfo.createdBy) and consultants assigned via leadInfo.assignedConsultantId.
  try {
    const clientDoc = await Client.findOne(
      { clientId: bodyClientId, isDeleted: { $ne: true } },
      {
        'leadInfo.consultantAdminId':        1,
        'leadInfo.assignedConsultantId':     1,
        'leadInfo.createdBy':                1,
        'workflowTracking.assignedConsultantId': 1,
      }
    ).lean();

    if (clientDoc) {
      const lead     = clientDoc.leadInfo     || {};
      const workflow = clientDoc.workflowTracking || {};
      const userId   = String(user._id);
      const isLinked =
        String(lead.consultantAdminId              || '') === userId ||
        String(lead.assignedConsultantId           || '') === userId ||
        String(lead.createdBy                      || '') === userId ||
        String(workflow.assignedConsultantId       || '') === userId;

      if (isLinked) {
        return { clientId: bodyClientId };
      }
    }
  } catch (err) {
    console.error('[GreOnIQ] clientScopeResolver DB fallback error:', err.message);
  }

  return {
    error: 'You are not assigned to the specified client.',
    code:  'CLIENT_NOT_ASSIGNED',
  };
}

module.exports = { resolveClientScope, SINGLE_CLIENT_ROLES, MULTI_CLIENT_ROLES };
