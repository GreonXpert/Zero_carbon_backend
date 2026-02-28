'use strict';
// services/audit/transportFlowchartAuditLog.js
//
// PURPOSE:
//   Thin wrappers around logEvent() for the 'transport_flowchart' module.
//
// USAGE (inside transportFlowController, after each successful DB write):
//
//   const {
//     logTransportFlowCreate,
//     logTransportFlowUpdate,
//     logTransportFlowDelete,
//     logTransportFlowNodeAssign,
//     logTransportFlowScopeAssign,
//     logTransportFlowScopeUnassign,
//   } = require('../../services/audit/transportFlowchartAuditLog');
//
//   await logTransportFlowCreate(req, transportFlow);

const { logEvent } = require('./auditLogService');

const _id = (v) => (v?._id ?? v?.id ?? v ?? '').toString();

// ─── exported helpers ─────────────────────────────────────────────────────────

/**
 * Log a new TransportFlowchart being created.
 *
 * @param {object} req           - Express request
 * @param {object} transportFlow - Saved TransportFlowchart document
 */
async function logTransportFlowCreate(req, transportFlow) {
  try {
    await logEvent({
      req,
      module:        'transport_flowchart',
      action:        'create',
      entityType:    'TransportFlowchart',
      entityId:      _id(transportFlow),
      clientId:      transportFlow.clientId,
      changeSummary: `Transport flowchart created for client: ${transportFlow.clientId}`,
      metadata: {
        nodeCount: (transportFlow.nodes ?? []).length,
        isActive:  transportFlow.isActive ?? true,
      },
      severity: 'info',
    });
  } catch (err) {
    console.error('[transportFlowchartAuditLog] logTransportFlowCreate:', err.message);
  }
}

/**
 * Log a TransportFlowchart being updated.
 *
 * @param {object} req           - Express request
 * @param {object} transportFlow - Updated TransportFlowchart document (post-save)
 * @param {string} [hint]        - Optional human-readable change description
 */
async function logTransportFlowUpdate(req, transportFlow, hint = '') {
  try {
    await logEvent({
      req,
      module:        'transport_flowchart',
      action:        'update',
      entityType:    'TransportFlowchart',
      entityId:      _id(transportFlow),
      clientId:      transportFlow.clientId,
      changeSummary: hint || `Transport flowchart updated — client: ${transportFlow.clientId}, nodes: ${(transportFlow.nodes ?? []).length}`,
      metadata: {
        nodeCount: (transportFlow.nodes ?? []).length,
      },
      severity: 'info',
    });
  } catch (err) {
    console.error('[transportFlowchartAuditLog] logTransportFlowUpdate:', err.message);
  }
}

/**
 * Log a TransportFlowchart being deleted.
 *
 * @param {object} req           - Express request
 * @param {object} transportFlow - TransportFlowchart document being deleted
 * @param {string} [type]        - 'soft' | 'hard' (default: 'soft')
 */
async function logTransportFlowDelete(req, transportFlow, type = 'soft') {
  try {
    await logEvent({
      req,
      module:        'transport_flowchart',
      action:        'delete',
      subAction:     type === 'hard' ? 'hard_delete' : 'soft_delete',
      entityType:    'TransportFlowchart',
      entityId:      _id(transportFlow),
      clientId:      transportFlow.clientId,
      changeSummary: `Transport flowchart ${type}-deleted — client: ${transportFlow.clientId}`,
      metadata: {
        nodeCount: (transportFlow.nodes ?? []).length,
      },
      severity: type === 'hard' ? 'critical' : 'warning',
    });
  } catch (err) {
    console.error('[transportFlowchartAuditLog] logTransportFlowDelete:', err.message);
  }
}

/**
 * Log an employee_head being assigned to a transport flowchart node.
 *
 * @param {object} req             - Express request
 * @param {object} transportFlow   - TransportFlowchart document (post-save)
 * @param {string} nodeId          - The node that received an assignment
 * @param {string} employeeHeadId  - UserId of the assigned head
 */
async function logTransportFlowNodeAssign(req, transportFlow, nodeId, employeeHeadId) {
  try {
    await logEvent({
      req,
      module:        'transport_flowchart',
      action:        'assign',
      subAction:     'employee_head_to_node',
      entityType:    'TransportFlowchart',
      entityId:      _id(transportFlow),
      clientId:      transportFlow.clientId,
      changeSummary: `Employee head assigned to transport node — nodeId: ${nodeId}, headId: ${employeeHeadId}`,
      metadata: {
        nodeId,
        employeeHeadId,
      },
      severity: 'info',
    });
  } catch (err) {
    console.error('[transportFlowchartAuditLog] logTransportFlowNodeAssign:', err.message);
  }
}

/**
 * Log employees being assigned to a scope within a transport flowchart node.
 *
 * @param {object} req             - Express request
 * @param {object} transportFlow   - TransportFlowchart document (post-save)
 * @param {string} nodeId          - Node containing the scope
 * @param {string} scopeIdentifier - Scope receiving the assignment
 * @param {string[]} employeeIds   - Array of employee userIds assigned
 */
async function logTransportFlowScopeAssign(req, transportFlow, nodeId, scopeIdentifier, employeeIds) {
  try {
    await logEvent({
      req,
      module:        'transport_flowchart',
      action:        'assign',
      subAction:     'employees_to_scope',
      entityType:    'TransportFlowchart',
      entityId:      _id(transportFlow),
      clientId:      transportFlow.clientId,
      changeSummary: `${employeeIds.length} employee(s) assigned to transport scope — node: ${nodeId}, scope: ${scopeIdentifier}`,
      metadata: {
        nodeId,
        scopeIdentifier,
        employeeCount: employeeIds.length,
        employeeIds:   employeeIds.slice(0, 10),
      },
      severity: 'info',
    });
  } catch (err) {
    console.error('[transportFlowchartAuditLog] logTransportFlowScopeAssign:', err.message);
  }
}

/**
 * Log employees being unassigned from a scope within a transport flowchart node.
 *
 * @param {object} req             - Express request
 * @param {object} transportFlow   - TransportFlowchart document (post-save)
 * @param {string} nodeId          - Node containing the scope
 * @param {string} scopeIdentifier - Scope losing the assignment
 * @param {string[]} employeeIds   - Array of employee userIds removed
 */
async function logTransportFlowScopeUnassign(req, transportFlow, nodeId, scopeIdentifier, employeeIds) {
  try {
    await logEvent({
      req,
      module:        'transport_flowchart',
      action:        'unassign',
      subAction:     'employees_from_scope',
      entityType:    'TransportFlowchart',
      entityId:      _id(transportFlow),
      clientId:      transportFlow.clientId,
      changeSummary: `${employeeIds.length} employee(s) unassigned from transport scope — node: ${nodeId}, scope: ${scopeIdentifier}`,
      metadata: {
        nodeId,
        scopeIdentifier,
        employeeCount: employeeIds.length,
        employeeIds:   employeeIds.slice(0, 10),
      },
      severity: 'info',
    });
  } catch (err) {
    console.error('[transportFlowchartAuditLog] logTransportFlowScopeUnassign:', err.message);
  }
}

// ─── exports ──────────────────────────────────────────────────────────────────

module.exports = {
  logTransportFlowCreate,
  logTransportFlowUpdate,
  logTransportFlowDelete,
  logTransportFlowNodeAssign,
  logTransportFlowScopeAssign,
  logTransportFlowScopeUnassign,
};