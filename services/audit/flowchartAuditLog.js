'use strict';
// services/audit/flowchartAuditLog.js
//
// PURPOSE:
//   Thin wrappers around logEvent() for the 'organization_flowchart' module.
//
// USAGE (inside flowchartController, after each successful DB write):
//
//   const {
//     logFlowchartCreate,
//     logFlowchartUpdate,
//     logFlowchartDelete,
//     logFlowchartNodeAssign,
//     logFlowchartScopeAssign,
//     logFlowchartScopeUnassign,
//   } = require('../../services/audit/flowchartAuditLog');
//
//   await logFlowchartCreate(req, flowchart);

const { logEvent } = require('./auditLogService');

const _id = (v) => (v?._id ?? v?.id ?? v ?? '').toString();

// ─── exported helpers ─────────────────────────────────────────────────────────

/**
 * Log a new Flowchart (org chart) being created.
 *
 * @param {object} req       - Express request
 * @param {object} flowchart - Saved Flowchart document
 */
async function logFlowchartCreate(req, flowchart) {
  try {
    await logEvent({
      req,
      module:        'organization_flowchart',
      action:        'create',
      entityType:    'Flowchart',
      entityId:      _id(flowchart),
      clientId:      flowchart.clientId,
      changeSummary: `Organization flowchart created for client: ${flowchart.clientId}`,
      metadata: {
        nodeCount:       (flowchart.nodes ?? []).length,
        isActive:        flowchart.isActive ?? true,
        assessmentLevel: flowchart.assessmentLevel ?? null,
      },
      severity: 'info',
    });
  } catch (err) {
    console.error('[flowchartAuditLog] logFlowchartCreate:', err.message);
  }
}

/**
 * Log a Flowchart being updated (node added/removed, edge changed, etc.).
 *
 * @param {object} req       - Express request
 * @param {object} flowchart - Updated Flowchart document (post-save)
 * @param {string} [hint]    - Optional human-readable change description
 */
async function logFlowchartUpdate(req, flowchart, hint = '') {
  try {
    await logEvent({
      req,
      module:        'organization_flowchart',
      action:        'update',
      entityType:    'Flowchart',
      entityId:      _id(flowchart),
      clientId:      flowchart.clientId,
      changeSummary: hint || `Organization flowchart updated — client: ${flowchart.clientId}, nodes: ${(flowchart.nodes ?? []).length}`,
      metadata: {
        nodeCount: (flowchart.nodes ?? []).length,
        isActive:  flowchart.isActive ?? true,
      },
      severity: 'info',
    });
  } catch (err) {
    console.error('[flowchartAuditLog] logFlowchartUpdate:', err.message);
  }
}

/**
 * Log a Flowchart being deleted.
 *
 * @param {object} req       - Express request
 * @param {object} flowchart - Flowchart document being deleted
 * @param {string} [type]    - 'soft' | 'hard' (default: 'soft')
 */
async function logFlowchartDelete(req, flowchart, type = 'soft') {
  try {
    await logEvent({
      req,
      module:        'organization_flowchart',
      action:        'delete',
      subAction:     type === 'hard' ? 'hard_delete' : 'soft_delete',
      entityType:    'Flowchart',
      entityId:      _id(flowchart),
      clientId:      flowchart.clientId,
      changeSummary: `Organization flowchart ${type}-deleted — client: ${flowchart.clientId}`,
      metadata: {
        nodeCount: (flowchart.nodes ?? []).length,
      },
      severity: type === 'hard' ? 'critical' : 'warning',
    });
  } catch (err) {
    console.error('[flowchartAuditLog] logFlowchartDelete:', err.message);
  }
}

/**
 * Log an employee_head being assigned to a flowchart node.
 *
 * @param {object} req             - Express request
 * @param {object} flowchart       - Flowchart document (post-save)
 * @param {string} nodeId          - The node that received an assignment
 * @param {string} employeeHeadId  - UserId of the assigned head
 */
async function logFlowchartNodeAssign(req, flowchart, nodeId, employeeHeadId) {
  try {
    await logEvent({
      req,
      module:        'organization_flowchart',
      action:        'assign',
      subAction:     'employee_head_to_node',
      entityType:    'Flowchart',
      entityId:      _id(flowchart),
      clientId:      flowchart.clientId,
      changeSummary: `Employee head assigned to node — nodeId: ${nodeId}, headId: ${employeeHeadId}`,
      metadata: {
        nodeId,
        employeeHeadId,
      },
      severity: 'info',
    });
  } catch (err) {
    console.error('[flowchartAuditLog] logFlowchartNodeAssign:', err.message);
  }
}

/**
 * Log employees being assigned to a scope within a flowchart node.
 *
 * @param {object} req             - Express request
 * @param {object} flowchart       - Flowchart document (post-save)
 * @param {string} nodeId          - Node containing the scope
 * @param {string} scopeIdentifier - Scope receiving the assignment
 * @param {string[]} employeeIds   - Array of employee userIds assigned
 */
async function logFlowchartScopeAssign(req, flowchart, nodeId, scopeIdentifier, employeeIds) {
  try {
    await logEvent({
      req,
      module:        'organization_flowchart',
      action:        'assign',
      subAction:     'employees_to_scope',
      entityType:    'Flowchart',
      entityId:      _id(flowchart),
      clientId:      flowchart.clientId,
      changeSummary: `${employeeIds.length} employee(s) assigned to scope — node: ${nodeId}, scope: ${scopeIdentifier}`,
      metadata: {
        nodeId,
        scopeIdentifier,
        employeeCount: employeeIds.length,
        employeeIds:   employeeIds.slice(0, 10), // cap to avoid oversized logs
      },
      severity: 'info',
    });
  } catch (err) {
    console.error('[flowchartAuditLog] logFlowchartScopeAssign:', err.message);
  }
}

/**
 * Log employees being unassigned from a scope within a flowchart node.
 *
 * @param {object} req             - Express request
 * @param {object} flowchart       - Flowchart document (post-save)
 * @param {string} nodeId          - Node containing the scope
 * @param {string} scopeIdentifier - Scope losing the assignment
 * @param {string[]} employeeIds   - Array of employee userIds removed
 */
async function logFlowchartScopeUnassign(req, flowchart, nodeId, scopeIdentifier, employeeIds) {
  try {
    await logEvent({
      req,
      module:        'organization_flowchart',
      action:        'unassign',
      subAction:     'employees_from_scope',
      entityType:    'Flowchart',
      entityId:      _id(flowchart),
      clientId:      flowchart.clientId,
      changeSummary: `${employeeIds.length} employee(s) unassigned from scope — node: ${nodeId}, scope: ${scopeIdentifier}`,
      metadata: {
        nodeId,
        scopeIdentifier,
        employeeCount: employeeIds.length,
        employeeIds:   employeeIds.slice(0, 10),
      },
      severity: 'info',
    });
  } catch (err) {
    console.error('[flowchartAuditLog] logFlowchartScopeUnassign:', err.message);
  }
}

// ─── exports ──────────────────────────────────────────────────────────────────

module.exports = {
  logFlowchartCreate,
  logFlowchartUpdate,
  logFlowchartDelete,
  logFlowchartNodeAssign,
  logFlowchartScopeAssign,
  logFlowchartScopeUnassign,
};