'use strict';

const router = require('express').Router();
const c = require('../controllers/creditsController');

router.post ('/residual-positions',          c.createResidualPosition);
router.get  ('/residual-positions',          c.listResidualPositions);
router.get  ('/residual-positions/:id',      c.getResidualPosition);

router.post ('/credits',          c.createCredit);
router.get  ('/credits',          c.listCredits);
router.get  ('/credits/:id',      c.getCredit);
router.patch('/credits/:id',      c.updateCredit);
router.post ('/credits/:id/retire',  c.retireCredit);
router.post ('/credits/:id/hold',    c.holdCredit);
router.post ('/credits/:id/cancel',  c.cancelCredit);

module.exports = router;
