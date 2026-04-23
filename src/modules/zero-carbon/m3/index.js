'use strict';

// ============================================================================
// M3 Net Zero Module — Route Index
// All routes apply: auth + requireActiveModuleSubscription('zero_carbon')
// ============================================================================

const router = require('express').Router();
const { auth } = require('../../../common/middleware/auth');
const { requireActiveModuleSubscription } = require('../../../common/utils/Permissions/modulePermission');

const zcGate = requireActiveModuleSubscription('zero_carbon');

// Apply auth + subscription gate to all M3 routes
router.use(auth);
router.use(zcGate);

const targetRoutes       = require('./routes/targetRoutes');
const allocationRoutes   = require('./routes/allocationRoutes');
const complianceRoutes   = require('./routes/complianceRoutes');
const initiativeRoutes   = require('./routes/initiativeRoutes');
const creditRoutes       = require('./routes/creditRoutes');
const recalculationRoutes= require('./routes/recalculationRoutes');
const evidenceRoutes     = require('./routes/evidenceRoutes');
const reportsRoutes      = require('./routes/reportsRoutes');
const settingsRoutes     = require('./routes/settingsRoutes');

router.use('/targets',      targetRoutes);
router.use('/',             allocationRoutes);
router.use('/',             complianceRoutes);
router.use('/',             initiativeRoutes);
router.use('/',             creditRoutes);
router.use('/',             recalculationRoutes);
router.use('/',             evidenceRoutes);
router.use('/',             reportsRoutes);
router.use('/',             settingsRoutes);

module.exports = router;
