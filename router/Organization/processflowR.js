// router/processflowR.js
const express = require('express');
const { auth, checkRole } = require('../../middleware/auth');

const {
  saveProcessFlowchart,
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
  // 🆕 NEW: Allocation endpoints
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
} = require('../../controllers/Organization/processflowController');

const router = express.Router();

// All routes require authentication
router.use(auth);

const editRoles = ['consultant_admin', 'super_admin', 'client_admin'];
const employeeRoles = ['employee_head', 'client_employee_head'];
const viewRoles = [
  'super_admin',
  'consultant_admin',
  'consultant',
  'client_admin',
  'client_employee_head',
  'employee',
  'auditor',
];


// Process flowchart operations
router.post('/save', saveProcessFlowchart);                             // Create/Update process flowchart
router.get('/all', getAllProcessFlowcharts);                           // Get all process flowcharts (hierarchy-based)
router.get('/:clientId', getProcessFlowchart);                         // Get single process flowchart
router.get('/:clientId/summary', getProcessFlowchartSummary);          // Get process flowchart summary
router.patch('/:clientId/node/:nodeId', updateProcessFlowchartNode);   // Update specific node
router.delete('/:clientId', deleteProcessFlowchart);                   // Delete process flowchart (soft)
router.delete('/:clientId/node/:nodeId', deleteProcessNode);           // Delete specific node
router.patch('/:clientId/restore', restoreProcessFlowchart);           // Restore deleted flowchart (super admin only)
router.post('/:clientId/nodes/:nodeId/assign-head', checkRole(...editRoles), assignOrUnassignEmployeeHeadToNode);
router.post(
  '/:clientId/nodes/:nodeId/assign-scope',
  checkRole(...employeeRoles),
  assignScopeToProcessNode
);

// Remove employees from a PROCESS node scope (Employee Head only)
router.delete(
  '/:clientId/nodes/:nodeId/remove-scope-assignment',
  checkRole(...employeeRoles),
  removeAssignmentProcess
);



// Hard delete a scopeDetail (process)
router.delete('/:clientId/node/:nodeId/scope/:scopeIdentifier', hardDeleteProcessScopeDetail);

// Get allocation summary for a client's process flowchart
router.get('/:clientId/allocations', getAllocations);

// Update allocations for specific scopeIdentifiers
router.patch('/:clientId/allocations', checkRole(...editRoles), updateAllocations);


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
  checkRole(...viewRoles),
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
  checkRole(...viewRoles),
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
  checkRole(...viewRoles),
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
  checkRole(...viewRoles),
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
  checkRole(...viewRoles),
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
  checkRole(...viewRoles),
  getProcessEmissionEntriesByScope
);

/**
 * GET /process-emission-entries/:entryId
 * Returns a single ProcessEmissionDataEntry by its MongoDB _id.
 *
 * Example:
 *   GET /api/processflow/process-emission-entries/665f1a2b3c4d5e6f7a8b9c0d
 */
router.get(
  '/process-emission-entries/:entryId',
  checkRole(...viewRoles),
  getProcessEmissionEntryById
);

module.exports = router;