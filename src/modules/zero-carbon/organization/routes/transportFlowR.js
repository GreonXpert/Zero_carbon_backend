// router/transportFlowR.js
const express = require('express');
const { auth } = require('../../../../common/middleware/auth');

const {
  getTransportTemplate,
  saveTransportFlowchart,
  getTransportFlowchart,
  deleteTransportFlowchart,
  hardDeleteTransportFlowchart,
  restoreTransportFlowchart
} = require('../controllers/transportFlowController');
const { requireActiveModuleSubscription } = require('../../../../common/utils/Permissions/modulePermission');

// ── Module subscription gate ──────────────────────────────────────────────
// Shorthand for ZeroCarbon-specific route protection.
const zcGate = requireActiveModuleSubscription('zero_carbon');

const router = express.Router();

// All routes require authentication
router.use(auth);

// Build template nodes from organization / process charts
router.get('/:clientId/template', zcGate, getTransportTemplate);

// Create / update transport chart
router.post('/save', zcGate, saveTransportFlowchart);

// Get saved transport chart for a client
router.get('/:clientId', zcGate, getTransportFlowchart);

// Soft-delete transport chart
router.delete('/:clientId', zcGate, deleteTransportFlowchart);

// Restore latest soft-deleted chart
router.patch('/:clientId/restore', zcGate, restoreTransportFlowchart);

// HARD DELETE transport chart (only super_admin)
router.delete('/:clientId/hard-delete', zcGate, hardDeleteTransportFlowchart);

module.exports = router;
