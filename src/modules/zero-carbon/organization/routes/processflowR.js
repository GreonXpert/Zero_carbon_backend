// router/processflowR.js
const express = require('express');
const { auth, checkRole } = require('../../../../common/middleware/auth');

const {
  saveProcessFlowchart,
  addNodeToProcessFlowchart,
  getProcessFlowchart,
  getAllProcessFlowcharts,
  updateProcessFlowchartNode,
  deleteProcessFlowchart,
  deleteProcessNode,
  getProcessFlowchartSummary,
  restoreProcessFlowchart,
  assignOrUnassignEmployeeHeadToNode,
  assignScopeToProcessNode,
  removeAssignmentProcess,

  hardDeleteProcessScopeDetail,

  // Allocation endpoints
  getAllocations,
  updateAllocations,

  // ProcessEmissionDataEntry
  getProcessEmissionEntries,
  getProcessEmissionEntriesByNode,
  getProcessEmissionEntriesByScope,
  getProcessEmissionEntryById,
  getProcessEmissionStats,
  getProcessEmissionEntriesMinimal,
  getProcessEmissionNodeSummary,
} = require('../controllers/processflowController');

const {
  requireProcessFlowchartRead,
  requireProcessFlowchartWrite,
  requireProcessFlowchartAssign,
} = require('../utils/Permissions/accessPermissionFlowchartandProcessflowchart');

const { requireActiveModuleSubscription } = require('../../../../common/utils/Permissions/modulePermission');

// ── Module subscription gate ──────────────────────────────────────────────
// Shorthand for ZeroCarbon-specific route protection.
const zcGate = requireActiveModuleSubscription('zero_carbon');

const router = express.Router();

// All routes require authentication
router.use(auth);

// Roles allowed to assign/remove scope (employee head level)
const employeeRoles = ['employee_head', 'client_employee_head'];

// ─────────────────────────────────────────────────────────────────────────────
// Process Flowchart — Core WRITE operations
// ─────────────────────────────────────────────────────────────────────────────

// Create / Update process flowchart
router.post('/save', zcGate ,requireProcessFlowchartWrite(), saveProcessFlowchart);

// Add new node to existing flowchart
router.patch('/:flowchartId/add-node', zcGate , requireProcessFlowchartWrite(), addNodeToProcessFlowchart);

// Update specific node
router.patch('/:clientId/node/:nodeId', zcGate ,requireProcessFlowchartWrite(), updateProcessFlowchartNode);

// Delete process flowchart (soft delete)
router.delete('/:clientId', zcGate ,requireProcessFlowchartWrite(), deleteProcessFlowchart);

// Delete specific node
router.delete('/:clientId/node/:nodeId', zcGate ,requireProcessFlowchartWrite(), deleteProcessNode);

// Restore deleted flowchart
router.patch('/:clientId/restore', zcGate ,requireProcessFlowchartWrite(), restoreProcessFlowchart);

// Hard delete a scopeDetail (permanent)
router.delete(
  '/:clientId/node/:nodeId/scope/:scopeIdentifier',
  zcGate ,
  hardDeleteProcessScopeDetail
);

// ─────────────────────────────────────────────────────────────────────────────
// Process Flowchart — Core READ operations
// ─────────────────────────────────────────────────────────────────────────────

// Get all process flowcharts (hierarchy-based)
router.get('/all', zcGate ,requireProcessFlowchartRead('view'), getAllProcessFlowcharts);

// Get single process flowchart
router.get('/:clientId', zcGate ,requireProcessFlowchartRead('view'), getProcessFlowchart);

// Get process flowchart summary
router.get('/:clientId/summary', zcGate ,requireProcessFlowchartRead('view'), getProcessFlowchartSummary);

// ─────────────────────────────────────────────────────────────────────────────
// Process Flowchart — Assign Head
// ─────────────────────────────────────────────────────────────────────────────

// Assign / unassign employee head to a node (admin level)
router.post(
  '/:clientId/nodes/:nodeId/assign-head',
  zcGate ,      
  requireProcessFlowchartAssign(),
  assignOrUnassignEmployeeHeadToNode
);

// ─────────────────────────────────────────────────────────────────────────────
// Process Flowchart — Scope Assignment (Employee Head only)
// ─────────────────────────────────────────────────────────────────────────────

// Assign scope to a process node
router.post(
  
  '/:clientId/nodes/:nodeId/assign-scope',
  zcGate ,
  checkRole(...employeeRoles),
  assignScopeToProcessNode
);

// Remove scope assignment from a process node
router.delete(
  '/:clientId/nodes/:nodeId/remove-scope-assignment',
  zcGate ,
  checkRole(...employeeRoles),
  removeAssignmentProcess
);

// ─────────────────────────────────────────────────────────────────────────────
// Allocations
// ─────────────────────────────────────────────────────────────────────────────

// Get allocation summary for a client's process flowchart
router.get(
  '/:clientId/allocations',
    zcGate ,
  requireProcessFlowchartRead('entries'),
  getAllocations
);

