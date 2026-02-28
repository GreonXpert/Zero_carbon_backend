'use strict';
// services/audit/reductionAuditLog.js
//
// PURPOSE:
//   Thin wrappers around logEvent() for the 'reduction' module.
//
// USAGE (inside reductionController, after each successful DB write):
//
//   const {
//     logReductionCreate,
//     logReductionUpdate,
//     logReductionDelete,
//     logReductionHardDelete,
//     logReductionInputTypeSwitch,
//     logReductionCalculate,
//   } = require('../../services/audit/reductionAuditLog');
//
//   // after reduction.save()
//   await logReductionCreate(req, reduction);

const { logEvent } = require('./auditLogService');

const _id = (v) => (v?._id ?? v?.id ?? v ?? '').toString();

// ─── exported helpers ─────────────────────────────────────────────────────────

/**
 * Log a new Reduction project being created.
 *
 * @param {object} req       - Express request
 * @param {object} reduction - Saved Reduction document
 */
async function logReductionCreate(req, reduction) {
  try {
    await logEvent({
      req,
      module:        'reduction',
      action:        'create',
      entityType:    'Reduction',
      entityId:      _id(reduction),
      clientId:      reduction.clientId,
      changeSummary: `Reduction project created — "${reduction.projectName ?? reduction.projectId}"`,
      metadata: {
        projectId:             reduction.projectId,
        projectName:           reduction.projectName ?? null,
        calculationMethodology: reduction.calculationMethodology ?? null,
        inputType:             reduction.reductionDataEntry?.inputType ?? 'manual',
      },
      source:   _resolveSource(reduction.reductionDataEntry?.inputType),
      severity: 'info',
    });
  } catch (err) {
    console.error('[reductionAuditLog] logReductionCreate:', err.message);
  }
}

/**
 * Log a Reduction project being updated.
 *
 * @param {object} req       - Express request
 * @param {object} reduction - Updated Reduction document (post-save)
 * @param {string} [hint]    - Optional human-readable summary of what changed
 */
async function logReductionUpdate(req, reduction, hint = '') {
  try {
    await logEvent({
      req,
      module:        'reduction',
      action:        'update',
      entityType:    'Reduction',
      entityId:      _id(reduction),
      clientId:      reduction.clientId,
      changeSummary: hint || `Reduction project updated — "${reduction.projectName ?? reduction.projectId}"`,
      metadata: {
        projectId:   reduction.projectId,
        projectName: reduction.projectName ?? null,
        inputType:   reduction.reductionDataEntry?.inputType ?? 'manual',
      },
      source:   _resolveSource(reduction.reductionDataEntry?.inputType),
      severity: 'info',
    });
  } catch (err) {
    console.error('[reductionAuditLog] logReductionUpdate:', err.message);
  }
}

/**
 * Log a Reduction project being soft-deleted.
 *
 * @param {object} req       - Express request
 * @param {object} reduction - Reduction document before deletion
 */
async function logReductionDelete(req, reduction) {
  try {
    await logEvent({
      req,
      module:        'reduction',
      action:        'delete',
      subAction:     'soft_delete',
      entityType:    'Reduction',
      entityId:      _id(reduction),
      clientId:      reduction.clientId,
      changeSummary: `Reduction project soft-deleted — "${reduction.projectName ?? reduction.projectId}"`,
      metadata: {
        projectId:   reduction.projectId,
        projectName: reduction.projectName ?? null,
      },
      severity: 'warning',
    });
  } catch (err) {
    console.error('[reductionAuditLog] logReductionDelete:', err.message);
  }
}

/**
 * Log a Reduction project being hard (permanently) deleted.
 *
 * @param {object} req       - Express request
 * @param {object} reduction - Reduction document that was destroyed
 */
async function logReductionHardDelete(req, reduction) {
  try {
    await logEvent({
      req,
      module:        'reduction',
      action:        'delete',
      subAction:     'hard_delete',
      entityType:    'Reduction',
      entityId:      _id(reduction),
      clientId:      reduction.clientId,
      changeSummary: `Reduction project permanently deleted — "${reduction.projectName ?? reduction.projectId}"`,
      metadata: {
        projectId:   reduction.projectId,
        projectName: reduction.projectName ?? null,
      },
      severity: 'critical',
    });
  } catch (err) {
    console.error('[reductionAuditLog] logReductionHardDelete:', err.message);
  }
}

/**
 * Log inputType being switched on a Reduction project.
 *
 * @param {object} req       - Express request
 * @param {object} reduction - Reduction document after the switch
 * @param {string} oldType   - Previous inputType
 * @param {string} newType   - New inputType
 */
async function logReductionInputTypeSwitch(req, reduction, oldType, newType) {
  try {
    await logEvent({
      req,
      module:        'reduction',
      action:        'update',
      subAction:     'input_type_switch',
      entityType:    'Reduction',
      entityId:      _id(reduction),
      clientId:      reduction.clientId,
      changeSummary: `Reduction inputType changed '${oldType}' → '${newType}' — project: ${reduction.projectId}`,
      metadata: {
        projectId:   reduction.projectId,
        oldInputType: oldType,
        newInputType: newType,
      },
      severity: 'info',
    });
  } catch (err) {
    console.error('[reductionAuditLog] logReductionInputTypeSwitch:', err.message);
  }
}

/**
 * Log emission calculation being run for a Reduction project.
 *
 * @param {object} req       - Express request
 * @param {object} reduction - Reduction document after calculation
 */
async function logReductionCalculate(req, reduction) {
  try {
    const netReduction = reduction.calculatedReductions?.breakdown?.netReduction?.incoming ?? null;
    await logEvent({
      req,
      module:        'reduction',
      action:        'calculate',
      entityType:    'Reduction',
      entityId:      _id(reduction),
      clientId:      reduction.clientId,
      changeSummary: `Reduction calculated — project: ${reduction.projectId}, netReduction: ${netReduction}`,
      metadata: {
        projectId:             reduction.projectId,
        calculationMethodology: reduction.calculationMethodology ?? null,
        netReduction,
      },
      severity: 'info',
    });
  } catch (err) {
    console.error('[reductionAuditLog] logReductionCalculate:', err.message);
  }
}

// ─── private ──────────────────────────────────────────────────────────────────

function _resolveSource(inputType) {
  const t = (inputType ?? 'manual').toString().toUpperCase();
  if (t === 'API') return 'api';
  if (t === 'IOT') return 'iot';
  return 'manual';
}

// ─── exports ──────────────────────────────────────────────────────────────────

module.exports = {
  logReductionCreate,
  logReductionUpdate,
  logReductionDelete,
  logReductionHardDelete,
  logReductionInputTypeSwitch,
  logReductionCalculate,
};