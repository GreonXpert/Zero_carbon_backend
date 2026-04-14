// routes/reductionR.js
// ============================================================
// COMPLETE UPDATED VERSION with Client Workflow Status Routes
// ============================================================
const express = require('express');
const router = express.Router();
const { auth } = require('../../../../common/middleware/auth');
const {
  createReduction,
  getReduction,
  updateReduction,
  recalculateReduction,
  deleteReduction,
  deleteFromDB,
  restoreSoftDeletedReduction,
  getAllReductions,
  assignEmployeeHeadToProject,
  assignEmployeesToProject,
  updateReductionStatus,
  syncReductionProjects,
  getReductionProjectsSummary,
  updateClientReductionWorkflowStatus,  // 🆕 NEW
  getClientReductionWorkflowStatus,      // 🆕 NEW

} = require('../controllers/reductionController');
const { uploadReductionMedia } =
  require('../utils/reductionUploadS3');
const { requireActiveModuleSubscription } = require('../../../../common/utils/Permissions/modulePermission');

// ── Module subscription gate ──────────────────────────────────────────────
// Shorthand for ZeroCarbon-specific route protection.
const zcGate = requireActiveModuleSubscription('zero_carbon');


router.use(auth);

// ==========================================
// 🔹 SPECIAL ROUTES FIRST (no params or specific paths)
// These MUST come BEFORE parametric routes like /:clientId
// ==========================================

// Get all reductions

router.get('/getall', zcGate, getAllReductions);

// 🆕 CLIENT-LEVEL WORKFLOW STATUS ROUTES (before parametric routes)
// Update overall workflow status for a client (different from individual project status)
router.patch('/workflow-status/:clientId', zcGate, updateClientReductionWorkflowStatus);

// Get overall workflow status for a client
router.get('/workflow-status/:clientId', zcGate, getClientReductionWorkflowStatus);

// Sync projects for a client (also auto-updates workflow status)
router.post('/sync/:clientId', zcGate, syncReductionProjects);

// Get projects summary for a client
router.get('/summary/:clientId', zcGate, getReductionProjectsSummary);

// ==========================================
// 🔹 PARAMETRIC ROUTES (with params like :clientId, :projectId)
// These come AFTER special routes to avoid conflicts
// ==========================================

// Create reduction for a client
router.post(
  '/:clientId',
  zcGate,
  uploadReductionMedia,
  createReduction
);

// Get single reduction
router.get('/:clientId/:projectId', zcGate, getReduction);

// Update reduction
router.patch(
  '/:clientId/:projectId',
  zcGate,
  uploadReductionMedia,
  updateReduction
);

// 🔹 PROJECT-LEVEL STATUS UPDATE (individual project)
// Keep this AFTER the main patch route
router.patch('/:clientId/:projectId/status', zcGate, updateReductionStatus);

// Force recalculate
router.post('/:clientId/:projectId/recalculate', zcGate, recalculateReduction);

// Restore soft-deleted reduction
router.patch('/:clientId/:projectId/restore', zcGate, restoreSoftDeletedReduction);

// Team assignment for a Reduction project
router.patch('/:clientId/:projectId/assign-employee-head', zcGate, assignEmployeeHeadToProject);
router.patch('/:clientId/:projectId/assign-employees', zcGate, assignEmployeesToProject);

// Delete (soft)
router.delete('/:clientId/:projectId', zcGate, deleteReduction);

// Hard delete from DB (super admin only)
router.delete('/:clientId/:projectId/hard', zcGate, deleteFromDB);

module.exports = router;


// ============================================================
// 📝 ROUTE SUMMARY - 3 LEVELS OF STATUS MANAGEMENT
// ============================================================
//
// 1️⃣ CLIENT-LEVEL WORKFLOW STATUS (Overall reduction program status)
//    PATCH /workflow-status/:clientId
//    GET   /workflow-status/:clientId
//    → Updates Client.workflowTracking.reduction.status
//    → Represents overall reduction program status
//    → Example: Client's entire reduction initiative is "on_going"
//
// 2️⃣ PROJECT-LEVEL STATUS (Individual reduction project status)
//    PATCH /:clientId/:projectId/status
//    → Updates Reduction.status
//    → Represents individual project status
//    → Example: "Solar Panel Project" is "completed"
//
// 3️⃣ AUTO-SYNC (Automatic workflow status determination)
//    POST /sync/:clientId
//    → Counts all projects by status
//    → Auto-determines workflow status based on project statuses
//    → Updates both counts AND workflow status
//
// ============================================================
// 🔄 HOW THEY WORK TOGETHER
// ============================================================
//
// Scenario 1: Manual Workflow Status Update
// User explicitly sets workflow status to "on_going"
// → PATCH /workflow-status/Greon001
// → Body: { "status": "on_going" }
// → Directly updates Client.workflowTracking.reduction.status
//
// Scenario 2: Project Status Update with Auto-Sync
// User updates individual project status
// → PATCH /Greon001/Greon001-RED-Greon001-0001/status
// → Body: { "status": "completed" }
// → Updates project status
// → Auto-triggers sync
// → Sync recalculates workflow status based on ALL projects
//
// Scenario 3: Manual Sync with Status Calculation
// User clicks "Sync Projects" button
// → POST /sync/Greon001
// → Counts all projects: 2 on_going, 1 completed, 1 pending
// → Auto-determines workflow status: "on_going" (because some are active)
// → Updates both counts and workflow status
//
// ============================================================
// 💡 BEST PRACTICE
// ============================================================
//
// Let auto-sync handle workflow status in most cases!
// 
// ✅ Recommended: Let sync auto-determine status
// - Sync runs automatically after project status changes
// - Status accurately reflects project states
// - No manual intervention needed
//
// ⚠️ Manual override only when needed:
// - Special business requirements
// - Override automatic determination
// - External factors not reflected in projects
//
// ============================================================