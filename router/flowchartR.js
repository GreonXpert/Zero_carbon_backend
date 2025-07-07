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
 
} = require('../controllers/flowchartController');
// CHANGED: Use the same auth middleware as other routes
const { auth, checkRole } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(auth); // CHANGED: Use proper auth middleware

// Define roles that can access emission factor data
const viewRoles = ['consultant', 'consultant_admin', 'super_admin', 'client_admin', 'employee_head', 'employee'];
const editRoles = ['consultant_admin', 'super_admin'];

// Summary routes
router.get('/summary', getConsolidatedSummary); 
router.get('/:clientId/summary', getFlowchartSummary); 

// Flowchart operations
router.post('/save', saveFlowchart); 
router.get('/all', getAllFlowcharts); 
router.get('/:clientId', getFlowchart); 
router.delete('/:clientId', deleteFlowchart); 
router.delete('/:clientId/node/:nodeId', deleteFlowchartNode); 
router.patch('/:clientId/node/:nodeId', updateFlowchartNode); 
router.patch('/:clientId/restore', restoreFlowchart); 




module.exports = router;