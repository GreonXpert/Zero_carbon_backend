'use strict';
// services/audit/netReductionAuditLog.js
//
// PURPOSE:
//   Thin wrappers around logEvent() for the 'net_reduction' module.
//
// USAGE (inside netReductionController, after each successful DB write):
//
//   const {
//     logNetReductionCreate,
//     logNetReductionUpdate,
//     logNetReductionDelete,
//     logNetReductionHardDelete,
//     logNetReductionCalculate,
//     logNetReductionInputTypeSwitch,
//   } = require('../../services/audit/netReductionAuditLog');
//
//   await logNetReductionCreate(req, entry);

const { logEvent } = require('./auditLogService');

const _id = (v) => (v?._id ?? v?.id ?? v ?? '').toString();

// ─── exported helpers ─────────────────────────────────────────────────────────

/**
 * Log a new NetReductionEntry being created.
 *
 * @param {object} req   - Express request
 * @param {object} entry - Saved NetReductionEntry document
 */
async function logNetReductionCreate(req, entry) {
  try {
    await logEvent({
      req,
      module:        'net_reduction',
      action:        'create',
      entityType:    'NetReductionEntry',
      entityId:      _id(entry),
      clientId:      entry.clientId,
      changeSummary: `Net reduction entry created — project: ${entry.projectId ?? _id(entry)}, methodology: ${entry.calculationMethodology ?? 'N/A'}`,
      metadata: {
        projectId:             entry.projectId ?? null,
        calculationMethodology: entry.calculationMethodology ?? null,
        inputType:             entry.reductionDataEntry?.inputType ?? entry.inputType ?? 'manual',
        period:                entry.period ?? null,
      },
      source:   _resolveSource(entry.reductionDataEntry?.inputType ?? entry.inputType),
      severity: 'info',
    });
  } catch (err) {
    console.error('[netReductionAuditLog] logNetReductionCreate:', err.message);
  }
}

/**
 * Log a NetReductionEntry being updated.
 *
 * @param {object} req   - Express request
 * @param {object} entry - Updated NetReductionEntry document (post-save)
 * @param {string} [hint] - Optional human-readable change description
 */
async function logNetReductionUpdate(req, entry, hint = '') {
  try {
    await logEvent({
      req,
      module:        'net_reduction',
      action:        'update',
      entityType:    'NetReductionEntry',
      entityId:      _id(entry),
      clientId:      entry.clientId,
      changeSummary: hint || `Net reduction entry updated — project: ${entry.projectId ?? _id(entry)}`,
      metadata: {
        projectId:             entry.projectId ?? null,
        calculationMethodology: entry.calculationMethodology ?? null,
        inputType:             entry.reductionDataEntry?.inputType ?? entry.inputType ?? 'manual',
      },
      source:   _resolveSource(entry.reductionDataEntry?.inputType ?? entry.inputType),
      severity: 'info',
    });
  } catch (err) {
    console.error('[netReductionAuditLog] logNetReductionUpdate:', err.message);
  }
}

/**
 * Log a NetReductionEntry being soft-deleted.
 *
 * @param {object} req   - Express request
 * @param {object} entry - NetReductionEntry document being deleted
 */
async function logNetReductionDelete(req, entry) {
  try {
    await logEvent({
      req,
      module:        'net_reduction',
      action:        'delete',
      subAction:     'soft_delete',
      entityType:    'NetReductionEntry',
      entityId:      _id(entry),
      clientId:      entry.clientId,
      changeSummary: `Net reduction entry soft-deleted — project: ${entry.projectId ?? _id(entry)}`,
      metadata: {
        projectId: entry.projectId ?? null,
      },
      severity: 'warning',
    });
  } catch (err) {
    console.error('[netReductionAuditLog] logNetReductionDelete:', err.message);
  }
}

/**
 * Log a NetReductionEntry being permanently deleted.
 *
 * @param {object} req   - Express request
 * @param {object} entry - NetReductionEntry document being destroyed
 */
async function logNetReductionHardDelete(req, entry) {
  try {
    await logEvent({
      req,
      module:        'net_reduction',
      action:        'delete',
      subAction:     'hard_delete',
      entityType:    'NetReductionEntry',
      entityId:      _id(entry),
      clientId:      entry.clientId,
      changeSummary: `Net reduction entry permanently deleted — project: ${entry.projectId ?? _id(entry)}`,
      metadata: {
        projectId: entry.projectId ?? null,
      },
      severity: 'critical',
    });
  } catch (err) {
    console.error('[netReductionAuditLog] logNetReductionHardDelete:', err.message);
  }
}

/**
 * Log net reduction calculation being triggered.
 *
 * @param {object} req   - Express request
 * @param {object} entry - NetReductionEntry document after calculation
 */
async function logNetReductionCalculate(req, entry) {
  try {
    const netVal = entry.calculatedReductions?.breakdown?.netReduction?.incoming
      ?? entry.netReduction
      ?? null;

    await logEvent({
      req,
      module:        'net_reduction',
      action:        'calculate',
      entityType:    'NetReductionEntry',
      entityId:      _id(entry),
      clientId:      entry.clientId,
      changeSummary: `Net reduction calculated — project: ${entry.projectId}, netReduction: ${netVal}`,
      metadata: {
        projectId:             entry.projectId ?? null,
        calculationMethodology: entry.calculationMethodology ?? null,
        netReduction:          netVal,
        period:                entry.period ?? null,
      },
      severity: 'info',
    });
  } catch (err) {
    console.error('[netReductionAuditLog] logNetReductionCalculate:', err.message);
  }
}

/**
 * Log inputType being switched on a NetReductionEntry.
 *
 * @param {object} req     - Express request
 * @param {object} entry   - NetReductionEntry document after the switch
 * @param {string} oldType - Previous inputType
 * @param {string} newType - New inputType
 */
async function logNetReductionInputTypeSwitch(req, entry, oldType, newType) {
  try {
    await logEvent({
      req,
      module:        'net_reduction',
      action:        'update',
      subAction:     'input_type_switch',
      entityType:    'NetReductionEntry',
      entityId:      _id(entry),
      clientId:      entry.clientId,
      changeSummary: `Net reduction inputType changed '${oldType}' → '${newType}' — project: ${entry.projectId}`,
      metadata: {
        projectId:   entry.projectId ?? null,
        oldInputType: oldType,
        newInputType: newType,
      },
      severity: 'info',
    });
  } catch (err) {
    console.error('[netReductionAuditLog] logNetReductionInputTypeSwitch:', err.message);
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
  logNetReductionCreate,
  logNetReductionUpdate,
  logNetReductionDelete,
  logNetReductionHardDelete,
  logNetReductionCalculate,
  logNetReductionInputTypeSwitch,
};