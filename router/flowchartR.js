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
  restoreFlowchart
} = require('../controllers/flowchartController');
const { authenticate } = require('../utils/authenticate');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

router.get('/summary',      getFlowchartSummary); // Get flowchart summary for all clients
router.get('/:clientId/summary', getFlowchartSummary);       // Get flowchart summary

// Flowchart operations
router.post('/save', saveFlowchart);                          // Create/Update flowchart
router.get('/all', getAllFlowcharts);                        // Get all flowcharts (hierarchy-based)
router.get('/:clientId', getFlowchart);                      // Get single flowchart
router.delete('/:clientId', deleteFlowchart);                // Delete flowchart
router.delete('/:clientId/node/:nodeId', deleteFlowchartNode); // Delete specific node (soft delete)
router.patch('/:clientId/node/:nodeId', updateFlowchartNode); // Update specific node
router.patch('/:clientId/restore', restoreFlowchart);      // Restore deleted flowchart (super admin only)

module.exports = router;