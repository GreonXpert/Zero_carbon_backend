'use strict';

const express = require('express');
const router  = express.Router();

const { auth } = require('../../../../common/middleware/auth');
const { requireActiveModuleSubscription } = require('../../../../common/utils/Permissions/modulePermission');

const {
  activateFramework,
  getStatus,
  getReadiness,
  lockFramework,
  reopenFramework,
} = require('../controllers/clientFrameworkController');

const {
  createAssignment,
  listAssignments,
  getMyAssignedQuestions,
} = require('../controllers/assignmentController');

const {
  listClientQuestions,
  prefillAnswer,
  saveAnswer,
  listAllAnswers,
} = require('../controllers/answerController');

const {
  createClientMapping,
  listClientMappings,
  updateClientMapping,
  deactivateClientMapping,
} = require('../controllers/frameworkMappingController');

const {
  consultantFinalApprove,
  getFinalReport,
} = require('../controllers/consultantApprovalController');

const { getProgress } = require('../controllers/progressController');

router.use(auth);
const eslGate = requireActiveModuleSubscription('esg_link');

// ── Client framework lifecycle ────────────────────────────────────────────────
router.post('/clients/:clientId/frameworks/brsr/activate', eslGate, activateFramework);
router.get('/clients/:clientId/frameworks/brsr/status',    eslGate, getStatus);
router.get('/clients/:clientId/frameworks/brsr/readiness', eslGate, getReadiness);
router.post('/clients/:clientId/frameworks/brsr/lock',     eslGate, lockFramework);
router.post('/clients/:clientId/frameworks/brsr/reopen',   eslGate, reopenFramework);

// ── Consultant final approval & final report ──────────────────────────────────
// IMPORTANT: literal paths must come before /:clientId dynamic segments
router.post('/clients/:clientId/frameworks/brsr/consultant-final-approve', eslGate, consultantFinalApprove);
router.get('/clients/:clientId/frameworks/brsr/final-report',              eslGate, getFinalReport);

// ── Assignments ───────────────────────────────────────────────────────────────
router.post('/clients/:clientId/brsr/assignments',    eslGate, createAssignment);
router.get('/clients/:clientId/brsr/assignments',     eslGate, listAssignments);
router.get('/clients/:clientId/brsr/my-questions',    eslGate, getMyAssignedQuestions);

// ── Progress dashboard ────────────────────────────────────────────────────────
router.get('/clients/:clientId/brsr/progress', eslGate, getProgress);

// ── All answers (consultant review view) ──────────────────────────────────────
router.get('/clients/:clientId/brsr/all-answers', eslGate, listAllAnswers);

// ── Client question & prefill ─────────────────────────────────────────────────
router.get('/clients/:clientId/brsr/questions',                          eslGate, listClientQuestions);
router.get('/clients/:clientId/brsr/questions/:questionId/prefill',      eslGate, prefillAnswer);
router.post('/clients/:clientId/brsr/questions/:questionId/answers',     eslGate, saveAnswer);

// ── Client-specific metric mappings ───────────────────────────────────────────
// Each client configures which boundary nodes feed into each metric for each question.
router.post('/clients/:clientId/brsr/questions/:questionId/metrics',              eslGate, createClientMapping);
router.get('/clients/:clientId/brsr/questions/:questionId/metrics',               eslGate, listClientMappings);
router.patch('/clients/:clientId/brsr/questions/:questionId/metrics/:mappingId',  eslGate, updateClientMapping);
router.delete('/clients/:clientId/brsr/questions/:questionId/metrics/:mappingId', eslGate, deactivateClientMapping);

module.exports = router;
