'use strict';

const router = require('express').Router();
const c = require('../controllers/recalculationController');

router.post ('/recalculation-events',              c.createRecalcEvent);
router.get  ('/recalculation-events',              c.listRecalcEvents);
router.get  ('/recalculation-events/:id',          c.getRecalcEvent);
router.post ('/recalculation-events/:id/approve',  c.approveRecalcEvent);
router.post ('/recalculation-events/:id/reject',   c.rejectRecalcEvent);

module.exports = router;
