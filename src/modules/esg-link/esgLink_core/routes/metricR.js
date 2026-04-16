'use strict';
/**
 * metricR.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Express router for ESGLink Core Metric Library endpoints.
 * All routes require authentication + active ESGLink module subscription.
 *
 * IMPORTANT — route ordering note:
 *   The literal path `/metrics` is registered BEFORE the dynamic `/:clientId`
 *   prefix, so Express resolves `/metrics` as a literal segment, not as a
 *   clientId parameter. This prevents collisions when this router is mounted
 *   alongside boundaryR at /api/esglink/core.
 *
 * Global metric routes (no clientId):
 *   POST   /metrics                           → createGlobalMetric
 *   GET    /metrics                           → listGlobalMetrics
 *   GET    /metrics/:metricId                 → getMetricById
 *   PUT    /metrics/:metricId                 → updateMetric
 *   PATCH  /metrics/:metricId/publish         → publishMetric
 *   PATCH  /metrics/:metricId/retire          → retireMetric
 *   DELETE /metrics/:metricId                 → deleteMetric
 *
 * Client-scoped metric routes:
 *   POST   /:clientId/metrics                 → createClientMetric
 *   GET    /:clientId/metrics/available       → listAvailableMetrics  (before /:clientId/metrics to avoid conflict)
 *   GET    /:clientId/metrics                 → listClientMetrics
 */

const express = require('express');
const router  = express.Router();

const { auth } = require('../../../../common/middleware/auth');
const { requireActiveModuleSubscription } = require('../../../../common/utils/Permissions/modulePermission');

const {
  createGlobalMetric,
  listGlobalMetrics,
  getMetricById,
  updateMetric,
  publishMetric,
  retireMetric,
  deleteMetric,
  createClientMetric,
  listClientMetrics,
  listAvailableMetrics,
} = require('../controllers/metricController');

// All metric routes require authentication
router.use(auth);

// ESGLink module subscription gate
const eslGate = requireActiveModuleSubscription('esg_link');

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL METRIC ROUTES  (literal /metrics prefix — no clientId in path)
// These MUST appear before /:clientId/metrics to avoid Express treating
// the word "metrics" as a :clientId param.
// ─────────────────────────────────────────────────────────────────────────────

// Create a new global metric (draft state, super_admin / consultant_admin only)
router.post('/metrics', eslGate, createGlobalMetric);

// List global metrics
// Admins see all statuses; consultant / client_admin see published only
router.get('/metrics', eslGate, listGlobalMetrics);

// Get single metric by ID (global or client-scoped — visibility enforced in controller)
router.get('/metrics/:metricId', eslGate, getMetricById);

// Update metric definition fields (bumps version for definition-level changes)
router.put('/metrics/:metricId', eslGate, updateMetric);

// Publish a draft global metric
router.patch('/metrics/:metricId/publish', eslGate, publishMetric);

// Retire a published metric (global or client-scoped)
router.patch('/metrics/:metricId/retire', eslGate, retireMetric);

// Soft-delete a metric (super_admin / consultant_admin only)
router.delete('/metrics/:metricId', eslGate, deleteMetric);

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT-SCOPED METRIC ROUTES  (/:clientId/metrics prefix)
// ─────────────────────────────────────────────────────────────────────────────

// Create a client-scoped custom metric (immediately published on creation)
router.post('/:clientId/metrics', eslGate, createClientMetric);

// List metrics available for this client to use in boundary mapping (Step 3)
// NOTE: registered before /:clientId/metrics to avoid Express matching
// "available" as an empty :metricId param on the GET /metrics/:metricId route
router.get('/:clientId/metrics/available', eslGate, listAvailableMetrics);

// List all client-scoped metrics for this client
router.get('/:clientId/metrics', eslGate, listClientMetrics);

module.exports = router;
