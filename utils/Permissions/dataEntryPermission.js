// utils/permission/dataEntryPermission.js
//
// PURPOSE:
//   Role-based access control for Data Entry APIs.
//   Mirrors the pattern used in summaryAccessContext.js for summary endpoints.
//
// DESIGN:
//   1. getDataEntryAccessContext(user, clientId)
//        → Queries org + process flowcharts ONCE.
//        → Returns { isFullAccess: true } for admin/consultant/auditor/viewer.
//        → Returns { isFullAccess: false, allowedNodeIds, allowedScopeIdentifiers }
//          for employee_head and employee respectively.
//
//   2. buildDataEntryMongoConstraint(ctx)
//        → Converts the access context into a MongoDB filter fragment ready
//          to merge into any DataEntry query.
//        → Returns null for full-access roles (no extra constraint needed).
//        → Returns { _impossible: true } (matches nothing) when user has no
//          assignments — fail-closed behaviour.
//
//   3. attachDataEntryAccessContext  (Express middleware)
//        → Calls getDataEntryAccessContext, attaches result to req.
//        → Blocks at middleware level if user is not permitted at all.

'use strict';

const Flowchart        = require('../../models/Organization/Flowchart');
const ProcessFlowchart = require('../../models/Organization/ProcessFlowchart');

// 🆕 Import accessControlPermission helpers
const {
  hasModuleAccess,
  isChecklistRole,
} = require('./accessControlPermission');


// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Safely convert anything (ObjectId, string, populated doc, null) to string.
 */
const toStr = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (v._id != null) return String(v._id);
  if (v.id  != null) return String(v.id);
  return typeof v.toString === 'function' ? v.toString() : '';
};

// ── Roles that see ALL data for the client (no row-level filtering) ───────────
// 🆕 'auditor' and 'viewer' have been REMOVED — they are now subject to
//    their accessControls checklist via the isChecklistRole branch below.
const FULL_ACCESS_ROLES = new Set([
  'super_admin',
  'consultant_admin',
  'consultant',
  'client_admin',
]);

// ── Internal helper: empty context (fail-closed) ──────────────────────────────
const _emptyCtx = (role) => ({
  isFullAccess: false,
  role,
  userId: '',
  allowedNodeIds: new Set(),
  allowedScopeIdentifiers: new Set(),
});


// ─── Core ─────────────────────────────────────────────────────────────────────

/**
 * getDataEntryAccessContext
 *
 * Returns one of two shapes:
 *
 * Full-access roles:
 *   { isFullAccess: true }
 *
 * Restricted roles:
 *   {
 *     isFullAccess:            false,
 *     role:                    'client_employee_head' | 'employee',
 *     userId:                  string,
 *     allowedNodeIds:          Set<string>,   // non-empty only for employee_head
 *     allowedScopeIdentifiers: Set<string>,   // non-empty only for employee
 *   }
 *
 * @param {object} user      - req.user
 * @param {string} clientId  - target client
 */
