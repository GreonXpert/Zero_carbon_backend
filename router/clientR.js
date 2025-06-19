const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
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
  createProposal,
  editProposal,
  deleteProposal,
  updateProposalStatus,
  getClientProposalData,
  getClients,
  getClientById,
  assignConsultant,
  manageSubscription,
  getDashboardMetrics,
  updateFlowchartStatus,
  updateProcessFlowchartStatus,
  syncDataInputPoints,
  updateManualInputStatus,
  updateAPIInputStatus,
  updateIoTInputStatus,
   
} = require("../controllers/clientController");

// Apply auth middleware to all routes
router.use(auth);

// Lead Management (Stage 1)
router.post("/lead", createLead); // Create new lead

// → New: Update Lead (only while stage === "lead")
router.put("/:clientId/lead", auth, updateLead);

// → New: Delete Lead (only within 3 days of creation, only stage === "lead")
router.delete("/:clientId/lead", auth, deleteLead);

// get leads by createedBy
router.get("/leads", getLeads); // Get all leads (filtered by permissions)

router.patch("/:clientId/move-to-data-submission", moveToDataSubmission); // Move to stage 2


// Data Submission (Stage 2)
router.post("/:clientId/submit-data", submitClientData); // Submit client data
router.put("/:clientId/update-data", updateClientData);            // ← Update submitted data (consultant_admin only)
router.delete("/:clientId/delete-data", deleteClientData);
router.get("/:clientId/submission-data", getClientSubmissionData); // Get submitted data for a client  
router.patch("/:clientId/move-to-proposal", moveToProposal); // Move to stage 3

// Proposal Management (Stage 3)
router.post("/:clientId/proposal", createProposal); // Create proposal
router.put("/:clientId/proposal", editProposal); // Edit proposal (consultant_admin only)
router.delete("/:clientId/proposal", deleteProposal); // Delete proposal (consultant_admin only)
router.patch("/:clientId/proposal-status", updateProposalStatus); // Accept/Reject proposal
router.get("/:clientId/proposal-data", getClientProposalData); // Get proposal data for a client

// Client Management (Stage 4)
router.patch("/:clientId/assign-consultant", assignConsultant); // Assign consultant
router.patch("/:clientId/subscription", manageSubscription); // Manage subscription

// General Routes
router.get("/", getClients); // Get all clients (filtered by permissions)
router.get("/:clientId", getClientById); // Get single client details

// Stage 5 Consultant work

// Flowchart Status Management
router.patch("/:clientId/workflow/flowchart-status", updateFlowchartStatus); // Update flowchart status (consultant/consultant_admin only)
router.patch("/:clientId/workflow/process-flowchart-status", updateProcessFlowchartStatus); // Update process flowchart status

// Data Input Points Management
router.post("/:clientId/workflow/sync-data-points", syncDataInputPoints); // Sync data input points from flowchart

//  Individual Input Point Status Updates
router.patch("/:clientId/workflow/manual-input/:pointId", updateManualInputStatus); // Update manual input status with training info
router.patch("/:clientId/workflow/api-input/:pointId", updateAPIInputStatus); // Update API input status with connection info
router.patch("/:clientId/workflow/iot-input/:pointId", updateIoTInputStatus); // Update IoT input status with device info

// Dashboard endpoints
router.get("/dashboard/metrics", getDashboardMetrics); // Get dashboard metrics

module.exports = router;