'use strict';

/**
 * Permission helpers for ESG Link Data Collection.
 *
 * isConsultantForClient / isConsultantAdminForClient query the Client
 * collection so that consultant assignment is always authoritative from
 * the client record (leadInfo.assignedConsultantId / consultantAdminId).
 * All can* helpers are therefore async.
 */

const mongoose = require('mongoose');
const Client   = require('../../../../client-management/client/Client');
const User     = require('../../../../../common/models/User');

const ADMIN_ROLES   = ['super_admin', 'consultant_admin'];
const MANAGER_ROLES = ['super_admin', 'consultant_admin', 'consultant'];

// ── Check consultant assignment via Client collection ─────────────────────────

async function isConsultantForClient(user, clientId) {
  if (!user || user.userType !== 'consultant') return false;
  const uid = (user._id || user.id).toString();
  const client = await Client.findOne({
    clientId,
    $or: [
      { 'leadInfo.assignedConsultantId':        uid },
      { 'workflowTracking.assignedConsultantId': uid },
    ],
  }).select('_id').lean();
  return !!client;
}

async function isConsultantAdminForClient(user, clientId) {
  if (!user) return false;
  if (user.userType === 'super_admin') return true;
  if (user.userType !== 'consultant_admin') return false;

  const uid    = user._id || user.id;
  const uidStr = uid.toString();

  // Mirrors the getClients() query for consultant_admin:
  // admin can act on clients where they are directly assigned OR where any
  // consultant they manage is assigned (leadInfo or workflowTracking).
  const managedConsultants = await User.find({ consultantAdminId: uid }).select('_id').lean();
  const managedIds = managedConsultants.map((c) => c._id);
  if (mongoose.Types.ObjectId.isValid(uidStr)) {
    managedIds.push(new mongoose.Types.ObjectId(uidStr));
  }

  const client = await Client.findOne({
    clientId,
    $or: [
      { 'leadInfo.consultantAdminId':              { $in: [uidStr, ...managedIds] } },
      { 'leadInfo.assignedConsultantId':            { $in: managedIds } },
      { 'workflowTracking.assignedConsultantId':    { $in: managedIds } },
    ],
  }).select('_id').lean();
  return !!client;
}

// ── Helper: check if userId appears in an assignee array ─────────────────────
// entries can be plain ObjectIds/strings OR populated objects { _id, userName, ... }
function isInList(userId, list = []) {
  if (!userId || !Array.isArray(list)) return false;
  const uid = userId.toString();
  return list.some((entry) => {
    if (!entry) return false;
    const id = entry._id ? entry._id : entry;
    return id.toString() === uid;
  });
}

/**
 * canSubmit — contributor assigned to mapping, or admin-level override.
 */
async function canSubmit(user, mapping, clientId) {
  if (!user) return false;
  if (user.userType === 'super_admin') return true;
  if (user.userType === 'consultant_admin') return isConsultantAdminForClient(user, clientId);
  if (user.userType === 'consultant')       return isConsultantForClient(user, clientId);
  if (user.userType === 'contributor') {
    return isInList(user._id || user.id, mapping?.contributors || []);
  }
  // API/IoT keys are pre-authorized by esgApiKeyAuth middleware (key is scoped to the mapping)
  if (user.userType === 'api_integration' || user.userType === 'iot_integration') return true;
  return false;
}

/**
 * canReview — reviewer assigned to mapping (with inheritNodeReviewers), or
 *             consultant assigned to client, or consultant_admin / super_admin.
 */
async function canReview(user, mapping, resolvedReviewers, clientId) {
  if (!user) return false;
  if (user.userType === 'super_admin') return true;
  if (await isConsultantAdminForClient(user, clientId)) return true;
  if (user.userType === 'consultant') return isConsultantForClient(user, clientId);
  if (user.userType === 'reviewer') {
    return isInList(user._id || user.id, resolvedReviewers || []);
  }
  return false;
}

/**
 * canApprove — approver in resolved approvers list, or consultant_admin / super_admin.
 * Consultants CANNOT approve (by design).
 */
async function canApprove(user, mapping, resolvedApprovers, clientId) {
  if (!user) return false;
  if (user.userType === 'super_admin') return true;
  if (await isConsultantAdminForClient(user, clientId)) return true;
  if (user.userType === 'approver') {
    return isInList(user._id || user.id, resolvedApprovers || []);
  }
  return false;
}

/**
 * canComment — reviewer or approver (or admin) can post thread comments.
 */
async function canComment(user, mapping, resolvedReviewers, resolvedApprovers, clientId) {
  return (
    (await canReview(user, mapping, resolvedReviewers, clientId)) ||
    (await canApprove(user, mapping, resolvedApprovers, clientId))
  );
}

/**
 * canReply — contributor assigned to mapping (or admin).
 */
async function canReply(user, mapping, clientId) {
  return canSubmit(user, mapping, clientId);
}

/**
 * canViewSubmission — any assigned party OR client_admin (view-only).
 */
async function canViewSubmission(user, mapping, resolvedReviewers, resolvedApprovers, clientId) {
  if (!user) return false;
  if (user.userType === 'client_admin' && user.clientId === clientId) return true;
  return (
    (await canSubmit(user, mapping, clientId)) ||
    (await canReview(user, mapping, resolvedReviewers, clientId)) ||
    (await canApprove(user, mapping, resolvedApprovers, clientId))
  );
}

/**
 * canManageApiKey — consultant, consultant_admin, super_admin.
 */
async function canManageApiKey(user, clientId) {
  if (!user) return false;
  if (user.userType === 'super_admin') return true;
  if (await isConsultantAdminForClient(user, clientId)) return true;
  if (user.userType === 'consultant') return isConsultantForClient(user, clientId);
  return false;
}

/**
 * canReadApiKeys — read-only access to key list / details.
 * Includes all canManageApiKey roles PLUS contributor and client_admin for their own client.
 * Contributors need this to see connection status on their My Tasks cards.
 */
async function canReadApiKeys(user, clientId) {
  if (!user) return false;
  if (await canManageApiKey(user, clientId)) return true;
  if (user.userType === 'contributor' && user.clientId === clientId) return true;
  if (user.userType === 'client_admin'  && user.clientId === clientId) return true;
  return false;
}

/**
 * canImport — contributor (assigned to at least one mapping), consultant, consultant_admin, super_admin.
 * Security: submissionService.create() enforces canSubmit per-row, so contributor access
 * here just allows them through the gate; they cannot import rows they are not assigned to.
 */
async function canImport(user, clientId) {
  if (!user) return false;
  if (user.userType === 'super_admin') return true;
  if (await isConsultantAdminForClient(user, clientId)) return true;
  if (user.userType === 'consultant') return isConsultantForClient(user, clientId);
  // Contributors are allowed — per-row canSubmit in submissionService.create is the security gate
  if (user.userType === 'contributor') return true;
  return false;
}

module.exports = {
  canSubmit,
  canReview,
  canApprove,
  canComment,
  canReply,
  canViewSubmission,
  canManageApiKey,
  canReadApiKeys,
  canImport,
  isConsultantForClient,
  isConsultantAdminForClient,
  isInList,
};
