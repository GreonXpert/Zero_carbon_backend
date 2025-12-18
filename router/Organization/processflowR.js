// router/processflowR.js
const express = require('express');
const { auth, checkRole } = require('../../middleware/auth');

const {
  saveProcessFlowchart,
  getProcessFlowchart,
  getAllProcessFlowcharts,
  updateProcessFlowchartNode,
  deleteProcessFlowchart,
  deleteProcessNode,
  getProcessFlowchartSummary,
  restoreProcessFlowchart,
  assignOrUnassignEmployeeHeadToNode,
  assignScopeToProcessNode,
  removeAssignmentProcess,  
 
  hardDeleteProcessScopeDetail
} = require('../../controllers/Organization/processflowController');

const router = express.Router();

// All routes require authentication
router.use(auth);

const editRoles = ['consultant_admin', 'super_admin', 'client_admin'];
const employeeRoles = ['employee_head', 'client_employee_head'];

// Process flowchart operations
router.post('/save', saveProcessFlowchart);                             // Create/Update process flowchart
router.get('/all', getAllProcessFlowcharts);                           // Get all process flowcharts (hierarchy-based)
router.get('/:clientId', getProcessFlowchart);                         // Get single process flowchart
router.get('/:clientId/summary', getProcessFlowchartSummary);          // Get process flowchart summary
router.patch('/:clientId/node/:nodeId', updateProcessFlowchartNode);   // Update specific node
router.delete('/:clientId', deleteProcessFlowchart);                   // Delete process flowchart (soft)
router.delete('/:clientId/node/:nodeId', deleteProcessNode);           // Delete specific node
router.patch('/:clientId/restore', restoreProcessFlowchart);           // Restore deleted flowchart (super admin only)
router.post('/:clientId/nodes/:nodeId/assign-head', checkRole(...editRoles), assignOrUnassignEmployeeHeadToNode);
router.post(
  '/:clientId/nodes/:nodeId/assign-scope',
  checkRole(...employeeRoles),
  assignScopeToProcessNode
);

// Remove employees from a PROCESS node scope (Employee Head only)
router.delete(
  '/:clientId/nodes/:nodeId/remove-scope-assignment',
  checkRole(...employeeRoles),
  removeAssignmentProcess
);



// Hard delete a scopeDetail (process)
router.delete('/:clientId/node/:nodeId/scope/:scopeIdentifier', hardDeleteProcessScopeDetail);


module.exports = router;