'use strict';
/**
 * boundaryR.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Express router for ESGLink Core boundary endpoints.
 * All routes require authentication + ESGLink module subscription.
 */

const express = require('express');
const router  = express.Router();
const { auth } = require('../../../../../common/middleware/auth');
const { requireActiveModuleSubscription } = require('../../../../../common/utils/Permissions/modulePermission');

const {
  importBoundaryFromZeroCarbon,
  createBoundaryManually,
  getBoundary,
  updateBoundaryNode,
  addNodeToBoundary,
  appendNodeToBoundary,
  addEdgeToBoundary,
  removeEdgeFromBoundary,
  removeNodeFromBoundary,
  deleteBoundary,
  checkBoundaryImportAvailability,
} = require('../controllers/boundaryController');

// All routes require authentication
router.use(auth);

// ESGLink module subscription gate
const eslGate = requireActiveModuleSubscription('esg_link');

// ─────────────────────────────────────────────────────────────────────────────
// CHECK / READ
// ─────────────────────────────────────────────────────────────────────────────

// Check whether a ZeroCarbon org flowchart is available to import
// NOTE: must be registered BEFORE /:clientId/boundary to avoid route conflict
router.get('/:clientId/boundary/import-availability', eslGate, checkBoundaryImportAvailability);

// Get the current active boundary
router.get('/:clientId/boundary', eslGate, getBoundary);

// ─────────────────────────────────────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────────────────────────────────────

// Import boundary automatically from ZeroCarbon organisation flowchart
router.post('/:clientId/boundary/import-from-zero-carbon', eslGate, importBoundaryFromZeroCarbon);

// Create boundary manually (nodes + edges provided by consultant)
router.post('/:clientId/boundary', eslGate, createBoundaryManually);

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE
// ─────────────────────────────────────────────────────────────────────────────

// Update a specific node
router.patch('/:clientId/boundary/nodes/:nodeId', eslGate, updateBoundaryNode);

// Add new node(s) — POST (original)
router.post('/:clientId/boundary/nodes', eslGate, addNodeToBoundary);

// Append new node(s) — PATCH (safe append; never touches existing nodes or their metricsDetails)
// Register before /:clientId/boundary/nodes/:nodeId to avoid Express param confusion
router.patch('/:clientId/boundary/nodes', eslGate, appendNodeToBoundary);

// Add new edge(s)
router.post('/:clientId/boundary/edges', eslGate, addEdgeToBoundary);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────────────────────

// Remove a specific node (also removes its connected edges)
router.delete('/:clientId/boundary/nodes/:nodeId', eslGate, removeNodeFromBoundary);

// Remove a specific edge
router.delete('/:clientId/boundary/edges/:edgeId', eslGate, removeEdgeFromBoundary);

// Soft-delete entire boundary
router.delete('/:clientId/boundary', eslGate, deleteBoundary);


module.exports = router;
