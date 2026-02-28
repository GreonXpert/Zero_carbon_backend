'use strict';
// services/audit/processFlowchartAuditLog.js
//
// PURPOSE:
//   Thin wrappers around logEvent() for the 'process_flowchart' module.
//
// USAGE (inside processflowController, after each successful DB write):
//
//   const {
//     logProcessFlowCreate,
//     logProcessFlowUpdate,
//     logProcessFlowDelete,
//     logProcessFlowNodeAssign,
//     logProcessFlowScopeAssign,
//     logProcessFlowScopeUnassign,
//     logProcessFlowAllocationUpdate,
//   } = require('../../services/audit/processFlowchartAuditLog');
//
//   await logProcessFlowCreate(req, processFlow);

const { logEvent } = require('./auditLogService');

const _id = (v) => (v?._id ?? v?.id ?? v ?? '').toString();

// ─── exported helpers ─────────────────────────────────────────────────────────

/**
 * Log a new ProcessFlowchart being created.
 *
 * @param {object} req         - Express request
 * @param {object} processFlow - Saved ProcessFlowchart document
 */
async function logProcessFlowCreate(req, processFlow) {
  try {
    await logEvent({
      req,
      module:        'process_flowchart',
      action:        'create',
      entityType:    'ProcessFlowchart',
      entityId:      _id(processFlow),
      clientId:      processFlow.clientId,
      changeSummary: `Process flowchart created for client: ${processFlow.clientId}`,
      metadata: {
        nodeCount: (processFlow.nodes ?? []).length,
        isDeleted: processFlow.isDeleted ?? false,
      },
      severity: 'info',
    });
  } catch (err) {
    console.error('[processFlowchartAuditLog] logProcessFlowCreate:', err.message);
  }
}

/**
 * Log a ProcessFlowchart being updated (nodes, edges, allocation percentages, etc.).
 *
 * @param {object} req         - Express request
 * @param {object} processFlow - Updated ProcessFlowchart document (post-save)
 * @param {string} [hint]      - Optional human-readable change description
 */
async function logProcessFlowUpdate(req, processFlow, hint = '') {
  try {
    await logEvent({
      req,
      module:        'process_flowchart',
      action:        'update',
      entityType:    'ProcessFlowchart',
      entityId:      _id(processFlow),
      clientId:      processFlow.clientId,
      changeSummary: hint || `Process flowchart updated — client: ${processFlow.clientId}, nodes: ${(processFlow.nodes ?? []).length}`,
      metadata: {
        nodeCount: (processFlow.nodes ?? []).length,
      },
      severity: 'info',
    });
  } catch (err) {
    console.error('[processFlowchartAuditLog] logProcessFlowUpdate:', err.message);
  }
}

/**
 * Log a ProcessFlowchart being deleted.
 *
 * @param {object} req         - Express request
 * @param {object} processFlow - ProcessFlowchart document being deleted
 * @param {string} [type]      - 'soft' | 'hard' (default: 'soft')
 */
async function logProcessFlowDelete(req, processFlow, type = 'soft') {
  try {
    await logEvent({
      req,
      module:        'process_flowchart',
      action:        'delete',
      subAction:     type === 'hard' ? 'hard_delete' : 'soft_delete',
      entityType:    'ProcessFlowchart',
      entityId:      _id(processFlow),
      clientId:      processFlow.clientId,
      changeSummary: `Process flowchart ${type}-deleted — client: ${processFlow.clientId}`,
      metadata: {
        nodeCount: (processFlow.nodes ?? []).length,
      },
      severity: type === 'hard' ? 'critical' : 'warning',
    });
  } catch (err) {
    console.error('[processFlowchartAuditLog] logProcessFlowDelete:', err.message);
  }
}

/**
 * Log an employee_head being assigned to a process flowchart node.
 *
 * @param {object} req             - Express request
 * @param {object} processFlow     - ProcessFlowchart document (post-save)
 * @param {string} nodeId          - The node that received an assignment
 * @param {string} employeeHeadId  - UserId of the assigned head
 */
async function logProcessFlowNodeAssign(req, processFlow, nodeId, employeeHeadId) {
  try {
    await logEvent({
      req,
      module:        'process_flowchart',
      action:        'assign',
      subAction:     'employee_head_to_node',
      entityType:    'ProcessFlowchart',
      entityId:      _id(processFlow),
      clientId:      processFlow.clientId,
      changeSummary: `Employee head assigned to process node — nodeId: ${nodeId}, headId: ${employeeHeadId}`,
      metadata: {
        nodeId,
        employeeHeadId,
      },
      severity: 'info',
    });
  } catch (err) {
    console.error('[processFlowchartAuditLog] logProcessFlowNodeAssign:', err.message);
  }
}

