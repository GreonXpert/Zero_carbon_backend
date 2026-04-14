// utils/Permissions/accessPermissionFlowchartandProcessflowchart.js
//
// PURPOSE:
//   Unified access control for Organization Flowchart and Process Flowchart modules.
//
// TWO PERMISSION LAYERS:
//   1. WRITE layer  — create / update / delete / assign operations
//      Delegates to canManageFlowchart / canManageProcessFlowchart (permissions.js).
//      viewer and auditor are ALWAYS denied write operations (fail-closed).
//
//   2. READ layer   — view / nodes / assignments / entries endpoints
//      Non-checklist roles: existing canViewFlowchart logic + client_admin/employee rules.
//      viewer / auditor: accessControls checklist enforced (module enabled + section granted).
//
// SECTION KEYS:
//   organization_flowchart : view | nodes | assignments
//   process_flowchart      : view | entries | processEmissionEntries
//
// USAGE (route-level middleware):
//   router.get('/flowchart/:clientId',  auth, requireOrgFlowchartRead('view'),  getFlowchart);
//   router.get('/flowchart/:clientId',  auth, requireOrgFlowchartRead('nodes'), getNodes);
//   router.put('/flowchart/:clientId',  auth, requireOrgFlowchartWrite(),        updateFlowchart);
//   router.post('/flowchart/:clientId/assign-head', auth, requireOrgFlowchartAssign(), assignHead);
//
//   router.get('/process/:clientId',    auth, requireProcessFlowchartRead('view'),    getProcess);
//   router.get('/process/:clientId/entries', auth, requireProcessFlowchartRead('entries'), getEntries);
//   router.put('/process/:clientId',    auth, requireProcessFlowchartWrite(),          updateProcess);
//
// USAGE (inline section strip in controller):
//   stripOrgFlowchartSections(req.user, responsePayload, {
//     nodes:       ['nodes'],
//     assignments: ['assignedHeads', 'scopeDetails'],
//   });

'use strict';

const {
  hasModuleAccess,
  hasSectionAccess,
  isChecklistRole,
} = require('../../../../../common/utils/Permissions/accessControlPermission');

const {
  canManageFlowchart,
  canManageProcessFlowchart,
  canViewFlowchart,
  canAssignHeadToNode,
} = require('../../../../../common/utils/Permissions/permissions');

// ─── Role sets ────────────────────────────────────────────────────────────────

/**
 * Roles that are scoped to a single client.
 * Used to enforce clientId cross-client protection.
 */
const CLIENT_SCOPED_ROLES = new Set([
  'client_admin',
  'client_employee_head',
  'employee',
  'auditor',
  'viewer',
]);

/**
 * Roles that can NEVER perform write operations on flowcharts.
 * Enforced unconditionally regardless of accessControls checklist.
 */
const READ_ONLY_ROLES = new Set(['viewer', 'auditor', 'employee', 'client_employee_head']);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * resolveClientId
 * Extracts clientId from params → query → body (in priority order).
 */
const resolveClientId = (req) =>
  req.params?.clientId || req.query?.clientId || req.body?.clientId || null;

/**
 * denyWrite
 * Returns a 403 response for roles that must never modify flowchart data.
 */
const denyWrite = (res, role) =>
  res.status(403).json({
    success: false,
    message: `Access denied. '${role}' role cannot modify flowchart data.`,
  });

// ─── Section-level helpers (inline use in controllers) ────────────────────────

/**
 * hasOrgFlowchartSectionAccess
 *
 * For viewer/auditor: checks accessControls.modules.organization_flowchart.sections[sectionKey].
 * For all other permitted roles: always returns true.
 *
 * @param {object} user       - req.user
 * @param {string} sectionKey - 'view' | 'nodes' | 'assignments'
 * @returns {boolean}
 */
const hasOrgFlowchartSectionAccess = (user, sectionKey) =>
  hasSectionAccess(user, 'organization_flowchart', sectionKey);

