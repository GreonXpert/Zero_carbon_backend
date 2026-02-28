'use strict';
// services/auditLogService.js
//
// SINGLE WRITE API for all audit log creation across the platform.
//
// HOW TO USE:
//   const { logEvent } = require('../../services/auditLogService');
//
//   // In any controller after a successful operation:
//   await logEvent({
//     req,                          // Express request (extracts actor, IP, userAgent)
//     module:       'data_entry',
//     action:       'create',
//     entityType:   'DataEntry',
//     entityId:     savedEntry._id.toString(),
//     clientId:     savedEntry.clientId,
//     changeSummary: `Added ${inputType} entry for scope ${scopeIdentifier}`,
//     metadata:     { nodeId, scopeIdentifier, inputType },
//   });
//
//   // Or fire-and-forget (never throws, logs errors silently):
//   logEvent({ ... }).catch(() => {});
//
// NOTES:
//   - Never pass raw documents or passwords into changeSummary / metadata.
//   - Keep metadata small (<1KB). Large payloads are truncated silently.
//   - The function is async but intentionally safe — a logging failure never
//     crashes the calling controller.

const AuditLog = require('../../models/AuditLog/AuditLog');
const User     = require('../../models/User');
const Client   = require('../../models/CMS/Client');

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Safely stringify and size-cap a metadata object.
 * Returns null if empty or over-sized.
 */
function _sanitizeMetadata(raw) {
  if (!raw || typeof raw !== 'object') return raw || null;

  // Strip obviously sensitive keys
  const BLOCKED = new Set(['password', 'token', 'secret', 'apiKey', 'api_key', 'key', 'hash', 'salt']);
  const cleaned = {};
  for (const [k, v] of Object.entries(raw)) {
    if (BLOCKED.has(k.toLowerCase())) continue;
    cleaned[k] = v;
  }

  // Size cap: ~2KB
  try {
    const json = JSON.stringify(cleaned);
    if (json.length > 2048) {
      return { _truncated: true, note: 'Metadata exceeded 2KB and was stripped.' };
    }
    return cleaned;
  } catch {
    return { _truncated: true, note: 'Metadata serialization failed.' };
  }
}

/**
 * Attempt to look up the consultantAdminId for a given clientId.
 * Returns null on any error or cache hit not available — non-critical.
 */
const _clientConsultantCache = new Map(); // simple in-process cache

