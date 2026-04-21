'use strict';

// ============================================================================
// permissionExplainer.js — Explains why access was blocked for a domain/section
// Used in error responses and audit logs (not surfaced raw to DeepSeek).
// ============================================================================

const ROLE_LABELS = {
  super_admin:          'Super Admin',
  consultant_admin:     'Consultant Admin',
  consultant:           'Consultant',
  client_admin:         'Client Admin',
  client_employee_head: 'Employee Head',
  employee:             'Employee',
  viewer:               'Viewer',
  auditor:              'Auditor',
  contributor:          'Contributor',
  reviewer:             'Reviewer',
  approver:             'Approver',
};

/**
 * Explain why a role cannot access a domain.
 * @param {string} userType
 * @param {string} domain
 * @returns {string}
 */
function explainDomainBlock(userType, domain) {
  const role = ROLE_LABELS[userType] || userType;
  return `The '${domain}' domain is not accessible to the ${role} role in GreOn IQ.`;
}

/**
 * Explain why greonIQEnabled check failed.
 * @returns {string}
 */
function explainGreonIQDisabled() {
  return 'GreOn IQ has not been enabled for your account. ' +
         'Please contact your administrator or consultant to request access.';
}

/**
 * Explain a quota exhaustion block.
 * @param {'daily'|'weekly'|'monthly'} period
 * @param {Date} resetAt
 * @returns {string}
 */
function explainQuotaExhausted(period, resetAt) {
  const resetStr = resetAt
    ? new Date(resetAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
    : 'next reset';
  return `Your ${period} GreOn IQ credit limit has been reached. ` +
         `Your quota will reset on ${resetStr} IST. ` +
         `You can still view your previous chat history.`;
}

module.exports = {
  explainDomainBlock,
  explainGreonIQDisabled,
  explainQuotaExhausted,
};
