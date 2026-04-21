// routes/PendingApprovalR.js
const express = require('express');
const router = express.Router();
const {
  listPendingApprovals,
  getPendingApprovalDetail,
  approvePendingApproval,
  rejectPendingApproval,
  getPendingApprovalStats
} = require('../controllers/PendingApprovalController');

const { protectRoute } = require('../../../../common/middleware/auth');

/**
 * All routes require authentication
 * Only consultant_admin can approve/reject
 */

// List pending approvals for consultant's assigned clients
// GET /api/verification/pending-approvals
// Query params: status, flowType, clientId
router.get('/', protectRoute, listPendingApprovals);

// Get stats for pending approvals
// GET /api/verification/pending-approvals/stats/overview
router.get('/stats/overview', protectRoute, getPendingApprovalStats);

// Get single pending approval detail
// GET /api/verification/pending-approvals/:pendingApprovalId
router.get('/:pendingApprovalId', protectRoute, getPendingApprovalDetail);

// Approve pending entry
// POST /api/verification/pending-approvals/:pendingApprovalId/approve
router.post('/:pendingApprovalId/approve', protectRoute, approvePendingApproval);

// Reject pending entry
// POST /api/verification/pending-approvals/:pendingApprovalId/reject
router.post('/:pendingApprovalId/reject', protectRoute, rejectPendingApproval);

module.exports = router;
