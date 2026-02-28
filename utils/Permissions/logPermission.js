'use strict';
// utils/Permissions/logPermission.js
//
// PURPOSE:
//   Role-based permission helpers for the AuditLog module.
//
// ─── ROLE ACCESS SUMMARY ──────────────────────────────────────────────────────
//
//   super_admin         → all logs, all clients, all modules (unrestricted)
//
//   consultant_admin    → own activity logs (actorUserId = self)
//                       + all consultant logs under them (actorUserId in team)
//                       + all logs for clients they manage (clientId in managed)
//                       → includes 'auth' module
//
//   consultant          → logs for their assigned clients only (clientId in assigned)
//                       → includes 'auth' module
//
//   client_admin        → logs within own org (clientId = own)
//                       → only actorUserTypes: client_employee_head, employee,
//                          viewer, auditor
//                       → excludes 'auth' module
//
//   client_employee_head → own logs + their assigned employees' logs
//                        → actorUserId scoped to self + team employees
//                        → excludes 'auth' module
//
//   employee            → NO ACCESS (returns null)
//
//   viewer / auditor    → gated by accessControls (module + section grants)
//                       → per-module row filter via SECTION_TO_MODULE
//                       → excludes 'auth' module always
//
//   support / unknown   → NO ACCESS (returns null)
//
// ─── AUTH MODULE RESTRICTION ──────────────────────────────────────────────────
//   Only super_admin, consultant_admin, and consultant can see 'auth' module logs.
//   All other roles automatically receive { module: { $nin: ['auth'] } }.
//
// ─── VIEWER / AUDITOR PER-MODULE FILTERING ───────────────────────────────────
//   viewer/auditor access is gated in three layers:
//     1. accessControls.modules.audit_logs.enabled         — module gate
//     2. accessControls.modules.audit_logs.sections.list   — page gate
//     3. per-module sections (data_entry_logs, etc.)        — row gate

const User     = require('../../models/User');
const Client   = require('../../models/CMS/Client');
const mongoose = require('mongoose');

const {
  hasModuleAccess,
  hasSectionAccess,
  isChecklistRole,
} = require('./accessControlPermission');

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Modules that are always hidden from non-consultant roles.
 * Enforced at query layer — cannot be overridden by accessControls.
 */
const AUTH_RESTRICTED_MODULES = ['auth'];

/**
 * User types that a client_admin is allowed to see logs for.
 * Consultants are external actors and their logs are NOT visible to client_admin.
 */
const CLIENT_ADMIN_VISIBLE_ACTOR_TYPES = [
  'client_employee_head',
  'employee',
  'viewer',
  'auditor',
];

/**
 * Maps an audit_logs section key → the AuditLog.module value it controls.
 * Used by _buildModuleFilter to translate per-module section grants into
 * a MongoDB $in filter on the module field.
 *
 * NOTE: 'auth' is intentionally absent — never reachable for viewer/auditor.
 */
const SECTION_TO_MODULE = {
  data_entry_logs:          'data_entry',
  flowchart_logs:           'organization_flowchart',
  process_flowchart_logs:   'process_flowchart',
  transport_flowchart_logs: 'transport_flowchart',
  reduction_logs:           'reduction',
  net_reduction_logs:       'net_reduction',
  sbti_logs:                'sbti',
  emission_summary_logs:    'emission_summary',
  user_management_logs:     'user_management',
  system_logs:              'system',
};

/** Valid delete scopes — super_admin only */
const LOG_DELETE_SCOPES = {
  ALL:              'all',
  BY_CLIENT:        'by_client',
  BY_EMPLOYEE_HEAD: 'by_employee_head',
  BY_EMPLOYEE:      'by_employee',
  BY_ACTOR:         'by_actor',
};

// ─── Main query builder ───────────────────────────────────────────────────────

/**
 * getLogAccessQuery
 *
 * Returns a MongoDB filter fragment restricting which AuditLog documents
 * the given user may read. Returns null if the user has NO access.
 *
 * @param  {object} user  - req.user
 * @returns {Promise<object|null>}
 */
