// router/CMS/quotaRoutes.js
// ============================================================
// Quota management routes for consultant-client resource + userType limits.
//
// MOUNT IN index.js:
//   const quotaRoutes = require('./quotaRoutes');
//   app.use('/api/quota', quotaRoutes);
//
// ROUTE MAP
// ┌──────────┬──────────────────────────────────────────────────────────┬─────────────────────────┐
// │ Method   │ Path                                                     │ Handler                 │
// ├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┤
// │ GET      │ /clients/:clientId/quota                                 │ getClientQuota          │
// │ PATCH    │ /clients/:clientId/quota                                 │ updateClientQuota       │
// │ POST     │ /clients/:clientId/quota/reset                           │ resetClientQuota        │
// ├──────────┼──────────────────────────────────────────────────────────┼─────────────────────────┤
// │ GET      │ /clients/:clientId/quota/user-types                      │ getUserTypeQuota        │
// │ PATCH    │ /clients/:clientId/quota/user-types                      │ updateUserTypeQuota     │
// │ POST     │ /clients/:clientId/quota/user-types/reset                │ resetUserTypeQuota      │
// │ POST     │ /clients/:clientId/quota/user-types/sync-counts          │ syncUserTypeUsedCounts  │
// └──────────┴──────────────────────────────────────────────────────────┴─────────────────────────┘
// ============================================================

'use strict';

const express = require('express');
const router  = express.Router();
const { auth, checkRole } = require('../../../common/middleware/auth');

const {
  getClientQuota,
  updateClientQuota,
  resetClientQuota,
  getUserTypeQuota,
  updateUserTypeQuota,
  resetUserTypeQuota,
  syncUserTypeUsedCounts,
} = require('./quotaController');

// All routes require authentication
router.use(auth);

// ── Resource quota routes (existing) ──────────────────────────

/**
 * GET /api/quota/clients/:clientId/quota
 * Get resource quota status (flowcharts, reductions, etc.)
 * Auth: super_admin | consultant_admin | consultant | client_admin (read-only)
 */
router.get(
  '/clients/:clientId/quota',
  checkRole('super_admin', 'consultant_admin', 'consultant', 'client_admin'),
  getClientQuota
);

/**
 * PATCH /api/quota/clients/:clientId/quota
 * Update resource quota limits
 * Auth: super_admin | consultant_admin
 */
router.patch(
  '/clients/:clientId/quota',
  checkRole('super_admin', 'consultant_admin'),
  updateClientQuota
);

/**
 * POST /api/quota/clients/:clientId/quota/reset
 * Reset all resource limits to unlimited
 * Auth: super_admin only
 */
router.post(
  '/clients/:clientId/quota/reset',
  checkRole('super_admin'),
  resetClientQuota
);

// ── User type quota routes (new) ──────────────────────────────

/**
 * GET /api/quota/clients/:clientId/quota/user-types
 * Get userType quota status (employeeHead, employee, viewer, auditor)
 * Auth: super_admin | consultant_admin | consultant | client_admin (read-only)
 */
router.get(
  '/clients/:clientId/quota/user-types',
  checkRole('super_admin', 'consultant_admin', 'consultant', 'client_admin'),
  getUserTypeQuota
);

/**
 * PATCH /api/quota/clients/:clientId/quota/user-types
 * Update userType quota limits (maxCount and/or concurrentLoginLimit per type)
 * Auth: super_admin | consultant_admin
 *
 * Body:
 * {
 *   "userTypeQuotas": {
 *     "employeeHead": { "maxCount": 5, "concurrentLoginLimit": 2 },
 *     "employee":     { "maxCount": 50 },
 *     "viewer":       { "maxCount": null },
 *     "auditor":      { "concurrentLoginLimit": 1 }
 *   },
 *   "notes": "Q4 expansion"
 * }
 */
router.patch(
  '/clients/:clientId/quota/user-types',
  checkRole('super_admin', 'consultant_admin'),
  updateUserTypeQuota
);

/**
 * POST /api/quota/clients/:clientId/quota/user-types/reset
 * Reset all userType limits to defaults (maxCount=1, concurrentLoginLimit=null)
 * NOTE: Does NOT reset usedCount (preserves actual user counts)
 * Auth: super_admin only
 */
router.post(
  '/clients/:clientId/quota/user-types/reset',
  checkRole('super_admin'),
  resetUserTypeQuota
);

/**
 * POST /api/quota/clients/:clientId/quota/user-types/sync-counts
 * Recalculate usedCount from actual live DB counts (migration / correction tool)
 * Auth: super_admin | consultant_admin
 */
router.post(
  '/clients/:clientId/quota/user-types/sync-counts',
  checkRole('super_admin', 'consultant_admin'),
  syncUserTypeUsedCounts
);

module.exports = router;