'use strict';
// router/AuditLog/auditLogRoutes.js
//
// MOUNT IN index.js / app.js:
//   const auditLogRoutes = require('./router/AuditLog/auditLogRoutes');
//   app.use('/api/audit-logs', auditLogRoutes);
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ ROUTE MAP                                                               │
// ├──────────────┬──────────────────────────────────┬──────────────────────┤
// │ Method       │ Path                             │ Handler              │
// ├──────────────┼──────────────────────────────────┼──────────────────────┤
// │ GET          │ /search                          │ searchLogs (unified) │
// │ GET          │ /                                │ getLogs              │
// │ GET          │ /stats                           │ getLogStats          │
// │ GET          │ /deleted                         │ getDeletedLogs       │
// │ GET          │ /module/:module                  │ getLogsByModule      │
// │ GET          │ /:id                             │ getLogById           │
// ├──────────────┼──────────────────────────────────┼──────────────────────┤
// │ PATCH        │ /restore                         │ restoreLogs (bulk)   │
// │ PATCH        │ /restore/:id                     │ restoreLogById       │
// ├──────────────┼──────────────────────────────────┼──────────────────────┤
// │ DELETE       │ /                                │ deleteLogs (soft)    │
// │ DELETE       │ /purge-expired                   │ purgeExpiredLogs     │
// │ DELETE       │ /permanent                       │ permanentDeleteLogs  │
// │ DELETE       │ /permanent/:id                   │ permanentDeleteById  │
// │ DELETE       │ /:id                             │ deleteLogById (soft) │
// └──────────────┴──────────────────────────────────┴──────────────────────┘
//
// ⚠ ORDERING RULES:
//   Static paths (/stats, /deleted, /restore, /permanent, /purge-expired)
//   MUST be declared before parameterised paths (/:id, /restore/:id, etc.)
//   to prevent Express matching the static segment as a route param.

const express = require('express');
const router  = express.Router();

const { auth }                 = require('../../middleware/auth');
const { attachLogAccessContext } = require('../../utils/Permissions/logPermission');

const {
  searchLogs,
  getLogs,
  getLogsByModule,
  getLogStats,
  getDeletedLogs,
  getLogById,
  restoreLogById,
  restoreLogs,
  deleteLogs,
  deleteLogById,
  permanentDeleteLogById,
  permanentDeleteLogs,
  purgeExpiredLogs,
} = require('../../controllers/AuditLog/auditLogController');

// ─────────────────────────────────────────────────────────────────────────────
// GET — UNIFIED SEARCH  (covers list, stats, deleted, module in one endpoint)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/audit-logs/search
 *
 * Universal audit log search endpoint — replaces calling separate
 * /stats, /deleted, /module/:module endpoints.
 * Controlled by the `view` query param:
 *
 *   view=list    (default) — paginated + filtered log list
 *   view=stats             — aggregated counts + 14-day trend
 *   view=deleted           — soft-deleted logs within 30-day restore window
 *   view=module            — module-scoped fast fetch (requires &module=<value>)
 *
 * Common filter / sort / pagination params (work in all views):
 *   search, clientId, actorUserId, targetUserId, consultantAdminId,
 *   module (comma-sep), action (comma-sep), status, severity (comma-sep),
 *   source, entityType (comma-sep), entityId, subAction, startDate, endDate,
 *   page, limit, sortBy, sortOrder, includeDeleted
 *
 * Examples:
 *   GET /api/audit-logs/search?view=list&module=data_entry,reduction&severity=warning
 *   GET /api/audit-logs/search?view=stats&clientId=Greon001&startDate=2024-01-01
 *   GET /api/audit-logs/search?view=module&module=sbti,reduction&action=calculate
 *   GET /api/audit-logs/search?view=deleted&clientId=Greon001
 *
 * ⚠ MUST be declared BEFORE /:id to prevent Express matching 'search' as an id param.
 */
router.get('/search', auth, attachLogAccessContext, searchLogs);

