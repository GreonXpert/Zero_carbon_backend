// router/summaryRoutes.js

const express = require('express');
const router = express.Router();
const {
  getEmissionSummary,
  getMultipleSummaries,
//   recalculateSummaries,
//   getDashboardSummary
} = require('../controllers/Calculation/CalculationSummary');
const { authenticate } = require('../middleware/auth');

// Middleware to check permissions for summary access
const checkSummaryPermission = (req, res, next) => {
  const { clientId } = req.params;
  const user = req.user;

  // Super admin can access all summaries
  if (user.userType === 'super_admin') {
    return next();
  }

  // Consultant admin can access summaries for clients they created
  if (user.userType === 'consultant_admin') {
    // Additional check needed - implement client ownership verification
    return next();
  }

  // Consultant can access summaries for assigned clients
  if (user.userType === 'consultant') {
    // Additional check needed - implement client assignment verification
    return next();
  }

  // Client users can only access their own organization's summaries
  if (['client_admin', 'client_employee_head', 'employee', 'auditor'].includes(user.userType)) {
    if (user.clientId !== clientId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only view summaries for your own organization.',
        yourClientId: user.clientId,
        requestedClientId: clientId
      });
    }
    return next();
  }

  return res.status(403).json({
    success: false,
    message: 'Access denied. Insufficient permissions to view summaries.'
  });
};

// Apply authentication to all routes
router.use(authenticate);

/**
 * @route   GET /api/summaries/:clientId
 * @desc    Get emission summary for a specific period
 * @access  Private (Client users, Consultants, Admins)
 * @query   periodType: daily|weekly|monthly|yearly|all-time (default: monthly)
 *          year: YYYY (optional)
 *          month: 1-12 (optional)
 *          week: 1-53 (optional)
 *          day: 1-31 (optional)
 *          recalculate: true|false (default: false)
 */
router.get('/:clientId', checkSummaryPermission, getEmissionSummary);

/**
 * @route   GET /api/summaries/:clientId/dashboard
 * @desc    Get dashboard summary data (current month, all-time, trends)
 * @access  Private
 */
// router.get('/:clientId/dashboard', checkSummaryPermission, getDashboardSummary);

/**
 * @route   GET /api/summaries/:clientId/multiple
 * @desc    Get multiple summaries for comparison and trends
 * @access  Private
 * @query   periodType: monthly|yearly (default: monthly)
 *          startYear: YYYY (optional)
 *          startMonth: 1-12 (optional)
 *          endYear: YYYY (optional)
 *          endMonth: 1-12 (optional)
 *          limit: number (default: 12)
 */
router.get('/:clientId/multiple', checkSummaryPermission, getMultipleSummaries);

/**
 * @route   POST /api/summaries/:clientId/recalculate
 * @desc    Force recalculation of summaries for a specific period range
 * @access  Private (Admins only)
 * @body    periodType: monthly|yearly
 *          startYear: YYYY
 *          startMonth: 1-12 (for monthly)
 *          endYear: YYYY
 *          endMonth: 1-12 (for monthly)
 */
// router.post('/:clientId/recalculate', checkSummaryPermission, recalculateSummaries);

/**
 * @route   GET /api/summaries/:clientId/scope/:scopeType
 * @desc    Get summary for a specific scope type
 * @access  Private
 */