// Update allocations for specific scopeIdentifiers
router.patch(
  '/:clientId/allocations',
  zcGate ,
  requireProcessFlowchartWrite(),
  updateAllocations
);

// ─────────────────────────────────────────────────────────────────────────────
// ProcessEmissionDataEntry endpoints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /:clientId/process-emission-entries
 * Returns ALL ProcessEmissionDataEntry records for a client.
 *
 * Supported query params (all optional):
 *   nodeId, scopeIdentifier, scopeType, inputType, nodeType,
 *   emissionCalculationStatus, sourceDataEntryId,
 *   startDate, endDate, sortBy, sortOrder, page, limit
 *
 * Example:
 *   GET /api/processflow/Greon017/process-emission-entries
 *   GET /api/processflow/Greon017/process-emission-entries?scopeType=Scope%201&startDate=2024-01-01&endDate=2024-12-31
 */
router.get(
  '/:clientId/process-emission-entries',
    zcGate ,
  requireProcessFlowchartRead('processEmissionEntries'),
  getProcessEmissionEntries
);

/**
 * GET /:clientId/process-emission-entries/stats
 * Aggregate statistics: count by scopeType, inputType, nodeType, status, date range.
 *
 * Supports same optional query params as above.
 *
 * Example:
 *   GET /api/processflow/Greon017/process-emission-entries/stats
 *   GET /api/processflow/Greon017/process-emission-entries/stats?nodeId=greon017-node-abc123
 */
router.get(
  '/:clientId/process-emission-entries/stats',
    zcGate ,
  requireProcessFlowchartRead('processEmissionEntries'),
  getProcessEmissionStats
);

/**
 * GET /:clientId/process-emission-entries/minimal
 * Lightweight payload — only fields needed for dashboards.
 * Omits raw dataValues; returns allocated totals only.
 *
 * Supports same optional query params.
 *
 * Example:
 *   GET /api/processflow/Greon017/process-emission-entries/minimal
 */
router.get(
  '/:clientId/process-emission-entries/minimal',
    zcGate ,
  requireProcessFlowchartRead('processEmissionEntries'),
  getProcessEmissionEntriesMinimal
);

/**
 * GET /:clientId/nodes/:nodeId/process-emission-entries
 * Returns ProcessEmissionDataEntry records filtered by client + node.
 *
 * Supported query params (all optional):
 *   scopeIdentifier, scopeType, inputType, nodeType,
 *   emissionCalculationStatus, sourceDataEntryId,
 *   startDate, endDate, sortBy, sortOrder, page, limit
 *
 * Example:
 *   GET /api/processflow/Greon017/nodes/greon017-node-cdec7a/process-emission-entries
 *   GET /api/processflow/Greon017/nodes/greon017-node-cdec7a/process-emission-entries?inputType=manual
 */
router.get(
  '/:clientId/nodes/:nodeId/process-emission-entries',
    zcGate ,
  requireProcessFlowchartRead('processEmissionEntries'),
  getProcessEmissionEntriesByNode
);

/**
 * GET /:clientId/nodes/:nodeId/process-emission-entries/summary
 * Aggregated per-scope summary for a node — useful for charts.
 * Returns latest cumulative allocated values per scopeIdentifier.
 *
 * Example:
 *   GET /api/processflow/Greon017/nodes/greon017-node-cdec7a/process-emission-entries/summary
 */
router.get(
  '/:clientId/nodes/:nodeId/process-emission-entries/summary',
    zcGate ,
  requireProcessFlowchartRead('processEmissionEntries'),
  getProcessEmissionNodeSummary
);

/**
 * GET /:clientId/nodes/:nodeId/scopes/:scopeIdentifier/process-emission-entries
 * Returns ProcessEmissionDataEntry records filtered by client + node + scope.
 *
 * Supported query params (all optional):
 *   scopeType, inputType, nodeType, emissionCalculationStatus,
 *   sourceDataEntryId, startDate, endDate, sortBy, sortOrder, page, limit
 *
 * Example:
 *   GET /api/processflow/Greon017/nodes/greon017-node-cdec7a/scopes/COK-SC-DG-FY25/process-emission-entries
 */
router.get(
  '/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/process-emission-entries',
  zcGate ,

  requireProcessFlowchartRead('processEmissionEntries'),
  getProcessEmissionEntriesByScope
);

/**
 * GET /process-emission-entries/:entryId
 * Returns a single ProcessEmissionDataEntry by its MongoDB _id.
 *
 * NOTE: This route has no /:clientId — clientId is resolved from req.user in the middleware.
 * Place this BEFORE any /:clientId wildcard routes to avoid param collision.
 *
 * Example:
 *   GET /api/processflow/process-emission-entries/665f1a2b3c4d5e6f7a8b9c0d
 */
router.get(
  '/process-emission-entries/:entryId',
  zcGate ,
  requireProcessFlowchartRead('processEmissionEntries'),
  getProcessEmissionEntryById
);

module.exports = router;