async function _getConsultantAdminIdForClient(clientId) {
  if (!clientId) return null;
  if (_clientConsultantCache.has(clientId)) return _clientConsultantCache.get(clientId);

  try {
    const client = await Client.findOne({ clientId })
      .select('leadInfo.consultantAdminId')
      .lean();
    const id = client?.leadInfo?.consultantAdminId?.toString() || null;
    _clientConsultantCache.set(clientId, id);
    // Expire cache entry after 5 min to handle reassignments
    setTimeout(() => _clientConsultantCache.delete(clientId), 5 * 60 * 1000);
    return id;
  } catch {
    return null;
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * logEvent
 *
 * Creates a single AuditLog document. Emits a socket event via global.io
 * so connected dashboards receive it in real-time.
 *
 * @param {object} params
 * @param {object}  params.req          - Express request object (optional but recommended)
 * @param {object}  [params.actor]      - Explicit actor if req.user unavailable
 * @param {string}  params.module       - one of MODULE_ENUM
 * @param {string}  params.action       - one of ACTION_ENUM
 * @param {string}  [params.subAction]  - optional finer grain
 * @param {string}  [params.entityType] - model/entity name
 * @param {string}  [params.entityId]   - record id
 * @param {string}  [params.clientId]   - client scope
 * @param {string}  [params.targetUserId]
 * @param {string}  [params.targetUserName]
 * @param {string}  [params.targetUserType]
 * @param {string}  [params.changeSummary]
 * @param {object}  [params.metadata]
 * @param {string}  [params.source]     - 'manual'|'api'|'iot'|'system'|'cron'|'socket'
 * @param {string}  [params.status]     - 'success'|'failure'
 * @param {string}  [params.severity]   - 'info'|'warning'|'critical'
 * @param {string}  [params.errorMessage]
 * @returns {Promise<AuditLog|null>}   null if logging fails (never throws)
 */
async function logEvent(params) {
  try {
    const {
      req,
      actor: explicitActor,
      module,
      action,
      subAction        = null,
      entityType       = null,
      entityId         = null,
      clientId         = null,
      targetUserId     = null,
      targetUserName   = null,
      targetUserType   = null,
      changeSummary    = null,
      metadata         = null,
      source           = 'manual',
      status           = 'success',
      severity         = 'info',
      errorMessage     = null,
    } = params;

    // ── Resolve actor ────────────────────────────────────────────────────────
    const actor = explicitActor || req?.user;
    if (!actor) {
      console.warn('[auditLogService] logEvent called without actor — skipping log.');
      return null;
    }

    const actorUserId   = actor._id || actor.id;
    const actorUserType = actor.userType || 'unknown';
    const actorName     = actor.userName || actor.name || 'unknown';
    const actorEmail    = actor.email || null;

    // ── Resolve clientId (use actor's if not provided) ───────────────────────
    const resolvedClientId = clientId || actor.clientId || null;

    // ── Resolve consultantAdminId (for query scoping) ────────────────────────
    let consultantAdminId = null;
    if (resolvedClientId) {
      const cachedId = await _getConsultantAdminIdForClient(resolvedClientId);
      if (cachedId) {
        consultantAdminId = new (require('mongoose').Types.ObjectId)(cachedId);
      }
    }

    // ── Extract request context ──────────────────────────────────────────────
    const requestInfo = req ? {
      method:    req.method   || null,
      path:      req.originalUrl || req.path || null,
      ip:        req.ip || req.connection?.remoteAddress || null,
      userAgent: (req.headers?.['user-agent'] || '').substring(0, 300),
    } : {};

    // ── Build document ───────────────────────────────────────────────────────
    const logDoc = await AuditLog.create({
      clientId:          resolvedClientId,
      actorUserId:       actorUserId,
      actorUserType,
      actorName,
      actorEmail,
      consultantAdminId,
      module,
      entityType,
      entityId:          entityId ? String(entityId) : null,
      action,
      subAction,
      targetUserId:      targetUserId  ? new (require('mongoose').Types.ObjectId)(String(targetUserId)) : null,
      targetUserName,
      targetUserType,
      changeSummary:     changeSummary ? String(changeSummary).substring(0, 500) : null,
      metadata:          _sanitizeMetadata(metadata),
      requestInfo,
      source,
      status,
      severity,
      errorMessage:      errorMessage ? String(errorMessage).substring(0, 500) : null,
    });

    // ── Real-time socket broadcast ───────────────────────────────────────────
    _broadcastAuditLog(logDoc.toObject());

    return logDoc;

  } catch (err) {
    // Logging must NEVER crash the calling controller
    console.error('[auditLogService] Failed to write audit log:', err.message);
    return null;
  }
}

/**
 * logEventFireAndForget
 *
 * Identical to logEvent but never returns a promise — used in controllers
 * where you don't want to await the log write.
 * Errors are silently swallowed.
 */
function logEventFireAndForget(params) {
  logEvent(params).catch((err) =>
    console.error('[auditLogService] Fire-and-forget error:', err.message)
  );
}

// ── Socket broadcast (scoped by role) ────────────────────────────────────────

/**
 * _broadcastAuditLog
 *
 * Emits `audit:new` to the appropriate socket rooms based on the log's clientId
 * and the consultantAdminId so that only authorised dashboard subscribers receive it.
 *
 * Room strategy (mirrors existing patterns in index.js):
 *   - super_admin always receives every log via room `userType_super_admin`
 *   - consultant_admin receives via room `consultant_admin_${consultantAdminId}`
 *   - client org receives via room `audit_client_${clientId}`
 *   (Clients subscribe to these rooms from the frontend after authentication)
 */
function _broadcastAuditLog(logObj) {
  try {
    const io = global.io;
    if (!io) return;

    const payload = {
      log: logObj,
      timestamp: new Date().toISOString(),
    };

    // Always notify super admins
    io.to('userType_super_admin').emit('audit:new', payload);

    // Notify the consultant admin who owns this client
    if (logObj.consultantAdminId) {
      io.to(`consultant_admin_${logObj.consultantAdminId}`).emit('audit:new', payload);
    }

    // Notify client org room (client_admin, employee_head, etc. who joined this room)
    if (logObj.clientId) {
      io.to(`audit_client_${logObj.clientId}`).emit('audit:new', payload);
    }

  } catch (err) {
    console.error('[auditLogService] Socket broadcast error:', err.message);
  }
}

// ── Convenience wrappers ──────────────────────────────────────────────────────

/** Log a successful login event */
async function logLogin(req, user) {
  return logEvent({
    req,
    actor:  user,
    module: 'auth',
    action: 'login',
    clientId: user.clientId || null,
    source: 'manual',
    severity: 'info',
    changeSummary: `User ${user.userName} (${user.userType}) logged in`,
  });
}

/** Log a failed login attempt */
async function logLoginFailed(req, identifier) {
  return logEvent({
    req,
    // No real actor — create a minimal synthetic one
    actor: {
      _id: new (require('mongoose').Types.ObjectId)(),
      userType: 'unknown',
      userName: identifier || 'unknown',
      email: null,
    },
    module:   'auth',
    action:   'login_failed',
    source:   'manual',
    status:   'failure',
    severity: 'warning',
    changeSummary: `Failed login attempt for identifier: ${identifier}`,
  });
}

/** Log user creation */
async function logUserCreated(req, createdUser) {
  return logEvent({
    req,
    module:        'user_management',
    action:        'create',
    entityType:    'User',
    entityId:      createdUser._id.toString(),
    clientId:      createdUser.clientId || null,
    targetUserId:  createdUser._id,
    targetUserName: createdUser.userName,
    targetUserType: createdUser.userType,
    changeSummary: `Created ${createdUser.userType} account: ${createdUser.userName}`,
  });
}

/** Log data entry creation */
async function logDataEntry(req, entry, subAction = null) {
  return logEvent({
    req,
    module:       'data_entry',
    action:       'create',
    subAction,
    entityType:   'DataEntry',
    entityId:     entry._id.toString(),
    clientId:     entry.clientId,
    changeSummary: `Data entry added for scope ${entry.scopeIdentifier} | node ${entry.nodeId}`,
    metadata: {
      nodeId:          entry.nodeId,
      scopeIdentifier: entry.scopeIdentifier,
      inputType:       entry.inputType,
    },
  });
}

/** Log manual data entry edit */
async function logDataEntryEdit(req, entry, summary) {
  return logEvent({
    req,
    module:       'data_entry',
    action:       'update',
    subAction:    'manual_edit',
    entityType:   'DataEntry',
    entityId:     entry._id.toString(),
    clientId:     entry.clientId,
    changeSummary: summary || `Manual edit on data entry for scope ${entry.scopeIdentifier}`,
    metadata: {
      nodeId:          entry.nodeId,
      scopeIdentifier: entry.scopeIdentifier,
    },
  });
}

module.exports = {
  logEvent,
  logEventFireAndForget,
  // Convenience wrappers
  logLogin,
  logLoginFailed,
  logUserCreated,
  logDataEntry,
  logDataEntryEdit,
};