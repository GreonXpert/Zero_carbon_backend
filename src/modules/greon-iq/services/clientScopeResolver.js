'use strict';

// ============================================================================
// clientScopeResolver.js — Resolves the active clientId for a GreOn IQ request
//
// For single-client roles the clientId always comes from user.clientId.
//
// For multi-client roles (super_admin, consultant_admin, consultant):
//   1. If bodyClientId provided → validate authority and return it.
//   2. If no bodyClientId → return { needsClientResolution: true, accessibleClients }
//      so the caller can return an inline chat prompt rather than an HTTP error.
//
// resolveAccessibleClients(user) — returns the list of clients a multi-client
// role is allowed to query, used to populate the inline client-selection prompt.
// ============================================================================

const Client = require('../../client-management/client/Client');

// companyName lives at leadInfo.companyName, not at the document root.
function _toClientEntry(c) {
  return {
    clientId:    c.clientId,
    companyName: c.leadInfo?.companyName || c.clientId,
  };
}

const SINGLE_CLIENT_ROLES = [
  'client_admin', 'client_employee_head', 'employee',
  'viewer', 'auditor', 'contributor', 'reviewer', 'approver',
];

const MULTI_CLIENT_ROLES = ['super_admin', 'consultant_admin', 'consultant'];

/**
 * Resolve the active clientId for a GreOn IQ request.
 *
 * @param {object} user           req.user
 * @param {string} [bodyClientId] clientId from request body / query
 * @returns {Promise<
 *   { clientId: string } |
 *   { needsClientResolution: true, accessibleClients: Array<{clientId,companyName}> } |
 *   { error: string, code: string }
 * >}
 */
async function resolveClientScope(user, bodyClientId) {
  const { userType, clientId: userClientId, assignedClients } = user;

  // ── Single-client roles ───────────────────────────────────────────────────
  if (SINGLE_CLIENT_ROLES.includes(userType)) {
    if (!userClientId) {
      return {
        error: 'Your account is not associated with a client. Contact your administrator.',
        code:  'NO_CLIENT_SCOPE',
      };
    }
    // If the request explicitly targets a DIFFERENT client, flag it so the
    // controller can return a clear restriction message instead of silently
    // ignoring the mismatch and returning the user's own data.
    if (bodyClientId && String(bodyClientId) !== String(userClientId)) {
      return {
        clientId:           userClientId,   // still their own – used if caller decides to continue
        crossClientAttempt: String(bodyClientId),
      };
    }
    return { clientId: userClientId };
  }

  // ── Multi-client role: explicit clientId provided ─────────────────────────
  if (bodyClientId) {
    // super_admin: unrestricted
    if (userType === 'super_admin') {
      return { clientId: bodyClientId };
    }

    // consultant_admin / consultant: check assignedClients first
    const assigned = Array.isArray(assignedClients) ? assignedClients : [];
    const inList   = assigned.some((c) => String(c) === String(bodyClientId));
    if (inList) return { clientId: bodyClientId };

    // DB fallback — covers consultant_admin who created the client
    try {
      const clientDoc = await Client.findOne(
        { clientId: bodyClientId, isDeleted: { $ne: true } },
        {
          'leadInfo.consultantAdminId':            1,
          'leadInfo.assignedConsultantId':         1,
          'leadInfo.createdBy':                    1,
          'workflowTracking.assignedConsultantId': 1,
        }
      ).lean();

      if (clientDoc) {
        const lead     = clientDoc.leadInfo         || {};
        const workflow = clientDoc.workflowTracking || {};
        const userId   = String(user._id);
        const isLinked =
          String(lead.consultantAdminId              || '') === userId ||
          String(lead.assignedConsultantId           || '') === userId ||
          String(lead.createdBy                      || '') === userId ||
          String(workflow.assignedConsultantId       || '') === userId;

        if (isLinked) return { clientId: bodyClientId };
      }
    } catch (err) {
      console.error('[GreOnIQ] clientScopeResolver DB fallback error:', err.message);
    }

    return { error: 'You are not assigned to the specified client.', code: 'CLIENT_NOT_ASSIGNED' };
  }

  // ── Multi-client role: no clientId provided → ask inline ─────────────────
  const accessibleClients = await resolveAccessibleClients(user);
  return { needsClientResolution: true, accessibleClients };
}

/**
 * Return the list of clients a multi-client role may query.
 * Used to build the inline "which client?" chat prompt.
 *
 * @param {object} user  req.user
 * @returns {Promise<Array<{ clientId: string, companyName: string }>>}
 */
async function resolveAccessibleClients(user) {
  const { userType, assignedClients = [] } = user;

  try {
    if (userType === 'super_admin') {
      const clients = await Client.find(
        { isDeleted: { $ne: true }, status: { $ne: 'inactive' } },
        { clientId: 1, 'leadInfo.companyName': 1 }
      ).sort({ 'leadInfo.companyName': 1 }).limit(50).lean();
      return clients.map(_toClientEntry);
    }

    // consultant_admin / consultant: build from assignedClients + DB-linked
    const clientIdSet = new Set(assignedClients.map(String));

    // Also pick up clients linked via leadInfo
    const dbLinked = await Client.find(
      {
        isDeleted: { $ne: true },
        $or: [
          { 'leadInfo.consultantAdminId':            user._id },
          { 'leadInfo.assignedConsultantId':         user._id },
          { 'leadInfo.createdBy':                    user._id },
          { 'workflowTracking.assignedConsultantId': user._id },
        ],
      },
      { clientId: 1, 'leadInfo.companyName': 1 }
    ).lean();

    for (const c of dbLinked) clientIdSet.add(String(c.clientId));

    if (clientIdSet.size === 0) return [];

    const allClientIds = [...clientIdSet];
    const docs = await Client.find(
      { clientId: { $in: allClientIds }, isDeleted: { $ne: true } },
      { clientId: 1, 'leadInfo.companyName': 1 }
    ).sort({ 'leadInfo.companyName': 1 }).lean();

    return docs.map(_toClientEntry);
  } catch (err) {
    console.error('[GreOnIQ] resolveAccessibleClients error:', err.message);
    return [];
  }
}

module.exports = { resolveClientScope, resolveAccessibleClients, SINGLE_CLIENT_ROLES, MULTI_CLIENT_ROLES };
