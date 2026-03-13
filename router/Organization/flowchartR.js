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
} = require('../../controllers/Organization/flowchartController');

const {
  requireOrgFlowchartRead,
  requireOrgFlowchartWrite,
  requireOrgFlowchartAssign,
} = require('../../utils/Permissions/accessPermissionFlowchartandProcessflowchart');

const { auth } = require('../../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(auth);

// ─────────────────────────────────────────────────────────────────────────────
// Summary routes — READ ('view' section)
// ─────────────────────────────────────────────────────────────────────────────

// Get consolidated summary across all clients
router.get('/summary', requireOrgFlowchartRead('view'), getConsolidatedSummary);

// Get summary for a specific client
router.get('/:clientId/summary', requireOrgFlowchartRead('view'), getFlowchartSummary);

// ─────────────────────────────────────────────────────────────────────────────
// Flowchart — READ operations
// ─────────────────────────────────────────────────────────────────────────────

// Get all flowcharts (hierarchy-based)
router.get('/all', requireOrgFlowchartRead('view'), getAllFlowcharts);

// Get single flowchart for a client
router.get('/:clientId', requireOrgFlowchartRead('view'), getFlowchart);

// ─────────────────────────────────────────────────────────────────────────────
// Flowchart — WRITE operations
// ─────────────────────────────────────────────────────────────────────────────

// Create / Update flowchart
router.post('/save', requireOrgFlowchartWrite(), saveFlowchart);

// Add new node to an existing flowchart
router.patch('/:flowchartId/add-node', requireOrgFlowchartWrite(), addNodeToFlowchart);

// Update a specific node
router.patch('/:clientId/node/:nodeId', requireOrgFlowchartWrite(), updateFlowchartNode);

// Soft delete entire flowchart
router.delete('/:clientId', requireOrgFlowchartWrite(), deleteFlowchart);

// Soft delete a specific node
router.delete('/:clientId/node/:nodeId', requireOrgFlowchartWrite(), deleteFlowchartNode);

// Restore a soft-deleted flowchart
router.patch('/:clientId/restore', requireOrgFlowchartWrite(), restoreFlowchart);

// Hard delete a scopeDetail (permanent) — FIX: was missing requireOrgFlowchartWrite()
router.delete(
  '/:clientId/node/:nodeId/scope/:scopeIdentifier',
  requireOrgFlowchartWrite(),
  hardDeleteScopeDetail
);

// ─────────────────────────────────────────────────────────────────────────────
// Flowchart — Assign Head
// ─────────────────────────────────────────────────────────────────────────────

// Assign / unassign employee head to a node
// FIX: removed redundant checkRole(...editRoles) — requireOrgFlowchartAssign() handles all role logic internally
router.post(
  '/:clientId/nodes/:nodeId/assign-head',
  requireOrgFlowchartAssign(),
  assignOrUnassignEmployeeHeadToNode
);

module.exports = router;