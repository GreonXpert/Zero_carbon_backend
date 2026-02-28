'use strict';
// controllers/AuditLog/auditLogController.js
//
// ENDPOINTS:
//   GET    /api/audit-logs                    → paginated list (search + multi-filter + sort)
//   GET    /api/audit-logs/stats              → summary counts by module/action/status/severity
//   GET    /api/audit-logs/deleted            → soft-deleted logs eligible for restore
//   GET    /api/audit-logs/module/:module     → logs scoped to one module (fast index hit)
//   GET    /api/audit-logs/:id                → single log detail
//   PATCH  /api/audit-logs/restore/:id        → restore a single soft-deleted log
//   PATCH  /api/audit-logs/restore            → bulk restore soft-deleted logs
//   DELETE /api/audit-logs                    → bulk soft-delete  (super_admin)
//   DELETE /api/audit-logs/:id                → single soft-delete (super_admin)
//   DELETE /api/audit-logs/permanent/:id      → permanent delete   (super_admin)
//   DELETE /api/audit-logs/permanent          → bulk permanent delete (super_admin)
//   DELETE /api/audit-logs/purge-expired      → force-purge logs soft-deleted > 30 days

const AuditLog = require('../../models/AuditLog/AuditLog');
const { canDeleteLogs, LOG_DELETE_SCOPES } = require('../../utils/Permissions/logPermission');
const { logEvent } = require('../../services/audit/auditLogService');
const mongoose = require('mongoose');

// ── Constants ─────────────────────────────────────────────────────────────────

const SOFT_DELETE_TTL_DAYS = 30;
const MAX_LIMIT             = 100;
const DEFAULT_LIMIT         = 20;
const ALLOWED_SORT_FIELDS   = [
  'createdAt', 'module', 'action', 'actorName', 'clientId',
  'severity', 'status', 'source', 'entityType',
];

// ── Socket.IO instance ────────────────────────────────────────────────────────

let _io = null;
function setSocketIO(io) { _io = io; }

// ── Shared private helpers ────────────────────────────────────────────────────

/**
 * _parsePagination — extract safe pageNum, limitNum, skip from req.query
 */
function _parsePagination(query) {
  const pageNum  = Math.max(1, parseInt(query.page,  10) || 1);
  const limitNum = Math.min(MAX_LIMIT, Math.max(1, parseInt(query.limit, 10) || DEFAULT_LIMIT));
  const skip     = (pageNum - 1) * limitNum;
  return { pageNum, limitNum, skip };
}

/**
 * _parseSort — return safe { field: direction } sort object
 */
function _parseSort(query) {
  const sortBy  = ALLOWED_SORT_FIELDS.includes(query.sortBy) ? query.sortBy : 'createdAt';
  const sortDir = query.sortOrder === 'asc' ? 1 : -1;
  return { [sortBy]: sortDir };
}

/**
 * _buildExtraFilters
 *
 * Translates raw query params into a Mongoose filter object.
 * Supports comma-separated multi-values for enum fields:
 *   ?module=data_entry,sbti  →  { module: { $in: ['data_entry', 'sbti'] } }
 *   ?severity=warning,critical
 *
 * Search: regex across actorName, actorEmail, changeSummary, entityId,
 *         entityType, subAction, targetUserName, clientId.
 * For collections >1M docs, replace the $or regex block with a MongoDB
 * $text index search for native performance.
 */
function _buildExtraFilters(query) {
  const {
    clientId, actorUserId, targetUserId, consultantAdminId,
    module: mod, action, status, severity, source,
    entityType, entityId, subAction,
    startDate, endDate,
    search,
  } = query;

  const f = {};

  // ── Enum / string fields (support comma-separated $in) ───────────────────
  const _applyEnum = (key, raw) => {
    if (!raw) return;
    const vals = raw.split(',').map(v => v.trim()).filter(Boolean);
    f[key] = vals.length === 1 ? vals[0] : { $in: vals };
  };

  if (clientId)  f.clientId  = clientId;
  if (entityId)  f.entityId  = entityId;
  if (subAction) f.subAction = subAction;

  _applyEnum('module',     mod);
  _applyEnum('action',     action);
  _applyEnum('status',     status);
  _applyEnum('severity',   severity);
  _applyEnum('source',     source);
  _applyEnum('entityType', entityType);

  // ── ObjectId filters ──────────────────────────────────────────────────────
  const _applyObjectId = (key, raw) => {
    if (raw && mongoose.Types.ObjectId.isValid(raw)) {
      f[key] = new mongoose.Types.ObjectId(raw);
    }
  };

  _applyObjectId('actorUserId',       actorUserId);
  _applyObjectId('targetUserId',      targetUserId);
  _applyObjectId('consultantAdminId', consultantAdminId);

  // ── Date range ────────────────────────────────────────────────────────────
  if (startDate || endDate) {
    f.createdAt = {};
    if (startDate) f.createdAt.$gte = new Date(startDate);
    if (endDate)   f.createdAt.$lte = new Date(endDate);
  }

  // ── Full-text search ──────────────────────────────────────────────────────
  if (search && search.trim()) {
    const re = new RegExp(
      search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), // escape special chars
      'i'
    );
    f.$or = [
      { actorName:      re },
      { actorEmail:     re },
      { changeSummary:  re },
      { entityType:     re },
      { entityId:       re },
      { subAction:      re },
      { targetUserName: re },
      { clientId:       re },
    ];
  }

  return f;
}

