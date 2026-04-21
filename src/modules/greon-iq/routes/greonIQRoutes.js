'use strict';

// ============================================================================
// greonIQRoutes.js — GreOn IQ API route definitions
//
// All routes require JWT authentication (auth middleware applied at the top).
// Role and GreOn IQ access checks are applied per-controller.
//
// BASE PATH: app.use('/api/greon-iq', greonIQRoutes)
// ============================================================================

const express = require('express');
const router  = express.Router();

const { auth }             = require('../../../common/middleware/auth');
const { getProviderStatus }= require('../providers/deepseekProvider');

const queryController     = require('../controllers/queryController');
const historyController   = require('../controllers/historyController');
const quotaController     = require('../controllers/quotaController');
const retentionController = require('../controllers/retentionController');
const reportController    = require('../controllers/reportController');

// ── JWT auth on all routes ─────────────────────────────────────────────────
router.use(auth);

// ── Health check ────────────────────────────────────────────────────────────
router.get('/health', (_req, res) => {
  const status = getProviderStatus();
  return res.status(200).json({
    success:   true,
    module:    'greon-iq',
    provider:  status,
    timestamp: new Date().toISOString(),
  });
});

// ── Query ────────────────────────────────────────────────────────────────────
router.post('/query', queryController.query);

// ── History ──────────────────────────────────────────────────────────────────
router.get('/history',               historyController.list);
router.get('/history/:sessionId',    historyController.getSession);
router.delete('/history/:sessionId', historyController.deleteSession);

// ── Quota ─────────────────────────────────────────────────────────────────────
router.get('/quota',                       quotaController.getQuota);
router.get('/usage',                       quotaController.getUsage);
router.post('/quota/allocate',             quotaController.allocateQuota);
router.get('/quota/user-policy',           quotaController.getUserPolicy);
router.delete('/quota/allocate/:targetUserId', quotaController.revokeAllocation);

// ── Retention ─────────────────────────────────────────────────────────────────
router.get('/retention',   retentionController.getRetention);
router.patch('/retention', retentionController.updateRetention);

// ── Reports & Export ──────────────────────────────────────────────────────────
router.post('/report/preview',        reportController.preview);
router.post('/report/export',         reportController.exportReport);
router.get('/exports/:exportId',      reportController.getExport);
router.post('/chat/export-response',  reportController.exportFromResponse);

module.exports = router;
