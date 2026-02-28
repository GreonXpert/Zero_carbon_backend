'use strict';
// services/audit/dataEntryAuditLog.js
//
// PURPOSE:
//   Thin wrappers around logEvent() for the 'data_entry' module.
//   Drop these calls into your DataEntry controller right after each
//   successful DB write (create / update / delete / calculate / import).
//
// USAGE (inside your controller, after a successful save):
//
//   const {
//     logDataEntryCreate,
//     logDataEntryUpdate,
//     logDataEntryDelete,
//     logDataEntryCalculate,
//     logDataEntryImport,
//     logDataEntryInputTypeSwitch,
//   } = require('../../services/audit/dataEntryAuditLog');
//
//   // after entry.save()
//   await logDataEntryCreate(req, entry);
//
// NOTE:
//   All helpers are fire-and-forget safe — they catch & log their own errors
//   so they never break the main controller flow.

const { logEvent } = require('./auditLogService');

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Safely grab a string id from any Mongoose doc or plain object */
const _id = (v) => (v?._id ?? v?.id ?? v ?? '').toString();

// ─── exported helpers ─────────────────────────────────────────────────────────

/**
 * Log a new DataEntry being created (manual / CSV).
 *
 * @param {object} req   - Express request
 * @param {object} entry - Saved DataEntry document
 */
async function logDataEntryCreate(req, entry) {
  try {
    await logEvent({
      req,
      module:        'data_entry',
      action:        'create',
      entityType:    'DataEntry',
      entityId:      _id(entry),
      clientId:      entry.clientId,
      changeSummary: `Data entry created — node: ${entry.nodeId}, scope: ${entry.scopeIdentifier}, inputType: ${entry.inputType ?? 'manual'}`,
      metadata: {
        nodeId:          entry.nodeId,
        scopeIdentifier: entry.scopeIdentifier,
        inputType:       entry.inputType ?? 'manual',
        period:          entry.period ?? null,
        dataSource:      entry.dataSource ?? null,
      },
      source:   _resolveSource(entry.inputType),
      severity: 'info',
    });
  } catch (err) {
    console.error('[dataEntryAuditLog] logDataEntryCreate:', err.message);
  }
}

/**
 * Log an existing DataEntry being updated.
 *
 * @param {object} req     - Express request
 * @param {object} entry   - Updated DataEntry document (post-save)
 * @param {string} [hint]  - Optional human-readable summary of what changed
 */
async function logDataEntryUpdate(req, entry, hint = '') {
  try {
    await logEvent({
      req,
      module:        'data_entry',
      action:        'update',
      entityType:    'DataEntry',
      entityId:      _id(entry),
      clientId:      entry.clientId,
      changeSummary: hint || `Data entry updated — node: ${entry.nodeId}, scope: ${entry.scopeIdentifier}`,
      metadata: {
        nodeId:          entry.nodeId,
        scopeIdentifier: entry.scopeIdentifier,
        inputType:       entry.inputType ?? 'manual',
        period:          entry.period ?? null,
      },
      source:   _resolveSource(entry.inputType),
      severity: 'info',
    });
  } catch (err) {
    console.error('[dataEntryAuditLog] logDataEntryUpdate:', err.message);
  }
}

/**
 * Log a DataEntry being soft-deleted or hard-deleted.
 *
 * @param {object} req      - Express request
 * @param {object} entry    - The DataEntry document that was deleted
 * @param {string} [type]   - 'soft' | 'hard' (default: 'soft')
 */
async function logDataEntryDelete(req, entry, type = 'soft') {
  try {
    await logEvent({
      req,
      module:        'data_entry',
      action:        'delete',
      subAction:     type === 'hard' ? 'hard_delete' : 'soft_delete',
      entityType:    'DataEntry',
      entityId:      _id(entry),
      clientId:      entry.clientId,
      changeSummary: `Data entry ${type}-deleted — node: ${entry.nodeId}, scope: ${entry.scopeIdentifier}`,
      metadata: {
        nodeId:          entry.nodeId,
        scopeIdentifier: entry.scopeIdentifier,
        period:          entry.period ?? null,
      },
      severity: type === 'hard' ? 'warning' : 'info',
    });
  } catch (err) {
    console.error('[dataEntryAuditLog] logDataEntryDelete:', err.message);
  }
}

