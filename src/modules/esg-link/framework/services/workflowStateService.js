'use strict';

/**
 * workflowStateService.js
 * Validates answer status transitions against the allowed workflow map.
 *
 * 13-state workflow:
 *   not_started
 *   → in_progress
 *   → submitted_to_reviewer
 *   → reviewer_changes_requested
 *   → resubmitted_to_reviewer
 *   → reviewer_approved
 *   → submitted_to_approver
 *   → approver_query_to_reviewer
 *   → reviewer_response_pending
 *   → contributor_clarification_required
 *   → contributor_clarification_submitted
 *   → (back to reviewer_response_pending)
 *   → (back to submitted_to_approver)
 *   → final_approved
 *   → locked
 */

// Each entry: { from: [...statuses], to: targetStatus, allowedRoles: [...userTypes] }
const TRANSITIONS = [
  {
    from:         ['not_started'],
    to:           'in_progress',
    allowedRoles: ['contributor', 'consultant', 'client_admin', 'consultant_admin', 'super_admin'],
  },
  {
    from:         ['in_progress'],
    to:           'submitted_to_reviewer',
    allowedRoles: ['contributor', 'consultant', 'client_admin', 'consultant_admin', 'super_admin'],
  },
  {
    from:         ['submitted_to_reviewer'],
    to:           'reviewer_changes_requested',
    allowedRoles: ['reviewer', 'consultant_admin', 'super_admin'],
  },
  {
    from:         ['submitted_to_reviewer', 'resubmitted_to_reviewer'],
    to:           'reviewer_approved',
    allowedRoles: ['reviewer', 'consultant_admin', 'super_admin'],
  },
  {
    from:         ['reviewer_changes_requested'],
    to:           'resubmitted_to_reviewer',
    allowedRoles: ['contributor', 'consultant', 'client_admin', 'super_admin'],
  },
  {
    from:         ['reviewer_approved'],
    to:           'submitted_to_approver',
    allowedRoles: ['reviewer', 'consultant_admin', 'super_admin'],
  },
  {
    from:         ['submitted_to_approver'],
    to:           'approver_query_to_reviewer',
    allowedRoles: ['approver', 'super_admin'],
  },
  {
    from:         ['approver_query_to_reviewer'],
    to:           'reviewer_response_pending',
    allowedRoles: ['reviewer', 'consultant_admin', 'super_admin'],
  },
  {
    from:         ['reviewer_response_pending'],
    to:           'contributor_clarification_required',
    allowedRoles: ['reviewer', 'consultant_admin', 'super_admin'],
  },
  {
    from:         ['contributor_clarification_required'],
    to:           'contributor_clarification_submitted',
    allowedRoles: ['contributor', 'consultant', 'client_admin', 'super_admin'],
  },
  {
    from:         ['contributor_clarification_submitted'],
    to:           'reviewer_response_pending',
    allowedRoles: ['reviewer', 'consultant_admin', 'super_admin'],
  },
  {
    from:         ['reviewer_response_pending'],
    to:           'submitted_to_approver',
    allowedRoles: ['reviewer', 'consultant_admin', 'super_admin'],
  },
  {
    from:         ['submitted_to_approver'],
    to:           'final_approved',
    allowedRoles: ['approver', 'super_admin'],
  },
  {
    from:         ['final_approved'],
    to:           'locked',
    allowedRoles: ['super_admin', 'consultant_admin'],
  },
];

/**
 * validateTransition
 * @param {string} currentStatus
 * @param {string} targetStatus
 * @param {string} actorRole      - user.userType
 * @returns {{ valid: boolean, reason: string }}
 */
const validateTransition = (currentStatus, targetStatus, actorRole) => {
  const match = TRANSITIONS.find(
    (t) => t.from.includes(currentStatus) && t.to === targetStatus
  );

  if (!match) {
    return {
      valid:  false,
      reason: `Transition from "${currentStatus}" to "${targetStatus}" is not defined in the workflow`,
    };
  }

  if (!match.allowedRoles.includes(actorRole)) {
    return {
      valid:  false,
      reason: `Role "${actorRole}" is not permitted to move an answer from "${currentStatus}" to "${targetStatus}"`,
    };
  }

  return { valid: true, reason: 'Transition allowed' };
};

/**
 * getAllowedNextStatuses
 * Returns the list of valid target statuses from a given current status.
 * @param {string} currentStatus
 * @returns {string[]}
 */
const getAllowedNextStatuses = (currentStatus) =>
  TRANSITIONS.filter((t) => t.from.includes(currentStatus)).map((t) => t.to);

module.exports = { validateTransition, getAllowedNextStatuses };