/**
 * Log employees being assigned to a scope within a process flowchart node.
 *
 * @param {object} req             - Express request
 * @param {object} processFlow     - ProcessFlowchart document (post-save)
 * @param {string} nodeId          - Node containing the scope
 * @param {string} scopeIdentifier - Scope receiving the assignment
 * @param {string[]} employeeIds   - Array of employee userIds assigned
 */
async function logProcessFlowScopeAssign(req, processFlow, nodeId, scopeIdentifier, employeeIds) {
  try {
    await logEvent({
      req,
      module:        'process_flowchart',
      action:        'assign',
      subAction:     'employees_to_scope',
      entityType:    'ProcessFlowchart',
      entityId:      _id(processFlow),
      clientId:      processFlow.clientId,
      changeSummary: `${employeeIds.length} employee(s) assigned to process scope — node: ${nodeId}, scope: ${scopeIdentifier}`,
      metadata: {
        nodeId,
        scopeIdentifier,
        employeeCount: employeeIds.length,
        employeeIds:   employeeIds.slice(0, 10),
      },
      severity: 'info',
    });
  } catch (err) {
    console.error('[processFlowchartAuditLog] logProcessFlowScopeAssign:', err.message);
  }
}

/**
 * Log employees being unassigned from a scope within a process flowchart node.
 *
 * @param {object} req             - Express request
 * @param {object} processFlow     - ProcessFlowchart document (post-save)
 * @param {string} nodeId          - Node containing the scope
 * @param {string} scopeIdentifier - Scope losing the assignment
 * @param {string[]} employeeIds   - Array of employee userIds removed
 */
async function logProcessFlowScopeUnassign(req, processFlow, nodeId, scopeIdentifier, employeeIds) {
  try {
    await logEvent({
      req,
      module:        'process_flowchart',
      action:        'unassign',
      subAction:     'employees_from_scope',
      entityType:    'ProcessFlowchart',
      entityId:      _id(processFlow),
      clientId:      processFlow.clientId,
      changeSummary: `${employeeIds.length} employee(s) unassigned from process scope — node: ${nodeId}, scope: ${scopeIdentifier}`,
      metadata: {
        nodeId,
        scopeIdentifier,
        employeeCount: employeeIds.length,
        employeeIds:   employeeIds.slice(0, 10),
      },
      severity: 'info',
    });
  } catch (err) {
    console.error('[processFlowchartAuditLog] logProcessFlowScopeUnassign:', err.message);
  }
}

/**
 * Log allocation percentage being updated on a process flowchart node.
 * This is the key process-specific action — tracked at 'warning' severity
 * because allocation changes directly affect emission distribution.
 *
 * @param {object} req             - Express request
 * @param {object} processFlow     - ProcessFlowchart document (post-save)
 * @param {string} nodeId          - Node whose allocation changed
 * @param {number} oldAllocation   - Previous allocationPct
 * @param {number} newAllocation   - New allocationPct
 */
async function logProcessFlowAllocationUpdate(req, processFlow, nodeId, oldAllocation, newAllocation) {
  try {
    await logEvent({
      req,
      module:        'process_flowchart',
      action:        'update',
      subAction:     'allocation_pct_change',
      entityType:    'ProcessFlowchart',
      entityId:      _id(processFlow),
      clientId:      processFlow.clientId,
      changeSummary: `Allocation % updated — node: ${nodeId}, ${oldAllocation}% → ${newAllocation}%`,
      metadata: {
        nodeId,
        oldAllocationPct: oldAllocation,
        newAllocationPct: newAllocation,
      },
      severity: 'warning', // allocation changes affect downstream emission calcs
    });
  } catch (err) {
    console.error('[processFlowchartAuditLog] logProcessFlowAllocationUpdate:', err.message);
  }
}

// ─── exports ──────────────────────────────────────────────────────────────────

module.exports = {
  logProcessFlowCreate,
  logProcessFlowUpdate,
  logProcessFlowDelete,
  logProcessFlowNodeAssign,
  logProcessFlowScopeAssign,
  logProcessFlowScopeUnassign,
  logProcessFlowAllocationUpdate,
};