/**
 * hasProcessFlowchartSectionAccess
 *
 * For viewer/auditor: checks accessControls.modules.process_flowchart.sections[sectionKey].
 * For all other permitted roles: always returns true.
 *
 * @param {object} user       - req.user
 * @param {string} sectionKey - 'view' | 'entries' | 'processEmissionEntries'
 * @returns {boolean}
 */
const hasProcessFlowchartSectionAccess = (user, sectionKey) =>
  hasSectionAccess(user, 'process_flowchart', sectionKey);

/**
 * stripOrgFlowchartSections
 *
 * Remove fields from a response payload for viewer/auditor
 * when they don't have access to specific organization_flowchart sections.
 *
 * @param {object} user       - req.user
 * @param {object} payload    - response object to mutate
 * @param {object} sectionMap - { sectionKey: [payloadKeysToDelete] }
 * @returns {object}          - mutated payload
 *
 * Example:
 *   stripOrgFlowchartSections(req.user, data, {
 *     nodes:       ['nodes'],
 *     assignments: ['employeeHeads', 'scopeDetails'],
 *   });
 */
const stripOrgFlowchartSections = (user, payload, sectionMap) => {
  if (!payload || !isChecklistRole(user?.userType)) return payload;
  for (const [sectionKey, keys] of Object.entries(sectionMap)) {
    if (!hasSectionAccess(user, 'organization_flowchart', sectionKey)) {
      for (const k of keys) delete payload[k];
    }
  }
  return payload;
};

/**
 * stripProcessFlowchartSections
 *
 * Remove fields from a response payload for viewer/auditor
 * when they don't have access to specific process_flowchart sections.
 *
 * @param {object} user       - req.user
 * @param {object} payload    - response object to mutate
 * @param {object} sectionMap - { sectionKey: [payloadKeysToDelete] }
 * @returns {object}          - mutated payload
 *
 * Example:
 *   stripProcessFlowchartSections(req.user, data, {
 *     entries:                ['entries'],
 *     processEmissionEntries: ['processEmissionEntries'],
 *   });
 */
const stripProcessFlowchartSections = (user, payload, sectionMap) => {
  if (!payload || !isChecklistRole(user?.userType)) return payload;
  for (const [sectionKey, keys] of Object.entries(sectionMap)) {
    if (!hasSectionAccess(user, 'process_flowchart', sectionKey)) {
      for (const k of keys) delete payload[k];
    }
  }
  return payload;
};

// ─── Organization Flowchart — Read middleware ──────────────────────────────────

/**
 * requireOrgFlowchartRead
 *
 * Express middleware factory for READ endpoints on the organization flowchart.
 *
 * Permission logic:
 *   1. viewer / auditor → module must be enabled + sectionKey must be granted
 *   2. client_admin     → clientId must match own clientId
 *   3. client_employee_head / employee → clientId must match (restricted view)
 *   4. super_admin / consultant_admin / consultant → delegates to canViewFlowchart
 *
 * @param {string} sectionKey - 'view' | 'nodes' | 'assignments'
 * @returns {function} Express middleware
 */
