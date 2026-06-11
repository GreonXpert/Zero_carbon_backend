'use strict';

const express = require('express');
const router  = express.Router();

const { templateController }  = require('../controllers/templateController');
const { ragPermissions }      = require('../middleware/ragPermissions');
const { validateRequest }     = require('../middleware/validateRequest');
const { createTemplateSchema, updateTemplateSchema } = require('../validators/templateValidators');

// All template routes require privileged role
router.use(ragPermissions.templateAuthor);

router.get ('/',                  templateController.list);
router.post('/',                  validateRequest(createTemplateSchema), templateController.create);
router.get ('/:id',               templateController.getById);
router.put ('/:id',               validateRequest(updateTemplateSchema), templateController.update);
router.delete('/:id',             templateController.archive);
router.post('/:id/publish',       templateController.publish);
router.get ('/:id/versions',      templateController.listVersions);
router.get ('/:id/versions/:vId', templateController.getVersion);

module.exports = router;
