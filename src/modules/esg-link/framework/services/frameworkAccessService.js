'use strict';

const { canManageFlowchart } = require('../../../../common/utils/Permissions/permissions');

/**
 * canManageFrameworkLibrary
 * Manage Framework master records (create, activate, retire).
 * Allowed: super_admin only.
 */
const canManageFrameworkLibrary = (user) => {
  if (user.userType === 'super_admin') {
    return { allowed: true, reason: 'Super admin access' };
  }
  return { allowed: false, reason: 'Only super_admin can manage the framework library' };
};

/**
 * canManageFrameworkQuestion
 * Create / edit / submit questions in the library.
 * Allowed: super_admin, consultant_admin.
 */
const canManageFrameworkQuestion = (user) => {
  if (user.userType === 'super_admin' || user.userType === 'consultant_admin') {
    return { allowed: true, reason: 'Admin access' };
  }
  return { allowed: false, reason: 'Only super_admin or consultant_admin can manage framework questions' };
};

/**
 * canSubmitQuestion
 * Submit a draft question for approval.
 * Allowed: consultant_admin.
 */
const canSubmitQuestion = (user) => {
  if (user.userType === 'consultant_admin') {
    return { allowed: true, reason: 'Consultant admin can submit questions for approval' };
  }
  if (user.userType === 'super_admin') {
    return { allowed: true, reason: 'Super admin access' };
  }
  return { allowed: false, reason: 'Only consultant_admin or super_admin can submit questions' };
};

/**
 * canApproveQuestion
 * Approve / reject / publish submitted questions.
 * Allowed: super_admin only.
 */
const canApproveQuestion = (user) => {
  if (user.userType === 'super_admin') {
    return { allowed: true, reason: 'Super admin can approve questions' };
  }
  return { allowed: false, reason: 'Only super_admin can approve questions' };
};

/**
 * canActivateClientFramework
 * Activate a framework instance for a client.
 * Allowed: super_admin, consultant_admin.
 * @returns {Promise<{ allowed, reason }>}
 */
const canActivateClientFramework = async (user, clientId) => {
  if (user.userType === 'super_admin' || user.userType === 'consultant_admin') {
    return { allowed: true, reason: 'Admin access' };
  }
  return { allowed: false, reason: 'Only super_admin or consultant_admin can activate client frameworks' };
};

/**
 * canAssignQuestion
 * Create / update question assignments for a client.
 * Allowed: super_admin, consultant_admin, consultant assigned to client.
 * @returns {Promise<{ allowed, reason }>}
 */
const canAssignQuestion = async (user, clientId) => {
  if (user.userType === 'super_admin' || user.userType === 'consultant_admin') {
    return { allowed: true, reason: 'Admin access' };
  }
  if (user.userType === 'consultant') {
    return canManageFlowchart(user, clientId);
  }
  return { allowed: false, reason: 'Insufficient permissions to assign questions' };
};

/**
 * canAnswerQuestion
 * Save / submit answers for a client.
 * Allowed: contributor, consultant (assigned), client_admin (own client).
 * @returns {Promise<{ allowed, reason }>}
 */
const canAnswerQuestion = async (user, clientId) => {
  if (user.userType === 'super_admin' || user.userType === 'consultant_admin') {
    return { allowed: true, reason: 'Admin access' };
  }
  if (user.userType === 'consultant') {
    return canManageFlowchart(user, clientId);
  }
  if (user.userType === 'client_admin') {
    const userClientId = user.clientId ? String(user.clientId) : null;
    if (userClientId && userClientId === String(clientId)) {
      return { allowed: true, reason: 'Client admin answering for own client' };
    }
    return { allowed: false, reason: 'Client admin can only answer for their own client' };
  }
  if (user.userType === 'contributor') {
    // contributor access is enforced via QuestionAssignment — allow here, filter in controller
    return { allowed: true, reason: 'Contributor access' };
  }
  return { allowed: false, reason: 'Insufficient permissions to answer questions' };
};

/**
 * canReviewAnswer
 * Post reviewer comments and transitions.
 * Allowed: reviewer role.
 */
const canReviewAnswer = (user) => {
  if (user.userType === 'reviewer' || user.userType === 'super_admin' || user.userType === 'consultant_admin') {
    return { allowed: true, reason: 'Reviewer access' };
  }
  return { allowed: false, reason: 'Only reviewers can review answers' };
};

/**
 * canApproveAnswer
 * Post approver decisions and final approval.
 * Allowed: approver role.
 */
const canApproveAnswer = (user) => {
  if (user.userType === 'approver' || user.userType === 'super_admin') {
    return { allowed: true, reason: 'Approver access' };
  }
  return { allowed: false, reason: 'Only approvers can approve answers' };
};

/**
 * canViewClientBrsr
 * Read client BRSR data (questions, answers, assignments, readiness).
 * Allowed: all roles with client access.
 * @returns {Promise<{ allowed, reason }>}
 */
const canViewClientBrsr = async (user, clientId) => {
  if (user.userType === 'super_admin' || user.userType === 'consultant_admin') {
    return { allowed: true, reason: 'Admin access' };
  }
  if (user.userType === 'consultant') {
    return canManageFlowchart(user, clientId);
  }
  if (user.userType === 'client_admin' || user.userType === 'contributor' || user.userType === 'reviewer' || user.userType === 'approver') {
    const userClientId = user.clientId ? String(user.clientId) : null;
    if (userClientId && userClientId === String(clientId)) {
      return { allowed: true, reason: 'Client user accessing own client data' };
    }
    return { allowed: false, reason: 'Can only view own client BRSR data' };
  }
  return { allowed: false, reason: 'Insufficient permissions to view client BRSR data' };
};

/**
 * canConsultantFinalApprove
 * Approve metric data and perform the final bulk approval that closes a reporting year.
 * Allowed: the consultant currently assigned to the client, consultant_admin, super_admin.
 * @returns {Promise<{ allowed, reason }>}
 */
const canConsultantFinalApprove = async (user, clientId) => {
  if (user.userType === 'super_admin' || user.userType === 'consultant_admin') {
    return { allowed: true, reason: 'Admin access' };
  }
  if (user.userType === 'consultant') {
    return canManageFlowchart(user, clientId);
  }
  return { allowed: false, reason: 'Only the assigned consultant, consultant_admin, or super_admin can perform final approval' };
};

module.exports = {
  canManageFrameworkLibrary,
  canManageFrameworkQuestion,
  canSubmitQuestion,
  canApproveQuestion,
  canActivateClientFramework,
  canAssignQuestion,
  canAnswerQuestion,
  canReviewAnswer,
  canApproveAnswer,
  canViewClientBrsr,
  canConsultantFinalApprove,
};