const requireOrgFlowchartRead = (sectionKey) => {
  return async (req, res, next) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ success: false, message: 'Authentication required.' });
      }

      const clientId = resolveClientId(req);
      if (!clientId) {
        return res.status(400).json({ success: false, message: 'clientId is required.' });
      }

      // ── Cross-client guard for client-scoped roles ──────────────────────────
      if (CLIENT_SCOPED_ROLES.has(user.userType)) {
        if (user.clientId && user.clientId !== clientId) {
          return res.status(403).json({
            success: false,
            message: 'Access denied: you cannot access data from another client organisation.',
          });
        }
      }

      const { userType } = user;

      // ── 1) viewer / auditor — checklist enforcement ─────────────────────────
      if (isChecklistRole(userType)) {
        if (!hasModuleAccess(user, 'organization_flowchart')) {
          return res.status(403).json({
            success: false,
            message: 'Access denied. Your account does not have access to the Organization Flowchart module.',
            module: 'organization_flowchart',
          });
        }
        if (sectionKey && !hasSectionAccess(user, 'organization_flowchart', sectionKey)) {
          return res.status(403).json({
            success: false,
            message: `Access denied. You do not have access to the '${sectionKey}' section of the Organization Flowchart.`,
            module: 'organization_flowchart',
            section: sectionKey,
          });
        }
        // clientId already verified above via CLIENT_SCOPED_ROLES
        return next();
      }

      // ── 2) client_admin — own client only ───────────────────────────────────
      if (userType === 'client_admin') {
        if (user.clientId !== clientId) {
          return res.status(403).json({
            success: false,
            message: 'Access denied. You can only view your own organisation\'s flowchart.',
          });
        }
        return next();
      }

      // ── 3) client_employee_head / employee — clientId match is sufficient ───
      if (userType === 'client_employee_head' || userType === 'employee') {
        // clientId already verified via CLIENT_SCOPED_ROLES guard above
        return next();
      }

      // ── 4) super_admin / consultant_admin / consultant ───────────────────────
      const { allowed, reason } = await canViewFlowchart(user, clientId);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: reason || 'Access denied. You are not authorised to view this flowchart.',
        });
      }

      return next();

    } catch (err) {
      console.error('[accessPermissionFlowchart] requireOrgFlowchartRead error:', err.message);
      return res.status(500).json({ success: false, message: 'Internal error checking flowchart read permission.' });
    }
  };
};

// ─── Organization Flowchart — Write middleware ─────────────────────────────────

/**
 * requireOrgFlowchartWrite
 *
 * Express middleware for CREATE / UPDATE / DELETE operations on
 * the organization flowchart.
 *
 * viewer, auditor, employee, client_employee_head → always denied.
 * client_admin → allowed only for own clientId.
 * consultant / consultant_admin / super_admin → delegates to canManageFlowchart.
 *
 * @returns {function} Express middleware
 */
const requireOrgFlowchartWrite = () => {
  return async (req, res, next) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ success: false, message: 'Authentication required.' });
      }

      const clientId = resolveClientId(req);
      if (!clientId) {
        return res.status(400).json({ success: false, message: 'clientId is required.' });
      }

      const { userType } = user;

      // ── Read-only roles: never allowed to write ─────────────────────────────
      if (READ_ONLY_ROLES.has(userType)) {
        return denyWrite(res, userType);
      }

      // ── client_admin: own org only ──────────────────────────────────────────
      if (userType === 'client_admin') {
        if (user.clientId !== clientId) {
          return res.status(403).json({
            success: false,
            message: 'Access denied. You can only modify your own organisation\'s flowchart.',
          });
        }
        return next();
      }

      // ── super_admin / consultant_admin / consultant ──────────────────────────
      const { allowed, reason } = await canManageFlowchart(user, clientId);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: reason || 'Access denied. You are not authorised to modify this flowchart.',
        });
      }

      return next();

    } catch (err) {
      console.error('[accessPermissionFlowchart] requireOrgFlowchartWrite error:', err.message);
      return res.status(500).json({ success: false, message: 'Internal error checking flowchart write permission.' });
    }
  };
};

// ─── Organization Flowchart — Assign Head middleware ──────────────────────────

/**
 * requireOrgFlowchartAssign
 *
 * Express middleware for node employee-head assignment endpoints.
 * viewer, auditor, employee → always denied.
 * client_employee_head → always denied (cannot assign heads).
 * client_admin → allowed for own client.
 * consultant / consultant_admin / super_admin → delegates to canAssignHeadToNode.
 *
 * @returns {function} Express middleware
 */
const requireOrgFlowchartAssign = () => {
  return async (req, res, next) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ success: false, message: 'Authentication required.' });
      }

      const clientId = resolveClientId(req);
      if (!clientId) {
        return res.status(400).json({ success: false, message: 'clientId is required.' });
      }

      const { userType } = user;

      // ── Read-only / employee_head roles: never allowed ─────────────────────
      if (READ_ONLY_ROLES.has(userType)) {
        return denyWrite(res, userType);
      }

      // ── client_admin: own org only ──────────────────────────────────────────
      if (userType === 'client_admin') {
        if (user.clientId !== clientId) {
          return res.status(403).json({
            success: false,
            message: 'Access denied. You can only assign heads within your own organisation.',
          });
        }
        return next();
      }

      // ── super_admin / consultant_admin / consultant ──────────────────────────
      const { allowed, reason } = await canAssignHeadToNode(user, clientId);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: reason || 'Access denied. You are not authorised to assign heads to nodes.',
        });
      }

      return next();

    } catch (err) {
      console.error('[accessPermissionFlowchart] requireOrgFlowchartAssign error:', err.message);
      return res.status(500).json({ success: false, message: 'Internal error checking flowchart assign permission.' });
    }
  };
};

