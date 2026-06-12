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
  deleteQuestion,
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
// IMPORTANT: the stats/summary route must come before /:questionId so "stats"
// isn't matched as a questionId.
router.get('/frameworks/:frameworkCode/questions/stats/summary', eslGate, getQuestionStats);
router.get('/frameworks/:frameworkCode/questions',               eslGate, listQuestions);
router.post('/frameworks/:frameworkCode/questions',              eslGate, createQuestion);

// ── Single question operations ────────────────────────────────────────────────
router.get('/frameworks/:frameworkCode/questions/:questionId',         eslGate, getQuestion);
router.patch('/frameworks/:frameworkCode/questions/:questionId',       eslGate, updateQuestion);
router.post('/frameworks/:frameworkCode/questions/:questionId/submit', eslGate, submitQuestion);
router.post('/frameworks/:frameworkCode/questions/:questionId/approve', eslGate, approveQuestion);
router.post('/frameworks/:frameworkCode/questions/:questionId/reject',  eslGate, rejectQuestion);
router.post('/frameworks/:frameworkCode/questions/:questionId/publish', eslGate, publishQuestion);
router.post('/frameworks/:frameworkCode/questions/:questionId/version', eslGate, versionQuestion);
router.delete('/frameworks/:frameworkCode/questions/:questionId',        eslGate, deleteQuestion);

// ── Question metric mappings ──────────────────────────────────────────────────
router.post('/frameworks/:frameworkCode/questions/:questionId/metrics',                        eslGate, createMapping);
router.get('/frameworks/:frameworkCode/questions/:questionId/metrics',                         eslGate, listMappings);
router.patch('/frameworks/:frameworkCode/questions/:questionId/metrics/:mappingId',            eslGate, updateMapping);
router.delete('/frameworks/:frameworkCode/questions/:questionId/metrics/:mappingId',           eslGate, deactivateMapping);
router.post('/frameworks/:frameworkCode/questions/:questionId/metrics/:mappingId/reactivate',  eslGate, reactivateMapping);

module.exports = router;
