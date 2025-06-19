// router/processflowR.js
const express = require('express');
const { authenticate } = require('../utils/authenticate');
const {
  saveProcessFlowchart,
  getProcessFlowchart,
  getAllProcessFlowcharts,
  updateProcessFlowchartNode,
  deleteProcessFlowchart,
  deleteProcessNode,
  getProcessFlowchartSummary,
  restoreProcessFlowchart
} = require('../controllers/processflowController');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Process flowchart operations
router.post('/save', saveProcessFlowchart);                             // Create/Update process flowchart
router.get('/all', getAllProcessFlowcharts);                           // Get all process flowcharts (hierarchy-based)
router.get('/:clientId', getProcessFlowchart);                         // Get single process flowchart
router.get('/:clientId/summary', getProcessFlowchartSummary);          // Get process flowchart summary
router.patch('/:clientId/node/:nodeId', updateProcessFlowchartNode);   // Update specific node
router.delete('/:clientId', deleteProcessFlowchart);                   // Delete process flowchart (soft)
router.delete('/:clientId/node/:nodeId', deleteProcessNode);           // Delete specific node
router.patch('/:clientId/restore', restoreProcessFlowchart);           // Restore deleted flowchart (super admin only)

module.exports = router;