// ─── Process Flowchart — Read middleware ──────────────────────────────────────

/**
 * requireProcessFlowchartRead
 *
 * Express middleware factory for READ endpoints on the process flowchart.
 *
 * Permission logic:
 *   1. viewer / auditor → module must be enabled + sectionKey must be granted
 *   2. client_admin     → clientId must match own clientId
 *   3. client_employee_head / employee → clientId must match (restricted view)
 *   4. super_admin / consultant_admin / consultant → allowed if assigned to client
 *
 * @param {string} sectionKey - 'view' | 'entries' | 'processEmissionEntries'
 * @returns {function} Express middleware
 */
const requireProcessFlowchartRead = (sectionKey) => {
  return async (req, res, next) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ success: false, message: 'Authentication required.' });
      }

      const clientId = resolveClientId(req);
      if (!clientId) {
        return res.status(400).json({ success: false, message: 'clientId is required.' });
      }

      // ── Cross-client guard for client-scoped roles ──────────────────────────
      if (CLIENT_SCOPED_ROLES.has(user.userType)) {
        if (user.clientId && user.clientId !== clientId) {
          return res.status(403).json({
            success: false,
            message: 'Access denied: you cannot access data from another client organisation.',
          });
        }
      }

      const { userType } = user;

      // ── 1) viewer / auditor — checklist enforcement ─────────────────────────
      if (isChecklistRole(userType)) {
        if (!hasModuleAccess(user, 'process_flowchart')) {
          return res.status(403).json({
            success: false,
            message: 'Access denied. Your account does not have access to the Process Flowchart module.',
            module: 'process_flowchart',
          });
        }
        if (sectionKey && !hasSectionAccess(user, 'process_flowchart', sectionKey)) {
          return res.status(403).json({
            success: false,
            message: `Access denied. You do not have access to the '${sectionKey}' section of the Process Flowchart.`,
            module: 'process_flowchart',
            section: sectionKey,
          });
        }
        // clientId already verified above via CLIENT_SCOPED_ROLES
        return next();
      }

      // ── 2) client_admin — own client only ───────────────────────────────────
      if (userType === 'client_admin') {
        if (user.clientId !== clientId) {
          return res.status(403).json({
            success: false,
            message: 'Access denied. You can only view your own organisation\'s process flowchart.',
          });
        }
        return next();
      }

      // ── 3) client_employee_head / employee — clientId match is sufficient ───
      if (userType === 'client_employee_head' || userType === 'employee') {
        // clientId already verified via CLIENT_SCOPED_ROLES guard above
        return next();
      }

      // ── 4) super_admin / consultant_admin / consultant ───────────────────────
      // canManageProcessFlowchart covers all three (super_admin always allowed,
      // consultant_admin/consultant checked via client assignment).
      const { allowed, reason } = await canManageProcessFlowchart(user, clientId);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: reason || 'Access denied. You are not authorised to view this process flowchart.',
        });
      }

      return next();

    } catch (err) {
      console.error('[accessPermissionFlowchart] requireProcessFlowchartRead error:', err.message);
      return res.status(500).json({ success: false, message: 'Internal error checking process flowchart read permission.' });
    }
  };
};

// ─── Process Flowchart — Write middleware ─────────────────────────────────────

/**
 * requireProcessFlowchartWrite
 *
 * Express middleware for CREATE / UPDATE / DELETE operations on
 * the process flowchart.
 *
 * viewer, auditor, employee, client_employee_head → always denied.
 * client_admin → allowed only for own clientId.
 * consultant / consultant_admin / super_admin → delegates to canManageProcessFlowchart.
 *
 * @returns {function} Express middleware
 */
