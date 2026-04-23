'use strict';

const router = require('express').Router();
const c = require('../controllers/complianceController');

router.post ('/compliance-years',          c.createComplianceYear);
router.get  ('/compliance-years',          c.listComplianceYears);
router.get  ('/compliance-years/:id',      c.getComplianceYear);
router.post ('/compliance-years/:id/close',  c.closeComplianceYear);
router.post ('/compliance-years/:id/reopen', c.reopenComplianceYear);

module.exports = router;