/**
 * Log emission calculation being triggered for a DataEntry.
 *
 * @param {object} req   - Express request
 * @param {object} entry - DataEntry document after calculation
 */
async function logDataEntryCalculate(req, entry) {
  try {
    const co2e = entry.emissionsSummary?.totalCO2e ?? entry.calculatedEmissions?.CO2e ?? null;
    await logEvent({
      req,
      module:        'data_entry',
      action:        'calculate',
      entityType:    'DataEntry',
      entityId:      _id(entry),
      clientId:      entry.clientId,
      changeSummary: `Emission calculated for entry — scope: ${entry.scopeIdentifier}, totalCO2e: ${co2e}`,
      metadata: {
        nodeId:          entry.nodeId,
        scopeIdentifier: entry.scopeIdentifier,
        totalCO2e:       co2e,
        period:          entry.period ?? null,
      },
      severity: 'info',
    });
  } catch (err) {
    console.error('[dataEntryAuditLog] logDataEntryCalculate:', err.message);
  }
}

/**
 * Log a bulk CSV / file import of DataEntries.
 *
 * @param {object} req          - Express request
 * @param {string} clientId     - Target client
 * @param {number} importedCount - Number of rows imported
 * @param {object} [extra]      - Any extra metadata (filename, errors, etc.)
 */
async function logDataEntryImport(req, clientId, importedCount, extra = {}) {
  try {
    await logEvent({
      req,
      module:        'data_entry',
      action:        'import',
      entityType:    'DataEntry',
      entityId:      null,
      clientId,
      changeSummary: `Bulk import: ${importedCount} data entr${importedCount === 1 ? 'y' : 'ies'} imported`,
      metadata: {
        importedCount,
        ...extra,
      },
      source:   'manual',
      severity: 'info',
    });
  } catch (err) {
    console.error('[dataEntryAuditLog] logDataEntryImport:', err.message);
  }
}

/**
 * Log inputType being switched (manual → API / IOT / etc.).
 *
 * @param {object} req      - Express request
 * @param {object} entry    - DataEntry document after the switch
 * @param {string} oldType  - Previous inputType
 * @param {string} newType  - New inputType
 */
async function logDataEntryInputTypeSwitch(req, entry, oldType, newType) {
  try {
    await logEvent({
      req,
      module:        'data_entry',
      action:        'update',
      subAction:     'input_type_switch',
      entityType:    'DataEntry',
      entityId:      _id(entry),
      clientId:      entry.clientId,
      changeSummary: `Input type changed from '${oldType}' → '${newType}' — scope: ${entry.scopeIdentifier}`,
      metadata: {
        nodeId:          entry.nodeId,
        scopeIdentifier: entry.scopeIdentifier,
        oldInputType:    oldType,
        newInputType:    newType,
      },
      severity: 'info',
    });
  } catch (err) {
    console.error('[dataEntryAuditLog] logDataEntryInputTypeSwitch:', err.message);
  }
}

// ─── private ──────────────────────────────────────────────────────────────────

function _resolveSource(inputType) {
  const t = (inputType ?? 'manual').toString().toUpperCase();
  if (t === 'API')    return 'api';
  if (t === 'IOT')    return 'iot';
  if (t === 'CSV')    return 'manual'; // CSV treated as manual upload
  return 'manual';
}

// ─── exports ──────────────────────────────────────────────────────────────────

module.exports = {
  logDataEntryCreate,
  logDataEntryUpdate,
  logDataEntryDelete,
  logDataEntryCalculate,
  logDataEntryImport,
  logDataEntryInputTypeSwitch,
};