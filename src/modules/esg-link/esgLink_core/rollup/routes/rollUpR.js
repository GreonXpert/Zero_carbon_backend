'use strict';

const express  = require('express');
const { auth } = require('../../../../../common/middleware/auth');
const ctrl     = require('../controllers/rollUpController');

const router = express.Router();

router.get   ('/rollup-behaviors',     auth, ctrl.listBehaviors);
router.post  ('/rollup-behaviors',     auth, ctrl.createBehavior);
router.patch ('/rollup-behaviors/:id', auth, ctrl.updateBehavior);
router.delete('/rollup-behaviors/:id', auth, ctrl.deleteBehavior);

module.exports = router;
