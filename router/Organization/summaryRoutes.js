
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
  compareSummarySelections,
  isSummaryProtected 

  
  
} = require('../../controllers/Calculation/CalculationSummary');
const { auth } = require('../../middleware/auth');
const { checkSummaryPermission } = require('../../utils/Permissions/summaryPermission'); // IMPORT THE CORRECT MIDDLEWARE

// Add to router/Organization/summaryRoutes.js at line 3:
const EmissionSummary = require('../../models/CalculationEmission/EmissionSummary');

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



/**
 * GET /api/emission-summary/allocation-details
 * 
 * Retrieve allocation breakdown for process emissions
 * 
 * Query Parameters:
 * - clientId: Client identifier (required)
 * - periodType: 'daily' | 'monthly' | 'quarterly' | 'yearly' (required)
 * - year: Year (required)
 * - month: Month (optional, required for monthly/daily)
 * - day: Day (optional, required for daily)
 * 
 * Returns:
 * - Allocation breakdown for each scopeIdentifier
 * - Raw emissions, allocated emissions, unallocated emissions
 */
router.get('/allocation-details',  async (req, res) => {
  try {
    const { clientId, periodType, year, month, day } = req.query;

    // Validation
    if (!clientId || !periodType || !year) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameters: clientId, periodType, year'
      });
    }

    // Build query based on period type
    const query = {
      clientId,
      'period.type': periodType,
      'period.year': parseInt(year)
    };

    if (month) {
      query['period.month'] = parseInt(month);
    }

    if (day) {
      query['period.day'] = parseInt(day);
    }

    // Find the emission summary
    const emissionSummary = await EmissionSummary.findOne(query)
      .select('period processEmissionSummary metadata')
      .lean();

    if (!emissionSummary) {
      return res.status(404).json({
        success: false,
        message: 'Emission summary not found for the specified period'
      });
    }

    // Extract allocation data from processEmissionSummary
    const allocationData = {
      period: emissionSummary.period,
      scopeIdentifiers: {},
      summary: {
        totalScopeIdentifiers: 0,
        sharedScopeIdentifiers: emissionSummary.processEmissionSummary?.metadata?.sharedScopeIdentifiers || 0,
        fullyAllocated: 0,
        partiallyAllocated: 0,
        warnings: emissionSummary.processEmissionSummary?.metadata?.allocationWarnings || []
      }
    };

    // Convert byScopeIdentifier from Map/Object to structured format
    const byScopeIdentifier = emissionSummary.processEmissionSummary?.byScopeIdentifier || {};
    
    for (const [scopeId, data] of Object.entries(byScopeIdentifier)) {
      allocationData.totalScopeIdentifiers++;
      
      // Check if fully or partially allocated
      if (data.allocationBreakdown?.unallocatedEmissions?.hasUnallocated) {
        allocationData.summary.partiallyAllocated++;
      } else {
        allocationData.summary.fullyAllocated++;
      }
      
      // Format allocation data for this scopeIdentifier
      allocationData.scopeIdentifiers[scopeId] = {
        scopeType: data.scopeType,
        categoryName: data.categoryName,
        activity: data.activity,
        isShared: data.isShared,
        dataPointCount: data.dataPointCount,
        
        // Allocation breakdown
        allocationBreakdown: data.allocationBreakdown || {
          rawEmissions: data.rawEmissions || {},
          allocatedEmissions: {
            totalAllocatedPct: 0,
            allocations: []
          },
          unallocatedEmissions: {
            unallocatedPct: 100,
            emissions: data.rawEmissions || {},
            hasUnallocated: true
          }
        }
      };
    }

    return res.status(200).json({
      success: true,
      data: allocationData
    });

  } catch (error) {
    console.error('Error retrieving allocation details:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

/**
 * GET /api/emission-summary/allocation-details/:scopeIdentifier
 * 
 * Retrieve allocation breakdown for a specific scopeIdentifier
 * 
 * Path Parameters:
 * - scopeIdentifier: The scope identifier to get details for
 * 
 * Query Parameters:
 * - clientId: Client identifier (required)
 * - periodType: 'daily' | 'monthly' | 'quarterly' | 'yearly' (required)
 * - year: Year (required)
 * - month: Month (optional)
 * - day: Day (optional)
 */
router.get('/allocation-details/:scopeIdentifier',  async (req, res) => {
  try {
    const { scopeIdentifier } = req.params;
    const { clientId, periodType, year, month, day } = req.query;

    // Validation
    if (!clientId || !periodType || !year) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameters: clientId, periodType, year'
      });
    }

    // Build query
    const query = {
      clientId,
      'period.type': periodType,
      'period.year': parseInt(year)
    };

    if (month) query['period.month'] = parseInt(month);
    if (day) query['period.day'] = parseInt(day);

    // Find emission summary
    const emissionSummary = await EmissionSummary.findOne(query)
      .select('period processEmissionSummary')
      .lean();

    if (!emissionSummary) {
      return res.status(404).json({
        success: false,
        message: 'Emission summary not found'
      });
    }

    // Extract specific scopeIdentifier data
    const byScopeIdentifier = emissionSummary.processEmissionSummary?.byScopeIdentifier || {};
    const scopeData = byScopeIdentifier[scopeIdentifier];

    if (!scopeData) {
      return res.status(404).json({
        success: false,
        message: `ScopeIdentifier "${scopeIdentifier}" not found in emission summary`
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        period: emissionSummary.period,
        scopeIdentifier,
        scopeType: scopeData.scopeType,
        categoryName: scopeData.categoryName,
        activity: scopeData.activity,
        isShared: scopeData.isShared,
        dataPointCount: scopeData.dataPointCount,
        allocationBreakdown: scopeData.allocationBreakdown || {
          rawEmissions: scopeData.rawEmissions || {},
          allocatedEmissions: {
            totalAllocatedPct: 0,
            allocations: []
          },
          unallocatedEmissions: {
            unallocatedPct: 100,
            emissions: scopeData.rawEmissions || {},
            hasUnallocated: true
          }
        }
      }
    });

  } catch (error) {
    console.error('Error retrieving scope allocation details:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

/**
 * GET /api/emission-summary/unallocated-emissions
 * 
 * Retrieve list of scopeIdentifiers with unallocated emissions
 * 
 * Query Parameters:
 * - clientId: Client identifier (required)
 * - periodType: 'daily' | 'monthly' | 'quarterly' | 'yearly' (required)
 * - year: Year (required)
 * - month: Month (optional)
 * - day: Day (optional)
 * - minUnallocatedPct: Minimum unallocated percentage to include (default: 0.01)
 */
router.get('/unallocated-emissions',  async (req, res) => {
  try {
    const { clientId, periodType, year, month, day, minUnallocatedPct = 0.01 } = req.query;

    // Validation
    if (!clientId || !periodType || !year) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameters: clientId, periodType, year'
      });
    }

    // Build query
    const query = {
      clientId,
      'period.type': periodType,
      'period.year': parseInt(year)
    };

    if (month) query['period.month'] = parseInt(month);
    if (day) query['period.day'] = parseInt(day);

    // Find emission summary
    const emissionSummary = await EmissionSummary.findOne(query)
      .select('period processEmissionSummary')
      .lean();

    if (!emissionSummary) {
      return res.status(404).json({
        success: false,
        message: 'Emission summary not found'
      });
    }

    // Extract unallocated scopes
    const byScopeIdentifier = emissionSummary.processEmissionSummary?.byScopeIdentifier || {};
    const unallocatedScopes = [];

    for (const [scopeId, data] of Object.entries(byScopeIdentifier)) {
      const breakdown = data.allocationBreakdown;
      
      if (breakdown?.unallocatedEmissions?.hasUnallocated) {
        const unallocatedPct = breakdown.unallocatedEmissions.unallocatedPct;
        
        if (unallocatedPct >= parseFloat(minUnallocatedPct)) {
          unallocatedScopes.push({
            scopeIdentifier: scopeId,
            scopeType: data.scopeType,
            categoryName: data.categoryName,
            activity: data.activity,
            unallocatedPct,
            unallocatedEmissions: breakdown.unallocatedEmissions.emissions,
            rawEmissions: breakdown.rawEmissions,
            allocatedPct: breakdown.allocatedEmissions.totalAllocatedPct
          });
        }
      }
    }

    // Sort by unallocated CO2e (descending)
    unallocatedScopes.sort((a, b) => 
      (b.unallocatedEmissions?.CO2e || 0) - (a.unallocatedEmissions?.CO2e || 0)
    );

    return res.status(200).json({
      success: true,
      data: {
        period: emissionSummary.period,
        totalUnallocatedScopes: unallocatedScopes.length,
        totalUnallocatedCO2e: unallocatedScopes.reduce((sum, s) => 
          sum + (s.unallocatedEmissions?.CO2e || 0), 0
        ),
        unallocatedScopes
      }
    });

  } catch (error) {
    console.error('Error retrieving unallocated emissions:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});


/**
 * POST /api/summaries/:clientId/protection
 * Enable or disable auto-recalculation protection for summaries
 */
router.post('/summaries/:clientId/protection', 
  async (req, res) => {
    try {
      const { clientId } = req.params;
      const { 
        enable, // true to enable protection, false to disable
        periodType, // optional: specific period type
        year,
        month,
        day 
      } = req.body;

      const query = { clientId };
      if (periodType) query['period.type'] = periodType;
      if (year) query['period.year'] = year;
      if (month) query['period.month'] = month;
      if (day) query['period.day'] = day;

      const updateData = {
        'metadata.preventAutoRecalculation': enable,
        'metadata.protectionUpdatedAt': new Date(),
        'metadata.protectionUpdatedBy': req.user._id
      };

      const result = await EmissionSummary.updateMany(query, { $set: updateData });

      return res.status(200).json({
        success: true,
        message: `Protection ${enable ? 'enabled' : 'disabled'} for ${result.modifiedCount} summaries`,
        affectedCount: result.modifiedCount
      });

    } catch (error) {
      console.error('Error updating summary protection:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to update summary protection',
        error: error.message
      });
    }
  }
);

module.exports = router;