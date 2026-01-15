const express = require("express");
const router = express.Router();
const { auth } = require("../../middleware/auth");
const {
  createLead,
  updateLead,
  deleteLead,
  getLeads,
  moveToDataSubmission,
  submitClientData,
  updateClientData,     
  deleteClientData,
  getClientSubmissionData,     
  moveToProposal,
  updateProposalStatus,
  getClientProposalData,
  getClients,
  getClientById,
  assignConsultant,
  manageSubscription,
  getPendingSubscriptionApprovals,
  getClientsExpiringSoon,
  getDashboardMetrics,
  updateFlowchartStatus,
  updateProcessFlowchartStatus,
  syncDataInputPoints,
  updateManualInputStatus,
  updateAPIInputStatus,
  updateIoTInputStatus,
  getConsultantHistory,
  changeConsultant,
  removeConsultant,
  updateAssessmentLevelOnly,
  hardResetClientSystem,
  purgeClientCompletely,
  // 🆕 SUPPORT MANAGEMENT FUNCTIONS
  assignSupportManager,
  changeSupportManager,
  getSupportManagerForClient
} = require("../../controllers/CMS/clientController");

// Apply auth middleware to all routes
router.use(auth);

// ===================================================================
// LEAD MANAGEMENT (Stage 1)
// ===================================================================

router.post("/lead", createLead);
router.put("/:clientId/lead", updateLead);
router.delete("/:clientId/lead", deleteLead);
router.get("/leads", getLeads);
router.patch("/:clientId/move-to-data-submission", moveToDataSubmission);

// ===================================================================
// DATA SUBMISSION (Stage 2)
// ===================================================================

router.post("/:clientId/submit-data", submitClientData);
router.put("/:clientId/update-data", updateClientData);
router.delete("/:clientId/delete-data", deleteClientData);
router.get("/:clientId/submission-data", getClientSubmissionData);
router.patch("/:clientId/move-to-proposal", moveToProposal);

// ===================================================================
// PROPOSAL MANAGEMENT (Stage 3)
// ===================================================================

router.patch("/:clientId/proposal-status", updateProposalStatus);
router.get("/:clientId/proposal-data", getClientProposalData);

// ===================================================================
// CLIENT MANAGEMENT (Stage 4)
// ===================================================================

router.patch("/:clientId/assign-consultant", assignConsultant);
router.patch("/:clientId/change-consultant", changeConsultant);
router.patch("/:clientId/remove-consultant", removeConsultant);
router.get("/:clientId/consultant-history", getConsultantHistory);

// ===================================================================
// 🆕 SUPPORT MANAGEMENT ROUTES
// ===================================================================

/**
 * Assign Support Manager to Client
 * PATCH /api/clients/:clientId/assign-support-manager
 */
router.patch("/:clientId/assign-support-manager", assignSupportManager);

/**
 * Change Support Manager for Client
 * PATCH /api/clients/:clientId/change-support-manager
 */
router.patch("/:clientId/change-support-manager", changeSupportManager);

/**
 * Get Support Manager for Client
 * GET /api/clients/:clientId/support-manager
 */
router.get("/:clientId/support-manager", getSupportManagerForClient);

// ===================================================================
// SUBSCRIPTION MANAGEMENT
// ===================================================================

router.patch("/:clientId/subscription", manageSubscription);
router.get("/subscription/pending-approvals", getPendingSubscriptionApprovals);
router.get("/subscription/expiring-soon", getClientsExpiringSoon);

// ===================================================================
// GENERAL CLIENT ROUTES
// ===================================================================

router.get("/", getClients);
router.get("/:clientId", getClientById);

// ===================================================================
// CONSULTANT WORKFLOW (Stage 5)
// ===================================================================

router.patch("/:clientId/workflow/flowchart-status", updateFlowchartStatus);
router.patch("/:clientId/workflow/process-flowchart-status", updateProcessFlowchartStatus);
router.post("/:clientId/workflow/sync-data-points", syncDataInputPoints);
router.patch("/:clientId/workflow/manual-input/:pointId", updateManualInputStatus);
router.patch("/:clientId/workflow/api-input/:pointId", updateAPIInputStatus);
router.patch("/:clientId/workflow/iot-input/:pointId", updateIoTInputStatus);

// ===================================================================
// DASHBOARD & ANALYTICS
// ===================================================================

router.get("/dashboard/metrics", getDashboardMetrics);

// ===================================================================
// SYSTEM ADMINISTRATION
// ===================================================================

router.patch("/:clientId/assessment-level", updateAssessmentLevelOnly);
router.post("/system/purge-client/:clientId", purgeClientCompletely);
router.post('/system/hard-reset', hardResetClientSystem);

module.exports = router;