'use strict';
// services/audit/sbtiAuditLog.js
//
// PURPOSE:
//   Thin wrappers around logEvent() for the 'sbti' module.
//
// USAGE (inside sbtiController, after each successful DB write):
//
//   const {
//     logSbtiCreate,
//     logSbtiUpdate,
//     logSbtiDelete,
//     logSbtiHardDelete,
//     logSbtiTargetApprove,
//     logSbtiTargetReject,
//   } = require('../../services/audit/sbtiAuditLog');
//
//   await logSbtiCreate(req, sbtiTarget);

const { logEvent } = require('./auditLogService');

const _id = (v) => (v?._id ?? v?.id ?? v ?? '').toString();

// ─── exported helpers ─────────────────────────────────────────────────────────

/**
 * Log a new SBTi target being created.
 *
 * @param {object} req    - Express request
 * @param {object} target - Saved SbtiTarget document
 */
async function logSbtiCreate(req, target) {
  try {
    await logEvent({
      req,
      module:        'sbti',
      action:        'create',
      entityType:    'SbtiTarget',
      entityId:      _id(target),
      clientId:      target.clientId,
      changeSummary: `SBTi target created — client: ${target.clientId}, targetYear: ${target.targetYear ?? 'N/A'}`,
      metadata: {
        targetYear:        target.targetYear ?? null,
        baselineYear:      target.baselineYear ?? null,
        targetType:        target.targetType ?? null,
        scope1Target:      target.scope1Target ?? null,
        scope2Target:      target.scope2Target ?? null,
        scope3Target:      target.scope3Target ?? null,
        temperatureGoal:   target.temperatureGoal ?? null,
      },
      severity: 'info',
    });
  } catch (err) {
    console.error('[sbtiAuditLog] logSbtiCreate:', err.message);
  }
}

/**
 * Log an existing SBTi target being updated.
 *
 * @param {object} req    - Express request
 * @param {object} target - Updated SbtiTarget document (post-save)
 * @param {string} [hint] - Optional human-readable summary of what changed
 */
async function logSbtiUpdate(req, target, hint = '') {
  try {
    await logEvent({
      req,
      module:        'sbti',
      action:        'update',
      entityType:    'SbtiTarget',
      entityId:      _id(target),
      clientId:      target.clientId,
      changeSummary: hint || `SBTi target updated — client: ${target.clientId}, targetYear: ${target.targetYear ?? 'N/A'}`,
      metadata: {
        targetYear:      target.targetYear ?? null,
        baselineYear:    target.baselineYear ?? null,
        targetType:      target.targetType ?? null,
        temperatureGoal: target.temperatureGoal ?? null,
      },
      severity: 'info',
    });
  } catch (err) {
    console.error('[sbtiAuditLog] logSbtiUpdate:', err.message);
  }
}

/**
 * Log an SBTi target being soft-deleted.
 *
 * @param {object} req    - Express request
 * @param {object} target - SbtiTarget document being deleted
 */
async function logSbtiDelete(req, target) {
  try {
    await logEvent({
      req,
      module:        'sbti',
      action:        'delete',
      subAction:     'soft_delete',
      entityType:    'SbtiTarget',
      entityId:      _id(target),
      clientId:      target.clientId,
      changeSummary: `SBTi target soft-deleted — client: ${target.clientId}, targetYear: ${target.targetYear ?? 'N/A'}`,
      metadata: {
        targetYear:  target.targetYear ?? null,
        targetType:  target.targetType ?? null,
      },
      severity: 'warning',
    });
  } catch (err) {
    console.error('[sbtiAuditLog] logSbtiDelete:', err.message);
  }
}

/**
 * Log an SBTi target being permanently deleted.
 *
 * @param {object} req    - Express request
 * @param {object} target - SbtiTarget document being destroyed
 */
async function logSbtiHardDelete(req, target) {
  try {
    await logEvent({
      req,
      module:        'sbti',
      action:        'delete',
      subAction:     'hard_delete',
      entityType:    'SbtiTarget',
      entityId:      _id(target),
      clientId:      target.clientId,
      changeSummary: `SBTi target permanently deleted — client: ${target.clientId}, targetYear: ${target.targetYear ?? 'N/A'}`,
      metadata: {
        targetYear: target.targetYear ?? null,
        targetType: target.targetType ?? null,
      },
      severity: 'critical',
    });
  } catch (err) {
    console.error('[sbtiAuditLog] logSbtiHardDelete:', err.message);
  }
}

/**
 * Log an SBTi target being approved.
 *
 * @param {object} req    - Express request
 * @param {object} target - SbtiTarget document after approval
 */
async function logSbtiTargetApprove(req, target) {
  try {
    await logEvent({
      req,
      module:        'sbti',
      action:        'approve',
      entityType:    'SbtiTarget',
      entityId:      _id(target),
      clientId:      target.clientId,
      changeSummary: `SBTi target approved — client: ${target.clientId}, targetYear: ${target.targetYear ?? 'N/A'}`,
      metadata: {
        targetYear:      target.targetYear ?? null,
        temperatureGoal: target.temperatureGoal ?? null,
        approvedAt:      new Date().toISOString(),
      },
      severity: 'info',
    });
  } catch (err) {
    console.error('[sbtiAuditLog] logSbtiTargetApprove:', err.message);
  }
}

/**
 * Log an SBTi target being rejected.
 *
 * @param {object} req    - Express request
 * @param {object} target - SbtiTarget document after rejection
 * @param {string} [reason] - Optional reason for rejection
 */
async function logSbtiTargetReject(req, target, reason = '') {
  try {
    await logEvent({
      req,
      module:        'sbti',
      action:        'reject',
      entityType:    'SbtiTarget',
      entityId:      _id(target),
      clientId:      target.clientId,
      changeSummary: `SBTi target rejected — client: ${target.clientId}${reason ? `, reason: ${reason}` : ''}`,
      metadata: {
        targetYear:  target.targetYear ?? null,
        reason:      reason || null,
        rejectedAt:  new Date().toISOString(),
      },
      severity: 'warning',
    });
  } catch (err) {
    console.error('[sbtiAuditLog] logSbtiTargetReject:', err.message);
  }
}

/**
 * Log SBTi calculation / projection being run.
 *
 * @param {object} req    - Express request
 * @param {object} target - SbtiTarget document after calculation
 */
async function logSbtiCalculate(req, target) {
  try {
    await logEvent({
      req,
      module:        'sbti',
      action:        'calculate',
      entityType:    'SbtiTarget',
      entityId:      _id(target),
      clientId:      target.clientId,
      changeSummary: `SBTi calculation run — client: ${target.clientId}, targetYear: ${target.targetYear ?? 'N/A'}`,
      metadata: {
        targetYear:    target.targetYear ?? null,
        baselineYear:  target.baselineYear ?? null,
        calculatedAt:  new Date().toISOString(),
      },
      severity: 'info',
    });
  } catch (err) {
    console.error('[sbtiAuditLog] logSbtiCalculate:', err.message);
  }
}

// ─── exports ──────────────────────────────────────────────────────────────────

module.exports = {
  logSbtiCreate,
  logSbtiUpdate,
  logSbtiDelete,
  logSbtiHardDelete,
  logSbtiTargetApprove,
  logSbtiTargetReject,
  logSbtiCalculate,
};