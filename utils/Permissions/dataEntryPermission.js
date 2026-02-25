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

// ─── Roles that see ALL data for the client (no row-level filtering) ─────────
const FULL_ACCESS_ROLES = new Set([
  'super_admin',
  'consultant_admin',
  'consultant',
  'client_admin',
  'auditor',
  'viewer',
]);

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

  if (FULL_ACCESS_ROLES.has(userType)) {
    return { isFullAccess: true };
  }

  const userId = toStr(user._id ?? user.id ?? user);

  if (!userId) {
    console.warn('[dataEntryPermission] Could not extract userId from user object');
    return _emptyCtx(userType);
  }

  const allowedNodeIds          = new Set();
  const allowedScopeIdentifiers = new Set();

  try {
    // Single parallel fetch for both flowchart types — avoid N+1
    const [orgChart, processChart] = await Promise.all([
      Flowchart.findOne({ clientId, isActive: true }).lean(),
      ProcessFlowchart.findOne({ clientId, isDeleted: { $ne: true } }).lean(),
    ]);

    const allCharts = [orgChart, processChart].filter(Boolean);

    for (const chart of allCharts) {
      if (!Array.isArray(chart.nodes)) continue;

      for (const node of chart.nodes) {
        const details      = node.details || {};
        const empHeadId    = toStr(details.employeeHeadId);
        const scopeDetails = Array.isArray(details.scopeDetails) ? details.scopeDetails : [];

        if (userType === 'client_employee_head') {
          // employee_head owns the ENTIRE node
          if (empHeadId && empHeadId === userId) {
            allowedNodeIds.add(node.id);
          }

        } else if (userType === 'employee') {
          // employee owns specific scopeDetails entries
          for (const sd of scopeDetails) {
            if (!sd.scopeIdentifier || sd.isDeleted) continue;
            const assigned  = Array.isArray(sd.assignedEmployees) ? sd.assignedEmployees : [];
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
    // Fail-closed: if flowchart lookup fails, return empty (no data)
    return _emptyCtx(userType, userId);
  }

  console.log(
    `[dataEntryPermission] userId=${userId} role=${userType} ` +
    `allowedNodes=${allowedNodeIds.size} allowedScopes=${allowedScopeIdentifiers.size}`
  );

  return {
    isFullAccess:            false,
    role:                    userType,
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
      // Fail-closed: employee_head with no assigned nodes → return nothing
      return { _impossible: true };
    }
    return { nodeId: { $in: Array.from(ctx.allowedNodeIds) } };
  }

  if (ctx.role === 'employee') {
    if (ctx.allowedScopeIdentifiers.size === 0) {
      // Fail-closed: employee with no assigned scopes → return nothing
      return { _impossible: true };
    }
    return { scopeIdentifier: { $in: Array.from(ctx.allowedScopeIdentifiers) } };
  }

  // Unknown restricted role → fail-closed
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

    // Resolve clientId from params or query
    const clientId = req.params?.clientId || req.query?.clientId;

    if (!clientId) {
      // Some endpoints build clientId from user.clientId — allow to pass through
      // The controller's buildDataEntryFilters will handle this case.
      req.dataEntryAccessContext = { isFullAccess: FULL_ACCESS_ROLES.has(user.userType) };
      return next();
    }

    // Client-scoped roles: enforce that clientId matches their own
    const clientScopedRoles = new Set(['client_admin', 'client_employee_head', 'employee', 'auditor', 'viewer']);
    if (clientScopedRoles.has(user.userType)) {
      if (user.clientId && user.clientId !== clientId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied: you cannot access data from another client organisation.',
        });
      }
    }

    const ctx = await getDataEntryAccessContext(user, clientId);
    req.dataEntryAccessContext = ctx;

    return next();
  } catch (err) {
    console.error('[dataEntryPermission] attachDataEntryAccessContext error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Internal server error during permission check.',
    });
  }
};

// ─── Private helpers ──────────────────────────────────────────────────────────

function _emptyCtx(role, userId = '') {
  return {
    isFullAccess:            false,
    role,
    userId,
    allowedNodeIds:          new Set(),
    allowedScopeIdentifiers: new Set(),
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  getDataEntryAccessContext,
  buildDataEntryMongoConstraint,
  attachDataEntryAccessContext,
};