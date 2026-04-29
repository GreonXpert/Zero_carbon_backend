'use strict';

const express = require('express');
const router  = express.Router();

const { auth } = require('../../../../common/middleware/auth');
const { requireActiveModuleSubscription } = require('../../../../common/utils/Permissions/modulePermission');

const {
  createQuestion,
  updateQuestion,
  submitQuestion,
  approveQuestion,
  rejectQuestion,
  publishQuestion,
  versionQuestion,
  listQuestions,
  getQuestion,
  getQuestionStats,
} = require('../controllers/frameworkQuestionController');

const {
  createMapping,
  listMappings,
  updateMapping,
  deactivateMapping,
  reactivateMapping,
} = require('../controllers/frameworkMappingController');

router.use(auth);
const eslGate = requireActiveModuleSubscription('esg_link');

// ── Question list and stats ───────────────────────────────────────────────────
// IMPORTANT: these literal paths must come before /:questionId
router.get('/frameworks/brsr/questions/stats/summary', eslGate, getQuestionStats);
router.get('/frameworks/brsr/questions',               eslGate, listQuestions);
router.post('/frameworks/brsr/questions',              eslGate, createQuestion);

// ── Single question operations ────────────────────────────────────────────────
router.get('/frameworks/brsr/questions/:questionId',         eslGate, getQuestion);
router.patch('/frameworks/brsr/questions/:questionId',       eslGate, updateQuestion);
router.post('/frameworks/brsr/questions/:questionId/submit', eslGate, submitQuestion);
router.post('/frameworks/brsr/questions/:questionId/approve', eslGate, approveQuestion);
router.post('/frameworks/brsr/questions/:questionId/reject',  eslGate, rejectQuestion);
router.post('/frameworks/brsr/questions/:questionId/publish', eslGate, publishQuestion);
router.post('/frameworks/brsr/questions/:questionId/version', eslGate, versionQuestion);

// ── Question metric mappings ──────────────────────────────────────────────────
router.post('/frameworks/brsr/questions/:questionId/metrics',                        eslGate, createMapping);
router.get('/frameworks/brsr/questions/:questionId/metrics',                         eslGate, listMappings);
router.patch('/frameworks/brsr/questions/:questionId/metrics/:mappingId',            eslGate, updateMapping);
router.delete('/frameworks/brsr/questions/:questionId/metrics/:mappingId',           eslGate, deactivateMapping);
router.post('/frameworks/brsr/questions/:questionId/metrics/:mappingId/reactivate',  eslGate, reactivateMapping);

module.exports = router;
