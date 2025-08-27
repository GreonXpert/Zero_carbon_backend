// router/sbtiRoutes.js
const express = require('express');
const router = express.Router();
const { auth } = require('../../middleware/auth');

// (create your own permission middleware if needed)
const {
  setSocketIO,
  upsertTarget,
  getTargets,
  getTrajectory,
  addRenewableProgress,
  addSupplierEngagement,
  setFlagInfo,
  setCoverageInfo,
  setInventoryCoverage, 
} = require('../../controllers/Decabonization/sbtiController');

// Apply auth to all SBTi routes
router.use(auth);

/**
 * @route   POST /api/sbti/:clientId/targets
 * @desc    Create or update an SBTi/custom target (near-term or net-zero) with Absolute or SDA method
 */
router.post('/:clientId/targets', upsertTarget);

/**
 * @route   GET /api/sbti/:clientId/targets
 * @query   targetType=near_term|net_zero (optional)
 * @desc    Get targets for a client (optionally filter by type)
 */
router.get('/:clientId/targets', getTargets);

/**
 * @route   GET /api/sbti/:clientId/trajectory
 * @query   targetType=near_term|net_zero (required)
 * @desc    Get precomputed year-by-year target trajectory
 */
router.get('/:clientId/trajectory', getTrajectory);

/**
 * @route   POST /api/sbti/:clientId/track/renewable?targetType=near_term
 * @desc    Track Renewable Electricity progress for a given year
 */
router.post('/:clientId/track/renewable', addRenewableProgress);

/**
 * @route   POST /api/sbti/:clientId/track/supplier-engagement?targetType=near_term
 * @desc    Track Supplier Engagement % for a given year
 */
router.post('/:clientId/track/supplier-engagement', addSupplierEngagement);

/**
 * @route   POST /api/sbti/:clientId/track/flag?targetType=near_term
 * @desc    Set FLAG share & coverage — validates requirement and coverage thresholds
 */
router.post('/:clientId/track/flag', setFlagInfo);

/**
 * @route   PATCH /api/sbti/:clientId/coverage?targetType=near_term
 * @desc    Set coverage info and auto-check SBTi thresholds for Scope 3
 */
router.patch('/:clientId/coverage', setCoverageInfo);

/**
 * @route   POST /api/sbti/:clientId/coverage/inventory?targetType=near_term
 * @desc    Compute & save S1+2 covered %, S3 reported %, S3 covered-by-targets % (67% test)
 */
router.post('/:clientId/coverage/inventory', setInventoryCoverage);

module.exports = router;