/**
 * GET /api/audit-logs
 *
 * Paginated, multi-filtered, searchable list of audit logs.
 * Supports full-text search and comma-separated $in filters.
 *
 * Query params:
 *   search, clientId, actorUserId, targetUserId, consultantAdminId
 *   module         (comma-sep: data_entry,sbti)
 *   action         (comma-sep: create,update,delete)
 *   status         success | failure
 *   severity       info | warning | critical  (comma-sep)
 *   source         manual | api | iot | system | cron | socket
 *   entityType     (comma-sep)
 *   entityId, subAction
 *   startDate, endDate
 *   page, limit    (default 1 / 20, max limit 100)
 *   sortBy         createdAt | module | action | actorName | clientId | severity | status
 *   sortOrder      asc | desc  (default desc)
 *   includeDeleted true — include soft-deleted records (super_admin only)
 */
router.get('/', auth, attachLogAccessContext, getLogs);

/**
 * GET /api/audit-logs/stats
 *
 * Aggregated counts by module, action, status, severity, source
 * + top 10 active actors + 14-day daily trend.
 *
 * Query params: clientId, module, startDate, endDate
 */
router.get('/stats', auth, attachLogAccessContext, getLogStats);

/**
 * GET /api/audit-logs/deleted
 *
 * Soft-deleted logs still within the 30-day restore window.
 * Supports the same filter/search/sort/pagination params as GET /.
 */
router.get('/deleted', auth, attachLogAccessContext, getDeletedLogs);

/**
 * GET /api/audit-logs/module/:module
 *
 * Fast module-scoped fetch using the (module, action, createdAt) compound index.
 * :module must match a MODULE_ENUM value, e.g.:
 *   data_entry | sbti | process_flowchart | reduction | net_reduction
 *   organization_flowchart | transport_flowchart | auth | user_management
 *   emission_summary | api_integration | iot_integration | reports | tickets | system
 *
 * Supports the same filter/search/sort/pagination params as GET /.
 */
router.get('/module/:module', auth, attachLogAccessContext, getLogsByModule);

/**
 * GET /api/audit-logs/:id
 *
 * Single audit log by ID.
 * Query param: includeDeleted=true  (super_admin only — view soft-deleted record)
 */
router.get('/:id', auth, attachLogAccessContext, getLogById);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH — restore endpoints (super_admin only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PATCH /api/audit-logs/restore
 *
 * Bulk restore soft-deleted logs within the 30-day window.
 *
 * Body (one of):
 *   { ids: ['...', '...'], confirm: true }
 *   { restoreScope: 'by_client', clientId: '...', confirm: true }
 *   { restoreScope: 'by_actor',  userId:   '...', confirm: true }
 */
router.patch('/restore', auth, restoreLogs);

/**
 * PATCH /api/audit-logs/restore/:id
 *
 * Restore a single soft-deleted log within the 30-day window.
 */
router.patch('/restore/:id', auth, restoreLogById);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE — soft-delete endpoints (super_admin only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DELETE /api/audit-logs
 *
 * Bulk soft-delete by scope. Logs remain restorable for 30 days.
 *
 * Body:
 * {
 *   deleteScope: 'all' | 'by_client' | 'by_employee_head' | 'by_employee' | 'by_actor',
 *   clientId?:   string,
 *   userId?:     string,
 *   confirm:     true
 * }
 */
router.delete('/', auth, deleteLogs);

/**
 * DELETE /api/audit-logs/purge-expired
 *
 * Force-purge all soft-deleted logs whose deletedAt > 30 days ago.
 * Can also be called programmatically from a cron scheduler (no req/res needed).
 *
 * Body: { confirm: true }
 */
router.delete('/purge-expired', auth, purgeExpiredLogs);

/**
 * DELETE /api/audit-logs/permanent
 *
 * Bulk permanent delete. IRREVERSIBLE. Super admin only.
 *
 * Body:
 * {
 *   deleteScope:  'all' | 'by_client' | 'by_actor',
 *   clientId?:    string,
 *   userId?:      string,
 *   onlyDeleted?: boolean   — restrict to already soft-deleted records
 *   confirm:      true
 * }
 */
router.delete('/permanent', auth, permanentDeleteLogs);

/**
 * DELETE /api/audit-logs/permanent/:id
 *
 * Permanently delete a single audit log. IRREVERSIBLE. Super admin only.
 */
router.delete('/permanent/:id', auth, permanentDeleteLogById);

/**
 * DELETE /api/audit-logs/:id
 *
 * Single soft-delete. Log remains restorable for 30 days.
 * ⚠ Must come AFTER all static DELETE paths above.
 */
router.delete('/:id', auth, deleteLogById);

module.exports = router;