'use strict';

const express = require('express');
const router  = express.Router();

const { auth } = require('../../../../common/middleware/auth');
const { requireActiveModuleSubscription } = require('../../../../common/utils/Permissions/modulePermission');

const {
  createFramework,
  listFrameworks,
  getFrameworkById,
  updateFramework,
  seedBrsrFramework,
} = require('../controllers/frameworkController');

const {
  createSection,
  listSections,
  updateSection,
} = require('../controllers/frameworkSectionController');

router.use(auth);
const eslGate = requireActiveModuleSubscription('esg_link');

// ── Framework CRUD ────────────────────────────────────────────────────────────
router.post('/frameworks',               eslGate, createFramework);
router.get('/frameworks',                eslGate, listFrameworks);
router.get('/frameworks/:frameworkId',   eslGate, getFrameworkById);
router.patch('/frameworks/:frameworkId', eslGate, updateFramework);

// ── BRSR seed (idempotent, super_admin only) ──────────────────────────────────
router.post('/frameworks/brsr/seed', eslGate, seedBrsrFramework);

// ── Framework sections ────────────────────────────────────────────────────────
router.post('/frameworks/sections',                  eslGate, createSection);
router.get('/frameworks/:frameworkId/sections',      eslGate, listSections);
router.patch('/frameworks/sections/:sectionId',      eslGate, updateSection);

module.exports = router;
