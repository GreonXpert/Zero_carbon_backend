'use strict';

const express = require('express');
const router  = express.Router();

const { auditController } = require('../controllers/auditController');
const { ragPermissions }  = require('../middleware/ragPermissions');

router.use(ragPermissions.auditViewer);

router.get ('/',    auditController.list);
router.get ('/:id', auditController.getById);

module.exports = router;
