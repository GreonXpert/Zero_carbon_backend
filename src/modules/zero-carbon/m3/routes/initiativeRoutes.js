'use strict';

const router = require('express').Router();
const c = require('../controllers/initiativeController');

router.post  ('/initiative-attributions',      c.createAttribution);
router.get   ('/initiative-attributions',      c.listAttributions);
router.patch ('/initiative-attributions/:id',  c.updateAttribution);
router.get   ('/initiative-attributions/:id',  c.getAttribution);

module.exports = router;
