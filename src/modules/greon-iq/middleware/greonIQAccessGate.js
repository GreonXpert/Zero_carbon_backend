'use strict';

// ============================================================================
// greonIQAccessGate.js — Route-level role gate for all GreOn IQ endpoints
//
// Roles with access:
//   unlimited: super_admin, consultant_admin
//   credited:  consultant, client_admin, client_employee_head
//
// All other roles are blocked here with 403 GREON_IQ_ROLE_BLOCKED.
// ============================================================================

const BLOCKED_ROLES = new Set([
  'employee',
  'contributor',
  'reviewer',
  'approver',
  'support',
  'supportManager',
  'auditor',
  'viewer',
]);

module.exports = function greonIQAccessGate(req, res, next) {
  if (BLOCKED_ROLES.has(req.user?.userType)) {
    return res.status(403).json({
      success: false,
      code:    'GREON_IQ_ROLE_BLOCKED',
      message: 'Your role does not have access to GreOn IQ.',
    });
  }
  next();
};