router.get('/:clientId/scope/:scopeType', checkSummaryPermission, async (req, res) => {
  try {
    const { clientId, scopeType } = req.params;
    const { periodType = 'all-time', year, month } = req.query;

    // Validate scope type
    if (!['Scope 1', 'Scope 2', 'Scope 3'].includes(scopeType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid scope type. Must be: Scope 1, Scope 2, or Scope 3'
      });
    }

    // Get the full summary first
    const { getEmissionSummary: getSummary } = require('../controllers/Calculation/CalculationSummary');
    
    // Create a mock request object
    const mockReq = {
      params: { clientId },
      query: { periodType, year, month },
      user: req.user
    };

    // Create a mock response object to capture the data
    let summaryData = null;
    const mockRes = {
      status: () => ({
        json: (data) => {
          summaryData = data;
        }
      })
    };

    await getSummary(mockReq, mockRes);

    if (!summaryData || !summaryData.success) {
      return res.status(404).json({
        success: false,
        message: 'No summary data found'
      });
    }

    const fullSummary = summaryData.data;
    
    // Extract scope-specific data
    const scopeData = {
      scopeType,
      period: fullSummary.period,
      emissions: fullSummary.byScope[scopeType],
      categories: {},
      activities: {},
      nodes: {},
      inputTypes: {},
      trends: fullSummary.trends?.scopeChanges?.[scopeType]
    };

    // Filter categories for this scope
    Object.entries(fullSummary.byCategory || {}).forEach(([categoryName, categoryData]) => {
      if (categoryData.scopeType === scopeType) {
        scopeData.categories[categoryName] = categoryData;
      }
    });

    // Filter activities for this scope
    Object.entries(fullSummary.byActivity || {}).forEach(([activityName, activityData]) => {
      if (activityData.scopeType === scopeType) {
        scopeData.activities[activityName] = activityData;
      }
    });

    // Filter node data for this scope
    Object.entries(fullSummary.byNode || {}).forEach(([nodeId, nodeData]) => {
      if (nodeData.byScope && nodeData.byScope[scopeType] && nodeData.byScope[scopeType].CO2e > 0) {
        scopeData.nodes[nodeId] = {
          ...nodeData,
          scopeEmissions: nodeData.byScope[scopeType]
        };
      }
    });

    res.status(200).json({
      success: true,
      data: scopeData
    });

  } catch (error) {
    console.error(`Error getting ${scopeType} summary:`, error);
    res.status(500).json({
      success: false,
      message: `Failed to get ${scopeType} summary`,
      error: error.message
    });
  }
});

/**
 * @route   GET /api/summaries/:clientId/category/:categoryName
 * @desc    Get summary for a specific category
 * @access  Private
 */
router.get('/:clientId/category/:categoryName', checkSummaryPermission, async (req, res) => {
  try {
    const { clientId, categoryName } = req.params;
    const { periodType = 'all-time', year, month } = req.query;

    // Get the full summary first
    const { getEmissionSummary: getSummary } = require('../controllers/Calculation/CalculationSummary');
    
    // Create a mock request/response to get summary data
    const mockReq = {
      params: { clientId },
      query: { periodType, year, month },
      user: req.user
    };

    let summaryData = null;
    const mockRes = {
      status: () => ({
        json: (data) => {
          summaryData = data;
        }
      })
    };

    await getSummary(mockReq, mockRes);

    if (!summaryData || !summaryData.success) {
      return res.status(404).json({
        success: false,
        message: 'No summary data found'
      });
    }

    const fullSummary = summaryData.data;
    const categoryData = fullSummary.byCategory?.[categoryName];

    if (!categoryData) {
      return res.status(404).json({
        success: false,
        message: `Category '${categoryName}' not found`
      });
    }

    res.status(200).json({
      success: true,
      data: {
        categoryName,
        period: fullSummary.period,
        emissions: categoryData,
        activities: categoryData.activities || {},
        scopeType: categoryData.scopeType,
        percentage: fullSummary.totalEmissions.CO2e > 0 
          ? ((categoryData.CO2e / fullSummary.totalEmissions.CO2e) * 100).toFixed(2)
          : 0
      }
    });

  } catch (error) {
    console.error(`Error getting category summary for ${categoryName}:`, error);
    res.status(500).json({
      success: false,
      message: 'Failed to get category summary',
      error: error.message
    });
  }
});

/**
 * @route   GET /api/summaries/:clientId/node/:nodeId
 * @desc    Get summary for a specific node
 * @access  Private
 */