/**
 * _paginationMeta — standard pagination envelope
 */
function _paginationMeta(total, pageNum, limitNum, skip) {
  return {
    total,
    page:       pageNum,
    limit:      limitNum,
    totalPages: Math.ceil(total / limitNum),
    hasMore:    skip + limitNum < total,
  };
}

/**
 * _ttlCutoff — date exactly SOFT_DELETE_TTL_DAYS ago (restore window boundary)
 */
function _ttlCutoff() {
  const d = new Date();
  d.setDate(d.getDate() - SOFT_DELETE_TTL_DAYS);
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// READ ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * getLogs
 *
 * Advanced paginated, multi-filtered, searchable list of audit logs.
 * Role scope applied via req.logAccessQuery (set by attachLogAccessContext middleware).
 *
 * Query params (all optional):
 *   search            free-text across actorName, email, changeSummary, entityId …
 *   clientId          exact match
 *   actorUserId       ObjectId
 *   targetUserId      ObjectId
 *   consultantAdminId ObjectId
 *   module            single or comma-separated: data_entry,sbti
 *   action            single or comma-separated: create,update,delete
 *   status            success | failure
 *   severity          info | warning | critical  (comma-sep ok)
 *   source            manual | api | iot | system | cron | socket
 *   entityType        e.g. DataEntry,Flowchart  (comma-sep ok)
 *   entityId          exact string
 *   subAction         e.g. hard_delete
 *   startDate         ISO date (inclusive lower bound)
 *   endDate           ISO date (inclusive upper bound)
 *   page              default 1
 *   limit             default 20, max 100
 *   sortBy            default createdAt
 *   sortOrder         asc | desc  (default desc)
 *   includeDeleted    true — also return soft-deleted records (super_admin only)
 */
const getLogs = async (req, res) => {
  try {
    const baseQuery    = req.logAccessQuery || {};
    const extraFilters = _buildExtraFilters(req.query);

    // Only super_admin may inspect soft-deleted records via this endpoint
    const includeDeleted =
      req.query.includeDeleted === 'true' && req.user?.userType === 'super_admin';

    const finalQuery = {
      ...baseQuery,
      ...extraFilters,
      ...(includeDeleted ? {} : { isDeleted: false }),
    };

    const { pageNum, limitNum, skip } = _parsePagination(req.query);
    const sort = _parseSort(req.query);

    // Parallel fetch + count for maximum speed
    const [logs, total] = await Promise.all([
      AuditLog.find(finalQuery)
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      AuditLog.countDocuments(finalQuery),
    ]);

    return res.status(200).json({
      success: true,
      data:    logs,
      pagination: _paginationMeta(total, pageNum, limitNum, skip),
    });

  } catch (err) {
    console.error('[auditLogController] getLogs error:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve audit logs.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * getLogsByModule
 *
 * Fast module-scoped fetch — forces the (module, action, createdAt) compound
 * index and supports all the same filter/search/sort/pagination params as getLogs.
 *
 * Route param:
 *   :module  — must be a valid MODULE_ENUM value
 *
 * Query params: same as getLogs (module param in query is ignored — route param wins)
 */
const getLogsByModule = async (req, res) => {
  try {
    const { module: mod } = req.params;

    const { MODULE_ENUM } = require('../../models/AuditLog/AuditLog');
    if (!MODULE_ENUM.includes(mod)) {
      return res.status(400).json({
        success: false,
        message: `Unknown module '${mod}'. Valid values: ${MODULE_ENUM.join(', ')}`,
      });
    }

    const baseQuery    = req.logAccessQuery || {};
    const extraFilters = _buildExtraFilters(req.query);

    // Route param always wins over any ?module= query param
    const finalQuery = {
      ...baseQuery,
      ...extraFilters,
      module:    mod,
      isDeleted: false,
    };

    const { pageNum, limitNum, skip } = _parsePagination(req.query);
    const sort = _parseSort(req.query);

    const [logs, total] = await Promise.all([
      AuditLog.find(finalQuery)
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      AuditLog.countDocuments(finalQuery),
    ]);

    return res.status(200).json({
      success: true,
      module:  mod,
      data:    logs,
      pagination: _paginationMeta(total, pageNum, limitNum, skip),
    });

  } catch (err) {
    console.error('[auditLogController] getLogsByModule error:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve module logs.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * getLogStats
 *
 * Dashboard aggregation: counts by module, action, status, severity, source
 * + top 10 active actors + 14-day daily trend.
 * All 7 aggregations run in parallel.
 *
 * Query params: clientId, module, startDate, endDate
 */
const getLogStats = async (req, res) => {
  try {
    const baseQuery = req.logAccessQuery || {};
    const { clientId, startDate, endDate, module: mod } = req.query;

    const matchStage = { ...baseQuery, isDeleted: false };
    if (clientId) matchStage.clientId = clientId;
    if (mod)      matchStage.module   = mod;
    if (startDate || endDate) {
      matchStage.createdAt = {};
      if (startDate) matchStage.createdAt.$gte = new Date(startDate);
      if (endDate)   matchStage.createdAt.$lte = new Date(endDate);
    }

    const groupCount = (field) => [
      { $match: matchStage },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      { $sort:  { count: -1 } },
    ];

    // 14-day trend window
    const trendStart = new Date();
    trendStart.setDate(trendStart.getDate() - 13);
    trendStart.setHours(0, 0, 0, 0);

    const [
      total,
      byModule,
      byAction,
      byStatus,
      bySeverity,
      bySource,
      topActors,
      dailyTrend,
    ] = await Promise.all([
      AuditLog.countDocuments(matchStage),

      AuditLog.aggregate(groupCount('module')),
      AuditLog.aggregate(groupCount('action')),
      AuditLog.aggregate(groupCount('status')),
      AuditLog.aggregate(groupCount('severity')),
      AuditLog.aggregate(groupCount('source')),

      // Top 10 most active actors
      AuditLog.aggregate([
        { $match: matchStage },
        { $sort:  { createdAt: -1 } },
        {
          $group: {
            _id:           '$actorUserId',
            actorName:     { $first: '$actorName' },
            actorUserType: { $first: '$actorUserType' },
            lastAction:    { $first: '$createdAt' },
            count:         { $sum: 1 },
          },
        },
        { $sort:  { count: -1 } },
        { $limit: 10 },
      ]),

      // 14-day daily event count for sparklines
      AuditLog.aggregate([
        { $match: { ...matchStage, createdAt: { $gte: trendStart } } },
        {
          $group: {
            _id: {
              year:  { $year:        '$createdAt' },
              month: { $month:       '$createdAt' },
              day:   { $dayOfMonth:  '$createdAt' },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
      ]),
    ]);

    const toMap = (arr) => arr.reduce((acc, x) => ({ ...acc, [x._id]: x.count }), {});

    return res.status(200).json({
      success: true,
      data: {
        total,
        byModule:   toMap(byModule),
        byAction:   toMap(byAction),
        byStatus:   toMap(byStatus),
        bySeverity: toMap(bySeverity),
        bySource:   toMap(bySource),
        topActors,
        dailyTrend: dailyTrend.map(d => ({
          date:  `${d._id.year}-${String(d._id.month).padStart(2, '0')}-${String(d._id.day).padStart(2, '0')}`,
          count: d.count,
        })),
      },
    });

  } catch (err) {
    console.error('[auditLogController] getLogStats error:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve log stats.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * getDeletedLogs
 *
 * Returns only soft-deleted logs that are still within the 30-day restore window.
 * Super admin sees platform-wide; other roles see within their logAccessQuery scope.
 *
 * Query params: same filter/search/sort/pagination params as getLogs
 */
const getDeletedLogs = async (req, res) => {
  try {
    const baseQuery    = req.logAccessQuery || {};
    const extraFilters = _buildExtraFilters(req.query);

    const finalQuery = {
      ...baseQuery,
      ...extraFilters,
      isDeleted: true,
      deletedAt: { $gte: _ttlCutoff() },
    };

    const { pageNum, limitNum, skip } = _parsePagination(req.query);
    const sort = _parseSort(req.query);

    const [logs, total] = await Promise.all([
      AuditLog.find(finalQuery).sort(sort).skip(skip).limit(limitNum).lean(),
      AuditLog.countDocuments(finalQuery),
    ]);

    return res.status(200).json({
      success: true,
      data:    logs,
      meta: {
        restoreWindowDays: SOFT_DELETE_TTL_DAYS,
        expiresBefore:     _ttlCutoff(),
      },
      pagination: _paginationMeta(total, pageNum, limitNum, skip),
    });

  } catch (err) {
    console.error('[auditLogController] getDeletedLogs error:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve deleted logs.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * getLogById
 *
 * Single audit log. Verifies the record falls within req.logAccessQuery scope.
 * Super admin may also view soft-deleted records via ?includeDeleted=true.
 */
const getLogById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid log ID.' });
    }

    const baseQuery      = req.logAccessQuery || {};
    const includeDeleted =
      req.query.includeDeleted === 'true' && req.user?.userType === 'super_admin';

    const log = await AuditLog.findOne({
      _id: id,
      ...baseQuery,
      ...(includeDeleted ? {} : { isDeleted: false }),
    }).lean();

    if (!log) {
      return res.status(404).json({ success: false, message: 'Audit log not found or access denied.' });
    }

    return res.status(200).json({ success: true, data: log });

  } catch (err) {
    console.error('[auditLogController] getLogById error:', err);
    return res.status(500).json({ success: false, message: 'Failed to retrieve audit log.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// RESTORE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * restoreLogById
 *
 * Restores a single soft-deleted log IF it is still within the 30-day window.
 * Super admin only.
 */
const restoreLogById = async (req, res) => {
  try {
    if (req.user?.userType !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Only super admins can restore audit logs.' });
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid log ID.' });
    }

    const log = await AuditLog.findOneAndUpdate(
      { _id: id, isDeleted: true, deletedAt: { $gte: _ttlCutoff() } },
      { $set: { isDeleted: false, deletedAt: null, deletedBy: null } },
      { new: true }
    );

    if (!log) {
      return res.status(404).json({
        success: false,
        message: 'Log not found, already active, or past the 30-day restore window.',
      });
    }

    await logEvent({
      req,
      module:        'system',
      action:        'update',
      subAction:     'audit_log_restore',
      severity:      'warning',
      changeSummary: `Super admin restored audit log ${id}`,
      metadata:      { restoredLogId: id },
    });

    return res.status(200).json({ success: true, message: 'Audit log restored successfully.', data: { id } });

  } catch (err) {
    console.error('[auditLogController] restoreLogById error:', err);
    return res.status(500).json({ success: false, message: 'Failed to restore audit log.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * restoreLogs (bulk)
 *
 * Bulk-restore soft-deleted logs within the 30-day window.
 * Super admin only.
 *
 * Body:
 * {
 *   ids?:          string[]            — restore specific log IDs
 *   restoreScope?: 'by_client' | 'by_actor'
 *   clientId?:     string              — required for by_client scope
 *   userId?:       string              — required for by_actor scope
 *   confirm:       true                — required safety flag
 * }
 */
const restoreLogs = async (req, res) => {
  try {
    if (req.user?.userType !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Only super admins can bulk restore audit logs.' });
    }

    const { ids, restoreScope, clientId, userId, confirm } = req.body;

    if (confirm !== true) {
      return res.status(400).json({ success: false, message: 'Must pass confirm: true in request body.' });
    }

    const baseFilter = { isDeleted: true, deletedAt: { $gte: _ttlCutoff() } };
    let   extraFilter = {};

    if (Array.isArray(ids) && ids.length > 0) {
      const validIds = ids
        .filter(id => mongoose.Types.ObjectId.isValid(id))
        .map(id => new mongoose.Types.ObjectId(id));

      if (validIds.length === 0) {
        return res.status(400).json({ success: false, message: 'No valid ObjectIds provided in ids array.' });
      }
      extraFilter._id = { $in: validIds };

    } else if (restoreScope === 'by_client') {
      if (!clientId) return res.status(400).json({ success: false, message: 'clientId required for by_client scope.' });
      extraFilter.clientId = clientId;

    } else if (restoreScope === 'by_actor') {
      if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({ success: false, message: 'Valid userId required for by_actor scope.' });
      }
      extraFilter.actorUserId = new mongoose.Types.ObjectId(userId);

    } else {
      return res.status(400).json({
        success: false,
        message: 'Provide either ids[] OR restoreScope (by_client | by_actor) with the required identifier.',
      });
    }

    const result = await AuditLog.updateMany(
      { ...baseFilter, ...extraFilter },
      { $set: { isDeleted: false, deletedAt: null, deletedBy: null } }
    );

    await logEvent({
      req,
      module:        'system',
      action:        'update',
      subAction:     'audit_log_bulk_restore',
      severity:      'warning',
      changeSummary: `Super admin bulk-restored ${result.modifiedCount} audit log(s). Scope: ${restoreScope ?? 'by_ids'}`,
      metadata:      { restoreScope, clientId, userId, restoredCount: result.modifiedCount },
    });

    return res.status(200).json({
      success:       true,
      message:       `${result.modifiedCount} audit log(s) restored successfully.`,
      restoredCount: result.modifiedCount,
    });

  } catch (err) {
    console.error('[auditLogController] restoreLogs error:', err);
    return res.status(500).json({ success: false, message: 'Failed to bulk restore audit logs.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SOFT-DELETE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * deleteLogs (bulk soft-delete)
 *
 * Marks a batch of logs as isDeleted: true.
 * Logs remain in the database and can be restored within 30 days.
 * Super admin only.
 *
 * Body:
 * {
 *   deleteScope: 'all' | 'by_client' | 'by_employee_head' | 'by_employee' | 'by_actor',
 *   clientId?:   string,
 *   userId?:     string,
 *   confirm:     true
 * }
 */
const deleteLogs = async (req, res) => {
  try {
    const user = req.user;
    const { deleteScope, clientId, userId: targetUserId, confirm } = req.body;

    const permCheck = canDeleteLogs(user, deleteScope);
    if (!permCheck.allowed) {
      return res.status(403).json({ success: false, message: permCheck.reason });
    }

    if (confirm !== true) {
      return res.status(400).json({
        success: false,
        message: 'Must pass confirm: true in request body to confirm bulk log deletion.',
      });
    }

    const filter = {};

    switch (deleteScope) {
      case LOG_DELETE_SCOPES.ALL:
        break;

      case LOG_DELETE_SCOPES.BY_CLIENT:
        if (!clientId) return res.status(400).json({ success: false, message: 'clientId is required for by_client scope.' });
        filter.clientId = clientId;
        break;

      case LOG_DELETE_SCOPES.BY_EMPLOYEE_HEAD:
      case LOG_DELETE_SCOPES.BY_EMPLOYEE:
      case LOG_DELETE_SCOPES.BY_ACTOR:
        if (!targetUserId || !mongoose.Types.ObjectId.isValid(targetUserId)) {
          return res.status(400).json({ success: false, message: 'Valid userId is required for this delete scope.' });
        }
        filter.actorUserId = new mongoose.Types.ObjectId(targetUserId);
        break;

      default:
        return res.status(400).json({ success: false, message: 'Unknown deleteScope.' });
    }

    const result = await AuditLog.updateMany(
      { ...filter, isDeleted: false },
      { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: user._id } }
    );

    await logEvent({
      req,
      module:        'system',
      action:        'delete',
      subAction:     'audit_log_soft_delete_bulk',
      severity:      'critical',
      changeSummary: `Super admin soft-deleted ${result.modifiedCount} audit log(s). Scope: ${deleteScope}`,
      metadata:      { deleteScope, clientId, targetUserId, deletedCount: result.modifiedCount },
    });

    return res.status(200).json({
      success:      true,
      message:      `${result.modifiedCount} audit log(s) soft-deleted. Restorable within ${SOFT_DELETE_TTL_DAYS} days.`,
      deletedCount: result.modifiedCount,
    });

  } catch (err) {
    console.error('[auditLogController] deleteLogs error:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete audit logs.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * deleteLogById (single soft-delete)
 * Super admin only.
 */
const deleteLogById = async (req, res) => {
  try {
    const user = req.user;

    const permCheck = canDeleteLogs(user, LOG_DELETE_SCOPES.BY_ACTOR);
    if (!permCheck.allowed) {
      return res.status(403).json({ success: false, message: permCheck.reason });
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid log ID.' });
    }

    const log = await AuditLog.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: user._id } },
      { new: true }
    );

    if (!log) {
      return res.status(404).json({ success: false, message: 'Audit log not found or already deleted.' });
    }

    return res.status(200).json({
      success: true,
      message: `Audit log soft-deleted. Restorable within ${SOFT_DELETE_TTL_DAYS} days.`,
      data:    { id },
    });

  } catch (err) {
    console.error('[auditLogController] deleteLogById error:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete audit log.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PERMANENT DELETE ENDPOINTS (super_admin only — irreversible)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * permanentDeleteLogById
 *
 * Permanently removes a single audit log from the database.
 * IRREVERSIBLE. Super admin only.
 */
const permanentDeleteLogById = async (req, res) => {
  try {
    if (req.user?.userType !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Only super admins can permanently delete audit logs.' });
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid log ID.' });
    }

    const log = await AuditLog.findByIdAndDelete(id);
    if (!log) {
      return res.status(404).json({ success: false, message: 'Audit log not found.' });
    }

    await logEvent({
      req,
      module:        'system',
      action:        'delete',
      subAction:     'permanent_delete_single',
      severity:      'critical',
      changeSummary: `Super admin permanently deleted audit log ${id} (module: ${log.module}, action: ${log.action})`,
      metadata:      { deletedLogId: id, module: log.module, action: log.action, clientId: log.clientId },
    });

    return res.status(200).json({ success: true, message: 'Audit log permanently deleted.', data: { id } });

  } catch (err) {
    console.error('[auditLogController] permanentDeleteLogById error:', err);
    return res.status(500).json({ success: false, message: 'Failed to permanently delete audit log.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * permanentDeleteLogs (bulk)
 *
 * Bulk permanently deletes audit logs by scope.
 * IRREVERSIBLE. Super admin only.
 *
 * Body:
 * {
 *   deleteScope:  'all' | 'by_client' | 'by_actor',
 *   clientId?:    string,
 *   userId?:      string,
 *   onlyDeleted?: boolean   — if true, only hard-delete already soft-deleted records
 *   confirm:      true
 * }
 */
const permanentDeleteLogs = async (req, res) => {
  try {
    if (req.user?.userType !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Only super admins can permanently delete audit logs.' });
    }

    const {
      deleteScope,
      clientId,
      userId: targetUserId,
      onlyDeleted = false,
      confirm,
    } = req.body;

    if (confirm !== true) {
      return res.status(400).json({
        success: false,
        message: 'Must pass confirm: true in request body to confirm permanent deletion.',
      });
    }

    const filter = {};
    if (onlyDeleted) filter.isDeleted = true;

    switch (deleteScope) {
      case 'all':
        break;

      case 'by_client':
        if (!clientId) return res.status(400).json({ success: false, message: 'clientId required for by_client scope.' });
        filter.clientId = clientId;
        break;

      case 'by_actor':
        if (!targetUserId || !mongoose.Types.ObjectId.isValid(targetUserId)) {
          return res.status(400).json({ success: false, message: 'Valid userId required for by_actor scope.' });
        }
        filter.actorUserId = new mongoose.Types.ObjectId(targetUserId);
        break;

      default:
        return res.status(400).json({ success: false, message: 'Unknown deleteScope. Use: all | by_client | by_actor' });
    }

    const result = await AuditLog.deleteMany(filter);

    await logEvent({
      req,
      module:        'system',
      action:        'delete',
      subAction:     'permanent_delete_bulk',
      severity:      'critical',
      changeSummary: `Super admin permanently deleted ${result.deletedCount} audit log(s). Scope: ${deleteScope}`,
      metadata:      { deleteScope, clientId, targetUserId, deletedCount: result.deletedCount, onlyDeleted },
    });

    return res.status(200).json({
      success:      true,
      message:      `${result.deletedCount} audit log(s) permanently deleted.`,
      deletedCount: result.deletedCount,
    });

  } catch (err) {
    console.error('[auditLogController] permanentDeleteLogs error:', err);
    return res.status(500).json({ success: false, message: 'Failed to permanently delete audit logs.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// MAINTENANCE / CRON
// ─────────────────────────────────────────────────────────────────────────────

/**
 * purgeExpiredLogs
 *
 * Permanently deletes all soft-deleted logs whose deletedAt is older than 30 days.
 *
 * Dual-mode:
 *   HTTP  — called by super_admin via DELETE /api/audit-logs/purge-expired
 *           (requires { confirm: true } in body)
 *   Cron  — called directly from your scheduler: purgeExpiredLogs(null, null)
 *           Returns a result summary instead of sending an HTTP response.
 *
 * Cron usage example (node-cron / agenda):
 *   const { purgeExpiredLogs } = require('./controllers/AuditLog/auditLogController');
 *   cron.schedule('0 2 * * *', () => purgeExpiredLogs(null, null));
 */
const purgeExpiredLogs = async (req, res) => {
  const isCronCall = !req || !res;

  try {
    if (!isCronCall) {
      if (req.user?.userType !== 'super_admin') {
        return res.status(403).json({ success: false, message: 'Only super admins can trigger log purge.' });
      }
      if (req.body?.confirm !== true) {
        return res.status(400).json({
          success: false,
          message: 'Must pass confirm: true in request body to trigger purge.',
        });
      }
    }

    const cutoff = _ttlCutoff();

    const result = await AuditLog.deleteMany({
      isDeleted: true,
      deletedAt: { $lte: cutoff },
    });

    const summary = {
      purgedCount: result.deletedCount,
      cutoffDate:  cutoff,
      purgedAt:    new Date(),
    };

    if (!isCronCall) {
      await logEvent({
        req,
        module:        'system',
        action:        'delete',
        subAction:     'ttl_purge',
        severity:      'critical',
        changeSummary: `TTL purge: permanently deleted ${result.deletedCount} audit log(s) older than ${SOFT_DELETE_TTL_DAYS} days`,
        metadata:      summary,
      });

      return res.status(200).json({
        success: true,
        message: `${result.deletedCount} expired audit log(s) permanently purged.`,
        ...summary,
      });
    }

    // Cron path — print and return for the scheduler
    console.log(`[purgeExpiredLogs] Cron: purged ${result.deletedCount} expired logs. Cutoff: ${cutoff.toISOString()}`);
    return summary;

  } catch (err) {
    console.error('[auditLogController] purgeExpiredLogs error:', err);
    if (!isCronCall) {
      return res.status(500).json({ success: false, message: 'Failed to purge expired logs.' });
    }
    throw err; // let the cron framework handle it
  }
};

// ── Exports ───────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// UNIFIED SEARCH  —  replaces calling getLogs/getLogStats/getDeletedLogs/getLogsByModule separately
// ─────────────────────────────────────────────────────────────────────────────

/**
 * searchLogs
 *
 * One endpoint that covers every audit log GET use-case.
 * Controlled via the `view` query parameter:
 *
 *   view=list    (default) — paginated + filtered log list
 *   view=stats             — aggregated counts by module/action/severity/source + 14-day trend
 *   view=deleted           — soft-deleted logs within the 30-day restore window
 *   view=module            — module-scoped fast fetch (requires &module=<value>)
 *
 * ALL filter / sort / pagination params work in every view:
 *
 *   search            free-text across actorName, email, changeSummary, entityId,
 *                     entityType, subAction, targetUserName, clientId
 *   clientId          exact match
 *   actorUserId       ObjectId
 *   targetUserId      ObjectId
 *   consultantAdminId ObjectId
 *   module            comma-sep: data_entry,reduction,sbti
 *   action            comma-sep: create,update,delete,calculate
 *   status            success | failure
 *   severity          comma-sep: info,warning,critical
 *   source            manual | api | iot | system | cron | socket
 *   entityType        comma-sep
 *   entityId          exact string
 *   subAction         e.g. hard_delete | input_type_switch
 *   startDate/endDate ISO date strings
 *   page / limit      default 1 / 20, max 100
 *   sortBy            createdAt | module | action | actorName | clientId |
 *                     severity | status | source | entityType
 *   sortOrder         asc | desc (default desc)
 *   includeDeleted    true → include soft-deleted rows (super_admin only, view=list)
 *
 * For view=module: also pass &module=data_entry  (comma-sep for multi: data_entry,reduction)
 *
 * The req.logAccessQuery set by attachLogAccessContext middleware already
 * enforces role-based row-level isolation — searchLogs simply merges it with
 * the caller's own filters.
 */
const searchLogs = async (req, res) => {
  try {
    const { view = 'list' } = req.query;

    // ── VIEW: list ────────────────────────────────────────────────────────────
    if (view === 'list') {
      const baseQuery    = req.logAccessQuery || {};
      const extraFilters = _buildExtraFilters(req.query);

      const includeDeleted =
        req.query.includeDeleted === 'true' && req.user?.userType === 'super_admin';

      const finalQuery = {
        ...baseQuery,
        ...extraFilters,
        ...(includeDeleted ? {} : { isDeleted: false }),
      };

      const { pageNum, limitNum, skip } = _parsePagination(req.query);
      const sort = _parseSort(req.query);

      const [logs, total] = await Promise.all([
        AuditLog.find(finalQuery).sort(sort).skip(skip).limit(limitNum).lean(),
        AuditLog.countDocuments(finalQuery),
      ]);

      return res.status(200).json({
        success: true,
        view: 'list',
        data: logs,
        pagination: _paginationMeta(total, pageNum, limitNum, skip),
      });
    }

    // ── VIEW: stats ───────────────────────────────────────────────────────────
    if (view === 'stats') {
      const baseQuery    = req.logAccessQuery || {};
      const extraFilters = _buildExtraFilters(req.query);
      const matchStage   = { ...baseQuery, isDeleted: false, ...extraFilters };

      const groupCount = (field) => [
        { $match: matchStage },
        { $group: { _id: `$${field}`, count: { $sum: 1 } } },
        { $sort:  { count: -1 } },
      ];

      const trendStart = new Date();
      trendStart.setDate(trendStart.getDate() - 13);
      trendStart.setHours(0, 0, 0, 0);

      const [total, byModule, byAction, byStatus, bySeverity, bySource, topActors, dailyTrend] =
        await Promise.all([
          AuditLog.countDocuments(matchStage),
          AuditLog.aggregate(groupCount('module')),
          AuditLog.aggregate(groupCount('action')),
          AuditLog.aggregate(groupCount('status')),
          AuditLog.aggregate(groupCount('severity')),
          AuditLog.aggregate(groupCount('source')),
          AuditLog.aggregate([
            { $match: matchStage },
            { $sort: { createdAt: -1 } },
            { $group: {
              _id:           '$actorUserId',
              actorName:     { $first: '$actorName' },
              actorUserType: { $first: '$actorUserType' },
              lastAction:    { $first: '$createdAt' },
              count:         { $sum: 1 },
            }},
            { $sort: { count: -1 } },
            { $limit: 10 },
          ]),
          AuditLog.aggregate([
            { $match: { ...matchStage, createdAt: { $gte: trendStart } } },
            { $group: {
              _id: {
                year:  { $year: '$createdAt' },
                month: { $month: '$createdAt' },
                day:   { $dayOfMonth: '$createdAt' },
              },
              count: { $sum: 1 },
            }},
            { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
          ]),
        ]);

      const toMap = (arr) => arr.reduce((acc, x) => ({ ...acc, [x._id]: x.count }), {});

      return res.status(200).json({
        success: true,
        view: 'stats',
        data: {
          total,
          byModule:   toMap(byModule),
          byAction:   toMap(byAction),
          byStatus:   toMap(byStatus),
          bySeverity: toMap(bySeverity),
          bySource:   toMap(bySource),
          topActors,
          dailyTrend: dailyTrend.map(d => ({
            date:  `${d._id.year}-${String(d._id.month).padStart(2,'0')}-${String(d._id.day).padStart(2,'0')}`,
            count: d.count,
          })),
        },
      });
    }

    // ── VIEW: deleted ─────────────────────────────────────────────────────────
    if (view === 'deleted') {
      const baseQuery    = req.logAccessQuery || {};
      const extraFilters = _buildExtraFilters(req.query);

      const finalQuery = {
        ...baseQuery,
        ...extraFilters,
        isDeleted: true,
        deletedAt: { $gte: _ttlCutoff() },
      };

      const { pageNum, limitNum, skip } = _parsePagination(req.query);
      const sort = _parseSort(req.query);

      const [logs, total] = await Promise.all([
        AuditLog.find(finalQuery).sort(sort).skip(skip).limit(limitNum).lean(),
        AuditLog.countDocuments(finalQuery),
      ]);

      return res.status(200).json({
        success: true,
        view: 'deleted',
        meta: {
          restoreWindowDays: SOFT_DELETE_TTL_DAYS,
          expiresBefore:     _ttlCutoff(),
        },
        data: logs,
        pagination: _paginationMeta(total, pageNum, limitNum, skip),
      });
    }

    // ── VIEW: module ──────────────────────────────────────────────────────────
    if (view === 'module') {
      const { module: modParam } = req.query;

      if (!modParam) {
        return res.status(400).json({
          success: false,
          message: 'module param is required for view=module. Example: ?view=module&module=data_entry',
        });
      }

      // Support comma-separated multi-module: ?module=data_entry,reduction
      const requestedModules = modParam.split(',').map(m => m.trim()).filter(Boolean);
      const baseQuery        = req.logAccessQuery || {};
      const extraFilters     = _buildExtraFilters(req.query);

      // module from the query param overrides any module in extraFilters
      const { module: _ignored, ...restFilters } = extraFilters;
      const moduleFilter = requestedModules.length === 1
        ? requestedModules[0]
        : { $in: requestedModules };

      const finalQuery = {
        ...baseQuery,
        ...restFilters,
        module:    moduleFilter,
        isDeleted: false,
      };

      const { pageNum, limitNum, skip } = _parsePagination(req.query);
      const sort = _parseSort(req.query);

      const [logs, total] = await Promise.all([
        AuditLog.find(finalQuery).sort(sort).skip(skip).limit(limitNum).lean(),
        AuditLog.countDocuments(finalQuery),
      ]);

      return res.status(200).json({
        success: true,
        view: 'module',
        modules: requestedModules,
        data: logs,
        pagination: _paginationMeta(total, pageNum, limitNum, skip),
      });
    }

    // ── Unknown view ──────────────────────────────────────────────────────────
    return res.status(400).json({
      success: false,
      message: `Unknown view '${view}'. Valid values: list | stats | deleted | module`,
    });

  } catch (err) {
    console.error('[auditLogController] searchLogs error:', err);
    return res.status(500).json({ success: false, message: 'Search failed.' });
  }
};

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  setSocketIO,
  // Unified search (single endpoint for all GET use-cases)
  searchLogs,
  // Individual read endpoints (kept for backwards compatibility)
  getLogs,
  getLogsByModule,
  getLogStats,
  getDeletedLogs,
  getLogById,
  // Restore
  restoreLogById,
  restoreLogs,
  // Soft delete
  deleteLogs,
  deleteLogById,
  // Permanent delete
  permanentDeleteLogById,
  permanentDeleteLogs,
  // Maintenance
  purgeExpiredLogs,
};