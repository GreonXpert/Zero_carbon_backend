const express = require('express');
const {
  saveFlowchart,
  getFlowchart,
  getAllFlowcharts,
  deleteFlowchart,
  deleteFlowchartNode,
  getFlowchartSummary,
  getConsolidatedSummary,
  updateFlowchartNode,
  restoreFlowchart,
  assignOrUnassignEmployeeHeadToNode,
  addNodeToFlowchart,
  hardDeleteScopeDetail,
} = require('../controllers/flowchartController');

const {
  requireOrgFlowchartRead,
  requireOrgFlowchartWrite,
  requireOrgFlowchartAssign,
} = require('../utils/Permissions/accessPermissionFlowchartandProcessflowchart');

const { requireActiveModuleSubscription } = require('../../../../common/utils/Permissions/modulePermission');

// ── Module subscription gate ──────────────────────────────────────────────
// Shorthand for ZeroCarbon-specific route protection.
const zcGate = requireActiveModuleSubscription('zero_carbon');

const { auth } = require('../../../../common/middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(auth);

// ─────────────────────────────────────────────────────────────────────────────
// Summary routes — READ ('view' section)
// ─────────────────────────────────────────────────────────────────────────────

// Get consolidated summary across all clients
router.get('/summary', zcGate ,requireOrgFlowchartRead('view'), getConsolidatedSummary);

// Get summary for a specific client
router.get('/:clientId/summary', zcGate ,requireOrgFlowchartRead('view'), getFlowchartSummary);

// ─────────────────────────────────────────────────────────────────────────────
// Flowchart — READ operations
// ─────────────────────────────────────────────────────────────────────────────

// Get all flowcharts (hierarchy-based)
router.get('/all', zcGate ,requireOrgFlowchartRead('view'), getAllFlowcharts);

// Get single flowchart for a client
router.get('/:clientId', zcGate ,requireOrgFlowchartRead('view'), getFlowchart);

// ─────────────────────────────────────────────────────────────────────────────
// Flowchart — WRITE operations
// ─────────────────────────────────────────────────────────────────────────────

// Create / Update flowchart
router.post('/save', zcGate ,requireOrgFlowchartWrite(), saveFlowchart);

// Add new node to an existing flowchart
router.patch('/:flowchartId/add-node', zcGate , requireOrgFlowchartWrite(), addNodeToFlowchart);

// Update a specific node
router.patch('/:clientId/node/:nodeId', zcGate ,requireOrgFlowchartWrite(), updateFlowchartNode);

// Soft delete entire flowchart
router.delete('/:clientId', zcGate ,requireOrgFlowchartWrite(), deleteFlowchart);

// Soft delete a specific node
router.delete('/:clientId/node/:nodeId', zcGate ,requireOrgFlowchartWrite(), deleteFlowchartNode);

// Restore a soft-deleted flowchart
router.patch('/:clientId/restore', zcGate ,requireOrgFlowchartWrite(), restoreFlowchart);

// Hard delete a scopeDetail (permanent) — FIX: was missing requireOrgFlowchartWrite()
router.delete(
  '/:clientId/node/:nodeId/scope/:scopeIdentifier',
  zcGate ,
  hardDeleteScopeDetail
);

// ─────────────────────────────────────────────────────────────────────────────
// Flowchart — Assign Head
// ─────────────────────────────────────────────────────────────────────────────

// Assign / unassign employee head to a node
// FIX: removed redundant checkRole(...editRoles) — requireOrgFlowchartAssign() handles all role logic internally
router.post(
  '/:clientId/nodes/:nodeId/assign-head',
  zcGate ,
  requireOrgFlowchartAssign(),
  assignOrUnassignEmployeeHeadToNode
);

module.exports = router;