'use strict';

const router = require('express').Router();
const c = require('../controllers/reportsController');

// All report endpoints are read-only
router.get('/reports/target-summary',          c.targetSummary);
router.get('/reports/compliance-year',         c.complianceYearReport);
router.get('/reports/source-accountability',   c.sourceAccountability);
router.get('/reports/initiative-reduction',    c.initiativeReduction);
router.get('/reports/forecast-risk',           c.forecastRisk);
router.get('/reports/audit-evidence-package',  c.auditEvidencePackage);

module.exports = router;
