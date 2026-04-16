'use strict';

/**
 * FormulaR.js — Reduction-Module Formula Routes
 *
 * This file:
 *   1. Delegates all common formula CRUD + delete-request routes to the
 *      common formula router at src/modules/common/formula/routes/FormulaR.js
 *   2. Adds the reduction-specific POST /attach/:clientId/:projectId route
 *      (kept here because it involves Reduction model logic)
 *
 * Mounted at: /api/formulas  (in registerRoutes.js — no change needed there)
 */

const express = require('express');
const router  = express.Router();

const { auth, checkRole } = require('../../../../common/middleware/auth');
const { attachFormulaToReduction } = require('../controllers/attachFormulaToReduction');

// ── Reduction-specific route (attach formula to a Reduction project) ──────────
// Registered BEFORE delegating to the common router to ensure specificity.
const works = ['consultant', 'consultant_admin', 'super_admin'];
router.post('/attach/:clientId/:projectId', auth, checkRole(...works), attachFormulaToReduction);

// ── All other formula routes → delegated to common module ─────────────────────
const commonFormulaRouter = require('../../../common/formula/routes/FormulaR');
router.use('/', commonFormulaRouter);

module.exports = router;
