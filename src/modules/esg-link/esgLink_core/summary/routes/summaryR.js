'use strict';

const express = require('express');
const { auth } = require('../../../../../common/middleware/auth');
const { requireActiveModuleSubscription } = require('../../../../../common/utils/Permissions/modulePermission');
const { checkEsgSummaryPermission }       = require('../utils/summaryPermissions');
const ctrl = require('../controllers/summaryController');

const router = express.Router();

const guard = [auth, requireActiveModuleSubscription('esg_link'), checkEsgSummaryPermission];

router.get ('/:clientId/summary/dashboard',                        guard, ctrl.getDashboardSummary);
router.get ('/:clientId/summary/my-view',                          guard, ctrl.getMyViewSummary);
router.get ('/:clientId/summary/reviewer-pending',                 guard, ctrl.getReviewerPendingSummary);
router.get ('/:clientId/summary/approver-pending',                 guard, ctrl.getApproverPendingSummary);
router.get ('/:clientId/boundaries/:boundaryId/summary',           guard, ctrl.getBoundarySummary);
router.get ('/:clientId/boundaries/:boundaryId/summary/hierarchy', guard, ctrl.getHierarchySummary);
router.post('/:clientId/boundaries/:boundaryId/summary/refresh',   guard, ctrl.refreshSummary);

module.exports = router;