const requireProcessFlowchartWrite = () => {
  return async (req, res, next) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ success: false, message: 'Authentication required.' });
      }

      const clientId = resolveClientId(req);
      if (!clientId) {
        return res.status(400).json({ success: false, message: 'clientId is required.' });
      }

      const { userType } = user;

      // ── Read-only roles: never allowed to write ─────────────────────────────
      if (READ_ONLY_ROLES.has(userType)) {
        return denyWrite(res, userType);
      }

      // ── client_admin: own org only ──────────────────────────────────────────
      if (userType === 'client_admin') {
        if (user.clientId !== clientId) {
          return res.status(403).json({
            success: false,
            message: 'Access denied. You can only modify your own organisation\'s process flowchart.',
          });
        }
        return next();
      }

      // ── super_admin / consultant_admin / consultant ──────────────────────────
      const { allowed, reason } = await canManageProcessFlowchart(user, clientId);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: reason || 'Access denied. You are not authorised to modify this process flowchart.',
        });
      }

      return next();

    } catch (err) {
      console.error('[accessPermissionFlowchart] requireProcessFlowchartWrite error:', err.message);
      return res.status(500).json({ success: false, message: 'Internal error checking process flowchart write permission.' });
    }
  };
};

// ─── Process Flowchart — Assign Head middleware ────────────────────────────────

/**
 * requireProcessFlowchartAssign
 *
 * Express middleware for node employee-head assignment in the process flowchart.
 * Mirrors requireOrgFlowchartAssign but uses canManageProcessFlowchart for
 * consultant/consultant_admin/super_admin resolution.
 *
 * @returns {function} Express middleware
 */
const requireProcessFlowchartAssign = () => {
  return async (req, res, next) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ success: false, message: 'Authentication required.' });
      }

      const clientId = resolveClientId(req);
      if (!clientId) {
        return res.status(400).json({ success: false, message: 'clientId is required.' });
      }

      const { userType } = user;

      // ── Read-only roles: never allowed ─────────────────────────────────────
      if (READ_ONLY_ROLES.has(userType)) {
        return denyWrite(res, userType);
      }

      // ── client_admin: own org only ──────────────────────────────────────────
      if (userType === 'client_admin') {
        if (user.clientId !== clientId) {
          return res.status(403).json({
            success: false,
            message: 'Access denied. You can only assign heads within your own organisation.',
          });
        }
        return next();
      }

      // ── super_admin / consultant_admin / consultant ──────────────────────────
      const { allowed, reason } = await canManageProcessFlowchart(user, clientId);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: reason || 'Access denied. You are not authorised to assign heads in this process flowchart.',
        });
      }

      return next();

    } catch (err) {
      console.error('[accessPermissionFlowchart] requireProcessFlowchartAssign error:', err.message);
      return res.status(500).json({ success: false, message: 'Internal error checking process flowchart assign permission.' });
    }
  };
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // ── Organization Flowchart ─────────────────────────────────────────────────
  requireOrgFlowchartRead,    // middleware factory — pass sectionKey: 'view'|'nodes'|'assignments'
  requireOrgFlowchartWrite,   // middleware factory — for create/update/delete
  requireOrgFlowchartAssign,  // middleware factory — for assign-head endpoints

  // ── Process Flowchart ──────────────────────────────────────────────────────
  requireProcessFlowchartRead,    // middleware factory — pass sectionKey: 'view'|'entries'|'processEmissionEntries'
  requireProcessFlowchartWrite,   // middleware factory — for create/update/delete
  requireProcessFlowchartAssign,  // middleware factory — for assign-head endpoints

  // ── Inline section helpers (use inside controllers) ────────────────────────
  hasOrgFlowchartSectionAccess,     // (user, sectionKey) → boolean
  hasProcessFlowchartSectionAccess, // (user, sectionKey) → boolean
  stripOrgFlowchartSections,        // (user, payload, sectionMap) → payload
  stripProcessFlowchartSections,    // (user, payload, sectionMap) → payload
};