async function getLogAccessQuery(user) {
  if (!user) return null;

  const { userType, clientId } = user;
  const userObjectId = user._id || user.id;
  const userId       = userObjectId.toString();

  // ── 1) Super admin — fully unrestricted ───────────────────────────────────
  if (userType === 'super_admin') {
    return { isDeleted: false };
  }

  // ── 2) Consultant admin ───────────────────────────────────────────────────
  //   Scope:
  //     (a) All logs produced by themselves (actorUserId = self)
  //     (b) All logs produced by consultants under them (actorUserId in team)
  //     (c) All logs within clients they manage (clientId in managedClientIds)
  //   Auth module: visible (no restriction)
  if (userType === 'consultant_admin') {
    const { clientIds, teamConsultantIds } =
      await _getConsultantAdminScope(userId, userObjectId);

    // Build $or branches — at least one must match
    const orClauses = [];

    // (a) + (b): own logs + team consultant logs (may have clientId or may be null)
    const actorIds = [
      new mongoose.Types.ObjectId(userId),
      ...teamConsultantIds.map(id => new mongoose.Types.ObjectId(id)),
    ];
    orClauses.push({ actorUserId: { $in: actorIds } });

    // (c): any log belonging to a managed client
    if (clientIds.length) {
      orClauses.push({ clientId: { $in: clientIds } });
    }

    if (!orClauses.length) return null;

    return {
      isDeleted: false,
      $or: orClauses,
    };
  }

  // ── 3) Consultant — logs for assigned clients only ────────────────────────
  //   Auth module: visible (no restriction)
  if (userType === 'consultant') {
    const clientIds = await _getClientIdsForConsultant(userId);
    if (!clientIds.length) return null;
    return {
      isDeleted: false,
      clientId: { $in: clientIds },
    };
  }

  // ── 4) Client admin — own org, employee/head/viewer/auditor actors only ───
  //   Auth module: HIDDEN
  //   Visible actor types: client_employee_head, employee, viewer, auditor
  //   Rationale: consultant actions on this client are NOT visible to client_admin
  if (userType === 'client_admin') {
    if (!clientId) return null;
    return {
      isDeleted: false,
      clientId,
      actorUserType: { $in: CLIENT_ADMIN_VISIBLE_ACTOR_TYPES },
      module: { $nin: AUTH_RESTRICTED_MODULES },
    };
  }

  // ── 5) Client employee head — own logs + their team employees' logs ────────
  //   Scope: actorUserId must be self OR one of their assigned employees
  //   Auth module: HIDDEN
  if (userType === 'client_employee_head') {
    if (!clientId) return null;
    const employeeIds = await _getEmployeeIdsUnderHead(userId, clientId);
    const actorIds = [
      new mongoose.Types.ObjectId(userId),
      ...employeeIds.map(id => new mongoose.Types.ObjectId(id)),
    ];
    return {
      isDeleted: false,
      clientId,
      actorUserId: { $in: actorIds },
      module: { $nin: AUTH_RESTRICTED_MODULES },
    };
  }

  // ── 6) Employee — NO ACCESS ───────────────────────────────────────────────
  //   Employees do not have permission to view audit logs.
  if (userType === 'employee') {
    return null;
  }

  // ── 7) Viewer / Auditor — accessControls gated + per-module row filter ─────
  //   Gate 1: audit_logs module must be enabled in accessControls
  //   Gate 2: audit_logs.sections.list must be granted
  //   Gate 3: per-module section grants determine which modules are visible
  //   Auth module: always HIDDEN
  if (isChecklistRole(userType)) {
    if (!hasModuleAccess(user, 'audit_logs'))       return null;
    if (!hasSectionAccess(user, 'audit_logs', 'list')) return null;
    if (!clientId) return null;

    const allowedModules = _buildModuleFilter(user);
    if (!allowedModules.length) return null;

    return {
      isDeleted: false,
      clientId,
      module: { $in: allowedModules },
    };
  }

  // ── 8) Support / unknown roles — NO ACCESS ────────────────────────────────
  return null;
}

// ─── Per-module filter ────────────────────────────────────────────────────────

/**
 * _buildModuleFilter
 *
 * Translates a viewer/auditor's audit_logs section permissions into an array
 * of AuditLog.module strings they are allowed to read.
 *
 * 'auth' is always excluded — it does not appear in SECTION_TO_MODULE.
 *
 * @param  {object}   user - req.user with accessControls populated
 * @returns {string[]}     - array of AuditLog.module values this user may see
 */
function _buildModuleFilter(user) {
  const allowed = [];
  for (const [sectionKey, moduleValue] of Object.entries(SECTION_TO_MODULE)) {
    if (hasSectionAccess(user, 'audit_logs', sectionKey)) {
      allowed.push(moduleValue);
    }
  }
  return allowed;
}

// ─── Delete permission ────────────────────────────────────────────────────────

/**
 * canDeleteLogs — only super_admin may delete audit logs.
 * Requires an explicit deleteScope to prevent accidental full-wipes.
 */
