'use strict';

const router = require('express').Router();
const c = require('../controllers/settingsController');

router.get  ('/settings',         c.getSettings);
router.patch('/settings',         c.updateSettings);

router.get  ('/config/frameworks',c.listFrameworks);
router.post ('/config/frameworks',c.upsertFramework);

router.get  ('/config/methods',   c.listMethods);
router.post ('/config/methods',   c.upsertMethod);

router.get  ('/permissions',      c.listPermissions);
router.patch('/permissions',      c.upsertPermission);

router.get  ('/scopes',           c.listScopes);
router.patch('/scopes',           c.upsertScope);

module.exports = router;
