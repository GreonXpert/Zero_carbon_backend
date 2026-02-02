
const express = require('express');
const router = express.Router();
const {
  getEmissionSummary,
  getMultipleSummaries,
  getFilteredSummary,
  getLatestScope12Total,
  getTopLowEmissionStats,
  getScopeIdentifierEmissionExtremes,
  getScopeIdentifierHierarchy, 
  getReductionSummaryHierarchy,
     getSbtiProgress,
  getReductionSummariesByProjects,
  getScopeIdentifierHierarchyOfProcessEmissionSummary,
  compareSummarySelections 

  
  
} = require('../../controllers/Calculation/CalculationSummary');
const { auth } = require('../../middleware/auth');
const { checkSummaryPermission } = require('../../utils/Permissions/summaryPermission'); // IMPORT THE CORRECT MIDDLEWARE



/**
 * @route   GET /api/summaries/:clientId/scope12-total
 * @desc    Return latest Scope 1 + Scope 2 total for the client by
 *          reading the most recent EmissionSummary document
 */
router.get('/:clientId/scope12-total',getLatestScope12Total);

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
 * @route   GET /api/summaries/:clientId/top-low
 * @desc    Get top & low emitters:
 *          - highest & lowest category (by CO2e)
 *          - highest & lowest scope (Scope 1/2/3)
 *          - highest & lowest emission source (byEmissionFactor)
 * @query   periodType=daily|weekly|monthly|yearly|all-time (optional)
 * @query   year=<YYYY> (optional)
 * @query   month=<1-12> (optional)
 * @query   week=<1-53> (optional)
 * @query   day=<1-31> (optional)
 * @query   limit=<N> (optional, default: 5)
 */
router.get(
  '/:clientId/top-low',
  checkSummaryPermission,
  getTopLowEmissionStats
);


/**
 * @route   GET /api/summaries/:clientId/scope-identifiers/extremes
 * @desc    For each scopeIdentifier, show:
 *          - totalCO2e in the period
 *          - highest single-entry emission + date/time
 *          - lowest (non-zero) single-entry emission + date/time
 *          - daily totals and max/min emission day
 *          Also returns overall highest & lowest scopeIdentifier by total emissions.
 *
 * @query   periodType=daily|weekly|monthly|yearly|all-time (optional, default: monthly)
 * @query   year=<YYYY> (optional, defaults like getEmissionSummary)
 * @query   month=<1-12> (optional)
 * @query   week=<1-53> (optional)
 * @query   day=<1-31> (optional)
 */
router.get(
  '/:clientId/scope-identifiers/extremes',
  checkSummaryPermission,
  getScopeIdentifierEmissionExtremes
);


/**
 * @route   GET /api/summaries/:clientId/scope-identifiers/hierarchy
 * @desc    Hierarchical view of emissions by scopeIdentifier → node → entries,
 *          with everything sorted from high to low, plus global node ranking.
 *
 * @query   periodType=daily|weekly|monthly|yearly|all-time (optional, default: monthly)
 * @query   year=<YYYY> (optional)
 * @query   month=<1-12> (optional)
 * @query   week=<1-53> (optional)
 * @query   day=<1-31> (optional)
 */
router.get(
  "/:clientId/scope-identifiers/hierarchy",
  checkSummaryPermission,
  getScopeIdentifierHierarchy
);

router.get(
  '/:clientId/reduction/hierarchy',
  checkSummaryPermission,
  getReductionSummaryHierarchy
);

/**
 * @route GET /api/summaries/:clientId/sbti-progress
 * @desc  Returns SBTi yearly progress for the client
 */
router.get(
  "/:clientId/sbti-progress",
  checkSummaryPermission,
  getSbtiProgress
);


// routes/summaries.js (or wherever you define summary routes)
router.get(
  "/:clientId/reduction/projects",
  getReductionSummariesByProjects
);

router.get("/:clientId/scope-identifiers/hierarchy/process",getScopeIdentifierHierarchyOfProcessEmissionSummary);

/**
 * @route   POST /api/summaries/:clientId/compare
 * @desc    Compare Selection A vs Selection B for emission/process with full filters
 */
router.post("/:clientId/compare", checkSummaryPermission, compareSummarySelections);



module.exports = router;