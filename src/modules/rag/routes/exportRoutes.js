'use strict';

const express = require('express');
const router  = express.Router();

const { exportController } = require('../controllers/exportController');
const { ragPermissions }   = require('../middleware/ragPermissions');

router.post('/:id/export/pdf',                ragPermissions.reportOwner, exportController.triggerPDF);
router.get ('/:id/exports',                   ragPermissions.reportOwner, exportController.listExports);
router.get ('/:id/exports/:exportId/download', ragPermissions.reportOwner, exportController.getDownloadUrl);

module.exports = router;
