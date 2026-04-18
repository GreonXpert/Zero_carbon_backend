'use strict';
/**
 * mappingR.js
 * ─────────────────────────────────────────────────────────────────────────────
 * ESGLink Core Step 3 — Metric Mapping routes.
 * Mounted at: /api/esglink/core
 *
 * Route ordering: literal paths registered BEFORE parameterised paths
 * to prevent Express treating 'my-assigned-metrics' as :nodeId.
 */

const express = require('express');
const router  = express.Router();

const { auth } = require('../../../../../common/middleware/auth');
const { requireActiveModuleSubscription } = require('../../../../../common/utils/Permissions/modulePermission');

const {
  addMetricToNode,
  updateMapping,
  removeMapping,
  reactivateMapping,
  updateWorkflowDefaults,
  getMyAssignedMetrics,
  getMappingById,
} = require('../controllers/mappingController');

// All routes require authentication and active esg_link subscription
router.use(auth);
const eslGate = requireActiveModuleSubscription('esg_link');

// ── Literal routes first (prevent Express param collision) ────────────────────

// GET /:clientId/my-assigned-metrics
// Returns only mappings where the calling user is contributor/reviewer/approver
router.get('/:clientId/my-assigned-metrics', eslGate, getMyAssignedMetrics);

// ── Parameterised routes ──────────────────────────────────────────────────────

// POST /:clientId/boundary/nodes/:nodeId/metrics
// Add a metric from the library to a boundary node
router.post('/:clientId/boundary/nodes/:nodeId/metrics', eslGate, addMetricToNode);

// PATCH /:clientId/boundary/nodes/:nodeId/metrics/:mappingId
// Update an existing mapped metric's configuration
router.patch('/:clientId/boundary/nodes/:nodeId/metrics/:mappingId', eslGate, updateMapping);

// DELETE /:clientId/boundary/nodes/:nodeId/metrics/:mappingId
// Soft-deactivate a mapped metric (sets mappingStatus: 'inactive')
router.delete('/:clientId/boundary/nodes/:nodeId/metrics/:mappingId', eslGate, removeMapping);

// PATCH /:clientId/boundary/nodes/:nodeId/metrics/:mappingId/reactivate
// Reactivate an inactive mapped metric (sets mappingStatus: 'active')
router.patch('/:clientId/boundary/nodes/:nodeId/metrics/:mappingId/reactivate', eslGate, reactivateMapping);

// PATCH /:clientId/boundary/nodes/:nodeId/workflow-defaults
// Update node-level reviewer/approver defaults (consultant_admin+ only)
router.patch('/:clientId/boundary/nodes/:nodeId/workflow-defaults', eslGate, updateWorkflowDefaults);

// GET /:clientId/nodes/:nodeId/metrics/:mappingId
// Get a single mapped metric — full view for managers, filtered for assignees
router.get('/:clientId/nodes/:nodeId/metrics/:mappingId', eslGate, getMappingById);

module.exports = router;