const getDataEntryAccessContext = async (user, clientId) => {
  if (!user || !clientId) {
    return _emptyCtx('unknown');
  }

  const { userType } = user;

  // 1) Full-access roles (admin, consultant) — no checklist
  if (FULL_ACCESS_ROLES.has(userType)) {
    return { isFullAccess: true };
  }

  // 2) 🆕 Checklist roles: viewer and auditor
  if (isChecklistRole(userType)) {
    if (!hasModuleAccess(user, 'data_entry')) {
      // Fail-closed: data_entry module not enabled
      return _emptyCtx(userType);
    }
    // Module enabled → all rows accessible (section filtering done in controller)
    return { isFullAccess: true };
  }

  // 3) Restricted roles: employee_head and employee
  const userId = toStr(user._id ?? user.id ?? user.userId ?? '');

  if (!userId) {
    return _emptyCtx(userType);
  }

  const allowedNodeIds          = new Set();
  const allowedScopeIdentifiers = new Set();

  try {
    const [orgChart] = await Promise.all([
      Flowchart.findOne({ clientId, isActive: true }).lean(),
    ]);

    if (orgChart && Array.isArray(orgChart.nodes)) {
      for (const node of orgChart.nodes) {
        const details      = node.details || {};
        const empHeadId    = toStr(details.employeeHeadId);
        const scopeDetails = details.scopeDetails || [];

        if (userType === 'client_employee_head') {
          if (empHeadId && empHeadId === userId) {
            allowedNodeIds.add(node.id);
          }
        } else if (userType === 'employee') {
          for (const sd of scopeDetails) {
            if (!sd.scopeIdentifier || sd.isDeleted) continue;
            const assigned = Array.isArray(sd.assignedEmployees) ? sd.assignedEmployees : [];
            const isAssigned = assigned.some(emp => toStr(emp) === userId);
            if (isAssigned) {
              allowedScopeIdentifiers.add(sd.scopeIdentifier);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[dataEntryPermission] Error building access context:', err.message);
    return _emptyCtx(userType); // fail-closed on error
  }

  return {
    isFullAccess: false,
    role: userType,
    userId,
    allowedNodeIds,
    allowedScopeIdentifiers,
  };
};

// ─── Mongo filter builder ─────────────────────────────────────────────────────

/**
 * buildDataEntryMongoConstraint
 *
 * Converts an access context into a MongoDB filter fragment.
 *
 * Returns:
 *   null                          → full-access, no extra constraint
 *   { nodeId: { $in: [...] } }    → employee_head with assigned nodes
 *   { scopeIdentifier: {$in:[]}}  → employee with assigned scopes
 *   { _impossible: true }         → no assignments (fail-closed, matches 0 docs)
 *
 * @param {object} ctx - result of getDataEntryAccessContext
 */
const buildDataEntryMongoConstraint = (ctx) => {
  if (!ctx || ctx.isFullAccess) return null;

  if (ctx.role === 'client_employee_head') {
    if (ctx.allowedNodeIds.size === 0) {
      return { _impossible: true };
    }
    return { nodeId: { $in: Array.from(ctx.allowedNodeIds) } };
  }

  if (ctx.role === 'employee') {
    if (ctx.allowedScopeIdentifiers.size === 0) {
      return { _impossible: true };
    }
    return { scopeIdentifier: { $in: Array.from(ctx.allowedScopeIdentifiers) } };
  }

  // Checklist roles that failed module check (_emptyCtx)
  // role will be 'viewer' or 'auditor' with empty sets → fail-closed
  if (ctx.role === 'viewer' || ctx.role === 'auditor') {
    return { _impossible: true };
  }

  return { _impossible: true };
};


// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * attachDataEntryAccessContext
 *
 * Express middleware. Resolves the access context and attaches it to req so
 * that controller functions can apply it without re-querying the DB.
 *
 * Usage (in routes):
 *   router.get('/...', attachDataEntryAccessContext, getDataEntries);
 *
 * Handles:
 *  - 401 if unauthenticated
 *  - 403 if client mismatch for client-scoped roles
 *  - Attaches req.dataEntryAccessContext
 */
const attachDataEntryAccessContext = async (req, res, next) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }

    const clientId = req.params?.clientId || req.query?.clientId;

    if (!clientId) {
      req.dataEntryAccessContext = { isFullAccess: FULL_ACCESS_ROLES.has(user.userType) };

      // 🆕 For checklist roles without clientId in params: resolve from user.clientId
      if (isChecklistRole(user.userType)) {
        req.dataEntryAccessContext = {
          isFullAccess: hasModuleAccess(user, 'data_entry'),
        };
      }

      return next();
    }

    const clientScopedRoles = new Set([
      'client_admin', 'client_employee_head', 'employee', 'auditor', 'viewer',
    ]);

    if (clientScopedRoles.has(user.userType)) {
      if (user.clientId && user.clientId !== clientId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied: you cannot access data from another client organisation.',
        });
      }
    }

    req.dataEntryAccessContext = await getDataEntryAccessContext(user, clientId);
    return next();

  } catch (error) {
    console.error('[attachDataEntryAccessContext]', error);
    return res.status(500).json({
      success: false,
      message: 'Internal error building data entry access context.',
    });
  }
};

// // ─── Private helpers ──────────────────────────────────────────────────────────

// function _emptyCtx(role, userId = '') {
//   return {
//     isFullAccess:            false,
//     role,
//     userId,
//     allowedNodeIds:          new Set(),
//     allowedScopeIdentifiers: new Set(),
//   };
// }

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  getDataEntryAccessContext,
  buildDataEntryMongoConstraint,
  attachDataEntryAccessContext,
};