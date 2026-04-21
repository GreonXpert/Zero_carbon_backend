// router/verification/verificationRoutes.js
const express = require("express");
const router = express.Router();
const { auth, checkRole } = require("../../../common/middleware/auth");
const {
  createOrUpdateThresholdConfig,
  getThresholdConfigs,
  updateThresholdConfig,
  deleteThresholdConfig,
  listPendingApprovals,
  getPendingApprovalDetail,
  approvePendingEntry,
  rejectPendingEntry,
  getPendingApprovalStats
} = require("./thresholdVerificationController");

// ─────────────────────────────────────────────────────────────────────────────
// Threshold Configuration routes
// Only consultant_admin can create/update/delete configs.
// super_admin can read.
// ─────────────────────────────────────────────────────────────────────────────

// Create or upsert a threshold config
router.post(
  "/threshold-config",
  auth,
  checkRole("consultant_admin"),
  createOrUpdateThresholdConfig
);

// List all threshold configs for a client
router.get(
  "/threshold-config/:clientId",
  auth,
  checkRole("consultant_admin", "super_admin"),
  getThresholdConfigs
);

// Update specific fields of a threshold config
router.patch(
  "/threshold-config/:id",
  auth,
  checkRole("consultant_admin"),
  updateThresholdConfig
);

// Soft-delete (deactivate) a threshold config
router.delete(
  "/threshold-config/:id",
  auth,
  checkRole("consultant_admin"),
  deleteThresholdConfig
);

// ─────────────────────────────────────────────────────────────────────────────
// Pending Approval routes
// consultant_admin and super_admin can list/view.
// Only consultant_admin can approve or reject.
// ─────────────────────────────────────────────────────────────────────────────

// List pending approvals (filterable: ?clientId=&flowType=&status=)
router.get(
  "/pending-approvals",
  auth,
  checkRole("consultant_admin", "super_admin"),
  listPendingApprovals
);

// Get stats for pending approvals (must come before /:id route)
router.get(
  "/pending-approvals/stats/overview",
  auth,
  checkRole("consultant_admin", "super_admin"),
  getPendingApprovalStats
);

// Get detail of one pending approval
router.get(
  "/pending-approvals/:id",
  auth,
  checkRole("consultant_admin", "super_admin"),
  getPendingApprovalDetail
);

// Approve a pending entry → finalizes save into DataEntry or NetReductionEntry
router.post(
  "/pending-approvals/:id/approve",
  auth,
  checkRole("consultant_admin", "consultant"),
  approvePendingEntry
);

// Reject a pending entry → nothing is saved to main collections
router.post(
  "/pending-approvals/:id/reject",
  auth,
  checkRole("consultant_admin", "consultant"),
  rejectPendingEntry
);

module.exports = router;
