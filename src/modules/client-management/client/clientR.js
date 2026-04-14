const express = require("express");
const router = express.Router();
const { auth, checkRole } = require("../../../common/middleware/auth");
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
  reviewSubscription,
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
  updateClientModuleAccess,
  manageEsgLinkSubscription,
  reviewEsgLinkSubscription,
  getEsgLinkPendingApprovals,
  hardResetClientSystem,
  purgeClientCompletely,
  // 🆕 SUPPORT MANAGEMENT FUNCTIONS
  assignSupportManager,
  changeSupportManager,
  getSupportManagerForClient,
  // 🆕 QUOTA STAGE FUNCTIONS
  markQuotaCreated,
  moveToActive,
} = require("./clientController");

// // 🆕 QUOTA MANAGEMENT
// const {
//   getClientQuota,
//   updateClientQuota,
//   resetClientQuota,
// } = require("../quota/quotaController");


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


// // ===================================================================
// // 🆕 QUOTA MANAGEMENT ROUTES
// // ===================================================================

// /**
//  * Get current quota status (limits + live usage) for the assigned consultant.
//  *
//  * GET /api/clients/:clientId/quota
//  *
//  * Access:
//  *   - super_admin      : any client
//  *   - consultant_admin : clients whose assigned consultant is under their team
//  *   - consultant       : their own assigned clients
//  *
//  * Response:
//  * {
//  *   "success": true,
//  *   "data": {
//  *     "clientId": "Greon017",
//  *     "consultantId": "...",
//  *     "limits": { "flowchartNodes": 50, "reductionProjects": null, ... },
//  *     "usage":  { "flowchartNodes": 12, "reductionProjects": 3, ... },
//  *     "status": {
//  *       "flowchartNodes": { "limit": 50, "used": 12, "remaining": 38, "unlimited": false, "canAdd": true },
//  *       "reductionProjects": { "limit": "unlimited", "used": 3, "remaining": "unlimited", "unlimited": true, "canAdd": true },
//  *       ...
//  *     }
//  *   }
//  * }
//  */
// router.get("/:clientId/quota", getClientQuota);

// /**
//  * Update quota limits for the assigned consultant of a client.
//  *
//  * PATCH /api/clients/:clientId/quota
//  *
//  * Access:
//  *   - super_admin      : any client
//  *   - consultant_admin : consultants under their team only
//  *
//  * Body:
//  * {
//  *   "limits": {
//  *     "flowchartNodes": 50,           // set specific limit
//  *     "flowchartScopeDetails": 200,
//  *     "processNodes": 30,
//  *     "processScopeDetails": 150,
//  *     "reductionProjects": 10,
//  *     "transportFlows": 5,
//  *     "sbtiTargets": 2,
//  *     "reductionProjects": null       // null = restore unlimited for this resource
//  *   },
//  *   "notes": "Updated after Q3 review"  // optional
//  * }
//  *
//  * Notes:
//  *   - Setting a value to null restores unlimited access for that resource.
//  *   - You can send partial limits (only the keys you want to change).
//  *   - If new limit < current usage, further creation is blocked (remaining=0)
//  *     but existing data is NOT deleted.
//  */
// router.patch("/:clientId/quota", updateClientQuota);

// /**
//  * Reset ALL quota limits to unlimited (null) for the assigned consultant.
//  *
//  * POST /api/clients/:clientId/quota/reset
//  *
//  * Access: super_admin only
//  */
// router.post("/:clientId/quota/reset", resetClientQuota);


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
router.get("/support-manager", getSupportManagerForClient);

// ===================================================================
// QUOTA STAGE (Stage 3.5 — between proposal and active)
// ===================================================================

/**
 * Mark quota as created (quota_pending → quota_completed status)
 * Must be called BEFORE move-to-active.
 * Access: consultant_admin, super_admin
 *
 * PATCH /api/clients/:clientId/quota-created
 */
router.patch("/:clientId/quota-created", markQuotaCreated);

/**
 * Move client from quota_pending (quota_completed) → active
 * Generates the real GreonXXX clientId, starts subscription, creates client admin.
 * Access: consultant_admin, super_admin
 *
 * Optional body: { reason, sandboxStatus, extensionDays }
 *
 * PATCH /api/clients/:clientId/move-to-active
 */
router.patch("/:clientId/move-to-active", moveToActive);

// ===================================================================
// SUBSCRIPTION MANAGEMENT
// ===================================================================

router.patch("/:clientId/subscription/review", reviewSubscription);
router.patch("/:clientId/subscription", manageSubscription);
router.get("/subscription/pending-approvals", getPendingSubscriptionApprovals);
router.get("/subscription/expiring-soon", getClientsExpiringSoon);

// ===================================================================
// ESGLINK MODULE — SUBSCRIPTION & MODULE ACCESS
// ===================================================================

/**
 * Get pending ESGLink subscription approval requests
 * GET /api/clients/subscription/esglink/pending-approvals
 * Access: super_admin (all) | managing consultant_admin (own clients)
 * NOTE: Must be BEFORE /:clientId patterns to avoid route shadowing
 */
router.get("/subscription/esglink/pending-approvals", getEsgLinkPendingApprovals);

/**
 * Review (approve/reject) a pending ESGLink subscription request
 * PATCH /api/clients/:clientId/subscription/esglink/review
 * Access: super_admin | managing consultant_admin
 */
router.patch("/:clientId/subscription/esglink/review", reviewEsgLinkSubscription);

/**
 * Manage ESGLink subscription (suspend/reactivate/renew/extend)
 * PATCH /api/clients/:clientId/subscription/esglink
 * Access: consultant (request only) | consultant_admin / super_admin (direct)
 */
router.patch("/:clientId/subscription/esglink", manageEsgLinkSubscription);

/**
 * Update client accessible modules
 * PATCH /api/clients/:clientId/module-access
 * Body: { accessibleModules: ['zero_carbon', 'esg_link'] }
 * Access: super_admin (all clients) | managing consultant_admin (own clients)
 */
router.patch("/:clientId/module-access", checkRole('super_admin', 'consultant_admin'), updateClientModuleAccess);

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

router.patch("/:clientId/assessment-level", checkRole('super_admin', 'consultant_admin'), updateAssessmentLevelOnly);
router.post("/system/purge-client/:clientId", purgeClientCompletely);
router.post('/system/hard-reset', hardResetClientSystem);

module.exports = router;