function canDeleteLogs(user, deleteScope) {
  if (!user || user.userType !== 'super_admin') {
    return { allowed: false, reason: 'Only super_admin can delete audit logs.' };
  }
  const validScopes = new Set(Object.values(LOG_DELETE_SCOPES));
  if (!deleteScope || !validScopes.has(deleteScope)) {
    return {
      allowed: false,
      reason: `Invalid deleteScope. Must be one of: ${[...validScopes].join(', ')}.`,
    };
  }
  return { allowed: true, reason: `Super admin — scope: ${deleteScope}` };
}

/**
 * hasLogModuleAccess
 * For viewer/auditor: checks accessControls.modules.audit_logs.enabled.
 * For all other permitted roles: returns true (gated at row level).
 * For employee: returns false (no log access at all).
 */
function hasLogModuleAccess(user) {
  if (!user) return false;
  if (user.userType === 'employee') return false;
  if (!isChecklistRole(user.userType)) return true;
  return hasModuleAccess(user, 'audit_logs');
}

// ─── Express middleware ───────────────────────────────────────────────────────

/**
 * attachLogAccessContext
 * Attaches req.logAccessQuery. Returns 401/403 if user has no log access.
 */
const attachLogAccessContext = async (req, res, next) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }

    const query = await getLogAccessQuery(user);
    if (query === null) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You do not have permission to view audit logs.',
      });
    }

    req.logAccessQuery = query;
    return next();

  } catch (err) {
    console.error('[logPermission] attachLogAccessContext error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal error checking log permissions.' });
  }
};

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * _getConsultantAdminScope
 *
 * Returns:
 *   clientIds          — string[] of client IDs this consultant_admin manages
 *   teamConsultantIds  — string[] of consultant user IDs under this admin
 *
 * Used to build the $or query covering both the consultant's own activity
 * and the managed-client activity in a single query pass.
 */
async function _getConsultantAdminScope(userIdStr, userObjectId) {
  try {
    // Fetch all consultants whose consultantAdminId = this admin
    const teamMembers = await User.find({
      consultantAdminId: userObjectId,
      userType: 'consultant',
    }).select('_id').lean();

    const teamConsultantIds = teamMembers.map(u => u._id.toString());
    const teamObjectIds     = teamMembers.map(u => u._id);

    // All consultant IDs to check client assignment (self + team)
    const allConsultantObjectIds = [userObjectId, ...teamObjectIds];

    // Find all clients managed by this admin or any team member
    const clients = await Client.find({
      $or: [
        { 'leadInfo.consultantAdminId': userObjectId },
        { 'leadInfo.createdBy': userObjectId },
        { 'leadInfo.assignedConsultantId': { $in: allConsultantObjectIds } },
        { 'workflowTracking.assignedConsultantId': { $in: allConsultantObjectIds } },
      ],
    }).select('clientId').lean();

    const clientIds = [...new Set(clients.map(c => c.clientId).filter(Boolean))];

    return { clientIds, teamConsultantIds };
  } catch (err) {
    console.error('[logPermission] _getConsultantAdminScope error:', err.message);
    return { clientIds: [], teamConsultantIds: [] };
  }
}

/**
 * _getClientIdsForConsultant
 *
 * Returns string[] of client IDs where this consultant is currently assigned.
 */
async function _getClientIdsForConsultant(userIdStr) {
  try {
    const userId  = new mongoose.Types.ObjectId(userIdStr);
    const clients = await Client.find({
      $or: [
        { 'leadInfo.assignedConsultantId': userId },
        { 'workflowTracking.assignedConsultantId': userId },
      ],
    }).select('clientId').lean();
    return [...new Set(clients.map(c => c.clientId).filter(Boolean))];
  } catch (err) {
    console.error('[logPermission] _getClientIdsForConsultant error:', err.message);
    return [];
  }
}

/**
 * _getEmployeeIdsUnderHead
 *
 * Returns string[] of employee user IDs whose employeeHeadId = headUserIdStr
 * within the given clientId. Only active employees are included.
 */
async function _getEmployeeIdsUnderHead(headUserIdStr, clientId) {
  try {
    const employees = await User.find({
      employeeHeadId: new mongoose.Types.ObjectId(headUserIdStr),
      clientId,
      userType: 'employee',
      isActive: true,
    }).select('_id').lean();
    return employees.map(e => e._id.toString());
  } catch (err) {
    console.error('[logPermission] _getEmployeeIdsUnderHead error:', err.message);
    return [];
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  getLogAccessQuery,
  canDeleteLogs,
  hasLogModuleAccess,
  attachLogAccessContext,
  LOG_DELETE_SCOPES,
  CLIENT_ADMIN_VISIBLE_ACTOR_TYPES,
  // Exposed for controller introspection and testing
  SECTION_TO_MODULE,
  AUTH_RESTRICTED_MODULES,
  _buildModuleFilter,
};