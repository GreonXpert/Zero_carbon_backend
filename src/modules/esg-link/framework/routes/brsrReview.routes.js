'use strict';

const express = require('express');
const router  = express.Router();

const { auth } = require('../../../../common/middleware/auth');
const { requireActiveModuleSubscription } = require('../../../../common/utils/Permissions/modulePermission');

const {
  reviewerComment,
  reviewerApprove,
  reviewerRequestChanges,
  submitToApprover,
  requestContributorClarification,
  approverQuery,
  approverApprove,
  replyToComment,
  resolveComment,
} = require('../controllers/reviewController');

router.use(auth);
const eslGate = requireActiveModuleSubscription('esg_link');

// ── Reviewer actions ──────────────────────────────────────────────────────────
router.post('/brsr/answers/:answerId/reviewer/comment',                       eslGate, reviewerComment);
router.post('/brsr/answers/:answerId/reviewer/approve',                       eslGate, reviewerApprove);
router.post('/brsr/answers/:answerId/reviewer/request-changes',               eslGate, reviewerRequestChanges);
router.post('/brsr/answers/:answerId/reviewer/submit-to-approver',            eslGate, submitToApprover);
router.post('/brsr/answers/:answerId/reviewer/request-contributor-clarification', eslGate, requestContributorClarification);

// ── Approver actions ──────────────────────────────────────────────────────────
router.post('/brsr/answers/:answerId/approver/query',   eslGate, approverQuery);
router.post('/brsr/answers/:answerId/approver/approve', eslGate, approverApprove);

// ── Comment thread ────────────────────────────────────────────────────────────
router.post('/brsr/comments/:commentId/reply',   eslGate, replyToComment);
router.post('/brsr/comments/:commentId/resolve', eslGate, resolveComment);

module.exports = router;
