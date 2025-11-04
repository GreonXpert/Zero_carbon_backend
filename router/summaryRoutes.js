// router/summaryRoutes.js

const express = require('express');
const router = express.Router();
const {
  getEmissionSummary,
  getMultipleSummaries,
  getFilteredSummary,
  getLatestScope12Total,
} = require('../controllers/Calculation/CalculationSummary');
const { auth } = require('../middleware/auth');
const { checkSummaryPermission } = require('../utils/Permissions/summaryPermission'); // IMPORT THE CORRECT MIDDLEWARE

// Apply authentication to all routes
router.use(auth);

/**
 * @route   GET /api/summaries/:clientId
 * @desc    Get emission summary for a specific period
 */
router.get('/:clientId', checkSummaryPermission, getEmissionSummary);

/**
 * @route   GET /api/summaries/:clientId/multiple
 * @desc    Get multiple summaries for comparison and trends
 */
router.get('/:clientId/multiple', checkSummaryPermission, getMultipleSummaries);


/**
 * @route   GET /api/summaries/:clientId/filtered
 * @desc    Get a filtered summary view by scope, category, node, or department
 * @query   scope=Scope 1|Scope 2|Scope 3
 * @query   category=<CategoryName>
 * @query   nodeId=<NodeId>
 * @query   department=<DepartmentName>
 * @query   periodType=daily|monthly|yearly|all-time (optional, default: all-time)
 * @query   year=<YYYY> (optional)
 * @query   month=<1-12> (optional)
 */
router.get('/:clientId/filtered', checkSummaryPermission, getFilteredSummary);



/**
 * @route   GET /api/summaries/:clientId/scope12-total
 * @desc    Return latest Scope 1 + Scope 2 total for the client by
 *          reading the most recent EmissionSummary document
 */
router.get('/:clientId/scope12-total', checkSummaryPermission, getLatestScope12Total);


module.exports = router;