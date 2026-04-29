'use strict';

const express = require('express');
const router  = express.Router();

const { auth } = require('../../../../common/middleware/auth');
const { requireActiveModuleSubscription } = require('../../../../common/utils/Permissions/modulePermission');

const {
  getAnswer,
  updateAnswer,
  submitAnswer,
} = require('../controllers/answerController');

const {
  addEvidence,
  listEvidence,
  updateEvidence,
  deleteEvidence,
} = require('../controllers/evidenceController');

const { updateAssignment }    = require('../controllers/assignmentController');
const { listComments }        = require('../controllers/reviewController');
const { approveMetricData }   = require('../controllers/consultantApprovalController');

router.use(auth);
const eslGate = requireActiveModuleSubscription('esg_link');

// ── Assignment update ─────────────────────────────────────────────────────────
router.patch('/brsr/assignments/:assignmentId', eslGate, updateAssignment);

// ── Answer CRUD & submission ──────────────────────────────────────────────────
router.get('/brsr/answers/:answerId',         eslGate, getAnswer);
router.patch('/brsr/answers/:answerId',       eslGate, updateAnswer);
router.post('/brsr/answers/:answerId/submit', eslGate, submitAnswer);

// ── Consultant metric-data approval ──────────────────────────────────────────
router.post('/brsr/answers/:answerId/consultant/approve-metric-data', eslGate, approveMetricData);

// ── Evidence ──────────────────────────────────────────────────────────────────
router.post('/brsr/answers/:answerId/evidence', eslGate, addEvidence);
router.get('/brsr/answers/:answerId/evidence',  eslGate, listEvidence);
router.patch('/brsr/evidence/:evidenceId',      eslGate, updateEvidence);
router.delete('/brsr/evidence/:evidenceId',     eslGate, deleteEvidence);

// ── Comments listing ──────────────────────────────────────────────────────────
router.get('/brsr/answers/:answerId/comments', eslGate, listComments);

module.exports = router;
