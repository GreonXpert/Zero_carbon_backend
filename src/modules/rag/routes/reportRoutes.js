'use strict';

const express = require('express');
const router  = express.Router();

const { reportController }  = require('../controllers/reportController');
const { ragPermissions }    = require('../middleware/ragPermissions');
const { validateRequest }   = require('../middleware/validateRequest');
const { generateReportSchema, updateContentSchema } = require('../validators/reportValidators');

router.get ('/',            reportController.list);
router.post('/generate',    validateRequest(generateReportSchema), reportController.generate);

router.get ('/:id',         ragPermissions.reportOwner, reportController.getById);
router.put ('/:id/content', ragPermissions.reportOwner, ragPermissions.reportEditable, validateRequest(updateContentSchema), reportController.updateContent);
router.post('/:id/finalize',   ragPermissions.reportOwner, reportController.finalize);
router.post('/:id/regenerate', ragPermissions.reportOwner, reportController.regenerate);
router.get ('/:id/snapshots',  ragPermissions.reportOwner, reportController.listSnapshots);
router.delete('/:id',          ragPermissions.reportOwner, reportController.softDelete);

module.exports = router;
