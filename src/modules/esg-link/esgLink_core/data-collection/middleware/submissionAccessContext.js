'use strict';

/**
 * submissionAccessContext middleware
 *
 * Attaches req.submissionAccessCtx to every request. Resolves the current
 * user's access level for ESG data collection within the given clientId.
 *
 * Access levels:
 *   isFullAccess: true   — super_admin, consultant_admin (for client), consultant (assigned)
 *   isFullAccess: false  — contributor / reviewer / approver (own mappings only)
 *   isViewOnly: true     — client_admin (read-only, all submissions for own client)
 *   denied: true         — user has no valid role for this client
 *
 * For restricted roles, resolvedAssignments is set (mappingIds the user is
 * assigned to).  Controllers apply this as a mongo filter on mappingId.
 */

const EsgLinkBoundary = require('../../boundary/models/EsgLinkBoundary');
const { isConsultantForClient, isConsultantAdminForClient } = require('../utils/submissionPermissions');

const FULL_ACCESS_ROLES = ['super_admin', 'consultant_admin', 'consultant'];
const ASSIGNEE_ROLES    = ['contributor', 'reviewer', 'approver'];

/**
 * Resolve which mappingIds a contributor/reviewer/approver is assigned to
 * within the client's active boundary.
 */
async function resolveAssignedMappings(userId, userType, clientId) {
  const boundary = await EsgLinkBoundary.findOne({ clientId, isActive: true, isDeleted: false });
  if (!boundary || !boundary.nodes) return [];

  const uid = userId.toString();
  const assigned = [];

  for (const node of boundary.nodes) {
    for (const mapping of node.metricsDetails || []) {
      let inList = false;
      if (userType === 'contributor') {
        inList = (mapping.contributors || []).some((id) => id && id.toString() === uid);
      } else if (userType === 'reviewer') {
        const reviewers = mapping.inheritNodeReviewers
          ? node.nodeReviewerIds || []
          : mapping.reviewers || [];
        inList = reviewers.some((id) => id && id.toString() === uid);
      } else if (userType === 'approver') {
        const approvers = mapping.inheritNodeApprovers
          ? node.nodeApproverIds || []
          : mapping.approvers || [];
        inList = approvers.some((id) => id && id.toString() === uid);
      }
      if (inList && mapping._id) {
        assigned.push(mapping._id.toString());
      }
    }
  }

  return assigned;
}

/**
 * Express middleware — attaches req.submissionAccessCtx.
 * Call AFTER auth middleware.
 */
async function attachSubmissionAccessContext(req, res, next) {
  try {
    const user     = req.user;
    const clientId = req.params.clientId;

    if (!user || !clientId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    // ── Super admin: full access to everything ────────────────────────────────
    if (user.userType === 'super_admin') {
      req.submissionAccessCtx = { isFullAccess: true, isViewOnly: false, role: 'super_admin' };
      return next();
    }

    // ── Consultant admin: full access to managed clients ─────────────────────
    if (user.userType === 'consultant_admin' && await isConsultantAdminForClient(user, clientId)) {
      req.submissionAccessCtx = { isFullAccess: true, isViewOnly: false, role: 'consultant_admin' };
      return next();
    }

    // ── Consultant: full access to assigned clients ───────────────────────────
    if (user.userType === 'consultant' && await isConsultantForClient(user, clientId)) {
      req.submissionAccessCtx = { isFullAccess: true, isViewOnly: false, role: 'consultant' };
      return next();
    }

    // ── Client admin: view only ───────────────────────────────────────────────
    if (user.userType === 'client_admin' && user.clientId === clientId) {
      req.submissionAccessCtx = { isFullAccess: false, isViewOnly: true, role: 'client_admin' };
      return next();
    }

    // ── Contributor / Reviewer / Approver: mapping-scoped ────────────────────
    if (ASSIGNEE_ROLES.includes(user.userType)) {
      // Verify user belongs to this client
      const userClientId = user.clientId || user.clientId;
      if (userClientId && userClientId !== clientId) {
        return res.status(403).json({ success: false, message: 'Access denied for this client' });
      }

      const assignedMappingIds = await resolveAssignedMappings(
        user._id || user.id,
        user.userType,
        clientId
      );

      if (assignedMappingIds.length === 0) {
        return res
          .status(403)
          .json({ success: false, message: 'No assigned mappings found for this client' });
      }

      req.submissionAccessCtx = {
        isFullAccess:       false,
        isViewOnly:         false,
        role:               user.userType,
        assignedMappingIds: new Set(assignedMappingIds),
      };
      return next();
    }

    return res.status(403).json({ success: false, message: 'Access denied' });
  } catch (err) {
    console.error('[submissionAccessContext] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Access context resolution failed' });
  }
}

module.exports = { attachSubmissionAccessContext, resolveAssignedMappings };