router.get('/:clientId/node/:nodeId', checkSummaryPermission, async (req, res) => {
  try {
    const { clientId, nodeId } = req.params;
    const { periodType = 'all-time', year, month } = req.query;

    // Get the full summary first
    const { getEmissionSummary: getSummary } = require('../controllers/Calculation/CalculationSummary');
    
    const mockReq = {
      params: { clientId },
      query: { periodType, year, month },
      user: req.user
    };

    let summaryData = null;
    const mockRes = {
      status: () => ({
        json: (data) => {
          summaryData = data;
        }
      })
    };

    await getSummary(mockReq, mockRes);

    if (!summaryData || !summaryData.success) {
      return res.status(404).json({
        success: false,
        message: 'No summary data found'
      });
    }

    const fullSummary = summaryData.data;
    const nodeData = fullSummary.byNode?.[nodeId];

    if (!nodeData) {
      return res.status(404).json({
        success: false,
        message: `Node '${nodeId}' not found`
      });
    }

    res.status(200).json({
      success: true,
      data: {
        nodeId,
        nodeLabel: nodeData.nodeLabel,
        department: nodeData.department,
        location: nodeData.location,
        period: fullSummary.period,
        totalEmissions: {
          CO2e: nodeData.CO2e,
          CO2: nodeData.CO2,
          CH4: nodeData.CH4,
          N2O: nodeData.N2O,
          uncertainty: nodeData.uncertainty
        },
        byScope: nodeData.byScope,
        percentage: fullSummary.totalEmissions.CO2e > 0 
          ? ((nodeData.CO2e / fullSummary.totalEmissions.CO2e) * 100).toFixed(2)
          : 0
      }
    });

  } catch (error) {
    console.error(`Error getting node summary for ${nodeId}:`, error);
    res.status(500).json({
      success: false,
      message: 'Failed to get node summary',
      error: error.message
    });
  }
});

/**
 * @route   GET /api/summaries/:clientId/department/:departmentName
 * @desc    Get summary for a specific department
 * @access  Private
 */
router.get('/:clientId/department/:departmentName', checkSummaryPermission, async (req, res) => {
  try {
    const { clientId, departmentName } = req.params;
    const { periodType = 'all-time', year, month } = req.query;

    // Get the full summary first
    const { getEmissionSummary: getSummary } = require('../controllers/Calculation/CalculationSummary');
    
    const mockReq = {
      params: { clientId },
      query: { periodType, year, month },
      user: req.user
    };

    let summaryData = null;
    const mockRes = {
      status: () => ({
        json: (data) => {
          summaryData = data;
        }
      })
    };

    await getSummary(mockReq, mockRes);

    if (!summaryData || !summaryData.success) {
      return res.status(404).json({
        success: false,
        message: 'No summary data found'
      });
    }

    const fullSummary = summaryData.data;
    const departmentData = fullSummary.byDepartment?.[departmentName];

    if (!departmentData) {
      return res.status(404).json({
        success: false,
        message: `Department '${departmentName}' not found`
      });
    }

    // Get nodes in this department
    const departmentNodes = {};
    Object.entries(fullSummary.byNode || {}).forEach(([nodeId, nodeData]) => {
      if (nodeData.department === departmentName) {
        departmentNodes[nodeId] = nodeData;
      }
    });

    res.status(200).json({
      success: true,
      data: {
        departmentName,
        period: fullSummary.period,
        emissions: departmentData,
        nodes: departmentNodes,
        nodeCount: departmentData.nodeCount,
        percentage: fullSummary.totalEmissions.CO2e > 0 
          ? ((departmentData.CO2e / fullSummary.totalEmissions.CO2e) * 100).toFixed(2)
          : 0
      }
    });

  } catch (error) {
    console.error(`Error getting department summary for ${departmentName}:`, error);
    res.status(500).json({
      success: false,
      message: 'Failed to get department summary',
      error: error.message
    });
  }
});

module.exports = router;