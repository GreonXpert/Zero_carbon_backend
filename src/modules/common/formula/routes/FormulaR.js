'use strict';

/**
 * FormulaR.js — Common Formula Routes
 *
 * All CRUD and delete-request management for the common formula module.
 * Mounted at /api/formulas (via registerRoutes.js → reduction/routes/FormulaR.js re-export).
 *
 * NOTE: The POST /attach/:clientId/:projectId endpoint is NOT here.
 * It stays in the reduction-specific routes file:
 *   src/modules/zero-carbon/reduction/routes/FormulaR.js
 * That file delegates all common routes to this router and adds the attach route.
 */

const router = require('express').Router();
const ctrl   = require('../controllers/FormulaController');
const { auth, checkRole } = require('../../../../common/middleware/auth');

// All endpoints require authentication
router.use(auth);

const works = ['consultant', 'consultant_admin', 'super_admin'];
const gets  = ['consultant', 'consultant_admin', 'super_admin', 'client_admin', 'auditor'];

// ── Delete-request routes ─────────────────────────────────────────────────────
// These must be registered BEFORE /:formulaId routes to avoid param conflicts.
router.get('/delete-requests',              checkRole(...works), ctrl.getDeleteRequestedIds);
router.get('/delete-requests/filter/query', checkRole(...works), ctrl.filterDeleteRequested);
router.get('/delete-requests/:requestId',   checkRole(...works), ctrl.getDeleteRequestedById);

router.post(
  '/delete-requests/:requestId/approve',
  checkRole('super_admin', 'consultant_admin'),
  ctrl.approveDeleteRequest
);
router.post(
  '/delete-requests/:requestId/reject',
  checkRole('super_admin', 'consultant_admin'),
  ctrl.rejectDeleteRequest
);

// ── Formula CRUD ──────────────────────────────────────────────────────────────
router.post('/',                    checkRole(...works), ctrl.createFormula);
router.get('/',                     checkRole(...gets),  ctrl.listFormulas);
router.get('/:formulaId',           checkRole(...gets),  ctrl.getFormula);
router.put('/:formulaId',           checkRole(...works), ctrl.updateFormula);
router.delete('/:formulaId/:mode?', checkRole(...works), ctrl.deleteFormula);

module.exports = router;
