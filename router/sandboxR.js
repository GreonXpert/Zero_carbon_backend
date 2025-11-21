// router/sandboxR.js

const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');

const {
  createClientSandbox,
  getSandboxDetails,
  updateDataFlow,
  updateEmissionMonitoring,
  syncFlowchartsToSandbox,
  getAvailableTemplates,
  applyTemplate,
  submitForApproval,
  processApproval,
  activateSandbox,
  exportSandboxData
} = require('../controllers/sandboxController');

// All routes require authentication
router.use(auth);

// =====================================================
// SANDBOX MANAGEMENT
// =====================================================

// Create new sandbox for active client
// POST /api/sandbox/:clientId/create
router.post('/:clientId/create', createClientSandbox);

// Get sandbox details
// GET /api/sandbox/:clientId
router.get('/:clientId', getSandboxDetails);

// =====================================================
// DATA FLOW VISUALIZATION
// =====================================================

// Update data flow step
// PATCH /api/sandbox/:clientId/data-flow/:stepId
router.patch('/:clientId/data-flow/:stepId', updateDataFlow);

// =====================================================
// EMISSION MONITORING
// =====================================================

// Update emission monitoring
// PATCH /api/sandbox/:clientId/emissions
router.patch('/:clientId/emissions', updateEmissionMonitoring);

// =====================================================
// FLOWCHART SYNCHRONIZATION
// =====================================================

// Sync flowcharts to sandbox
// POST /api/sandbox/:clientId/sync-flowcharts
router.post('/:clientId/sync-flowcharts', syncFlowchartsToSandbox);

// =====================================================
// TEMPLATE MANAGEMENT
// =====================================================

// Get available templates
// GET /api/sandbox/:clientId/templates
router.get('/:clientId/templates', getAvailableTemplates);

// Apply template to sandbox
// POST /api/sandbox/:clientId/apply-template
router.post('/:clientId/apply-template', applyTemplate);

// =====================================================
// APPROVAL WORKFLOW
// =====================================================

// Submit sandbox for approval
// POST /api/sandbox/:clientId/submit-approval
router.post('/:clientId/submit-approval', submitForApproval);

// Approve/reject sandbox
// POST /api/sandbox/:clientId/process-approval
router.post('/:clientId/process-approval', processApproval);

// Activate approved sandbox
// POST /api/sandbox/:clientId/activate
router.post('/:clientId/activate', activateSandbox);

// =====================================================
// DATA EXPORT
// =====================================================

// Export sandbox data
// GET /api/sandbox/:clientId/export?format=json|pdf|excel
router.get('/:clientId/export', exportSandboxData);

module.exports = router;