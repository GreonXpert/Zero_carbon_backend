// router/transportFlowR.js
const express = require('express');
const { auth } = require('../../middleware/auth');

const {
  getTransportTemplate,
  saveTransportFlowchart,
  getTransportFlowchart,
  deleteTransportFlowchart,
  hardDeleteTransportFlowchart,
  restoreTransportFlowchart
} = require('../../controllers/Organization/transportFlowController');

const router = express.Router();

// All routes require authentication
router.use(auth);

// Build template nodes from organization / process charts
router.get('/:clientId/template', getTransportTemplate);

// Create / update transport chart
router.post('/save', saveTransportFlowchart);

// Get saved transport chart for a client
router.get('/:clientId', getTransportFlowchart);

// Soft-delete transport chart
router.delete('/:clientId', deleteTransportFlowchart);

// Restore latest soft-deleted chart
router.patch('/:clientId/restore', restoreTransportFlowchart);

// HARD DELETE transport chart (only super_admin)
router.delete('/:clientId/hard-delete', hardDeleteTransportFlowchart);

module.exports = router;
