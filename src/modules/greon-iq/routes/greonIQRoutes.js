'use strict';

// ============================================================================
// greonIQRoutes.js — GreOn IQ API route definitions
//
// All routes require JWT authentication (auth middleware applied at the top).
// greonIQAccessGate blocks roles that have no access to GreOn IQ at all.
//
// BASE PATH: app.use('/api/greon-iq', greonIQRoutes)
// ============================================================================

const express    = require('express');
const rateLimit  = require('express-rate-limit');
const router     = express.Router();

// 20 queries per minute per user — burst throttle independent of the quota system
const greonIQQueryLimiter = rateLimit({
  windowMs:        60_000,
  max:             20,
  keyGenerator:    (req) => String(req.user?._id || 'anonymous'),
  standardHeaders: true,
  legacyHeaders:   false,
  validate:        { ip: false },   // key is userId, not IP — suppress IPv6 validation
  message: {
    success: false,
    code:    'RATE_LIMIT_EXCEEDED',
    message: 'Too many requests. Please wait a moment before asking again.',
  },
});

const { auth }             = require('../../../common/middleware/auth');
const greonIQAccessGate    = require('../middleware/greonIQAccessGate');
const { getProviderStatus }= require('../providers/deepseekProvider');

const queryController     = require('../controllers/queryController');
const historyController   = require('../controllers/historyController');
const quotaController     = require('../controllers/quotaController');
const retentionController = require('../controllers/retentionController');
const reportController    = require('../controllers/reportController');
const analyticsController = require('../controllers/analyticsController');

// ── JWT auth on all routes ─────────────────────────────────────────────────
router.use(auth);

// ── Role gate — blocks employee / contributor / reviewer / approver / support
router.use(greonIQAccessGate);

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

// ── Allowed clients (for dynamic client selection) ───────────────────────────
router.get('/allowed-clients', quotaController.getAllowedClients);

// ── Query ────────────────────────────────────────────────────────────────────
router.post('/query', greonIQQueryLimiter, queryController.query);

// ── History ──────────────────────────────────────────────────────────────────
router.get('/history',               historyController.list);
router.get('/history/:sessionId',    historyController.getSession);
router.delete('/history/:sessionId', historyController.deleteSession);
router.patch('/history/:sessionId/pin', historyController.togglePin);

// ── Message feedback ──────────────────────────────────────────────────────────
router.post('/messages/:messageId/feedback', historyController.messageFeedback);

// ── Analytics ─────────────────────────────────────────────────────────────────
router.get('/analytics',                  analyticsController.getSummary);
router.get('/analytics/top-questions',    analyticsController.getTopQuestions);
router.get('/analytics/liked-messages',   analyticsController.getLikedMessages);
router.get('/analytics/pinned-sessions',  analyticsController.getPinnedSessions);

// ── Quota / credit wallet ─────────────────────────────────────────────────────
router.get('/quota',                           quotaController.getQuota);
router.get('/usage',                           quotaController.getUsage);
router.get('/quota/transactions',              quotaController.getTransactions);
router.post('/quota/adjust',                   quotaController.adjustCredits);
router.get('/quota/:userId',                   quotaController.getWalletByUser);
// Legacy stubs (deprecated — return 410)
router.post('/quota/allocate',                 quotaController.allocateQuota);
router.get('/quota/user-policy',               quotaController.getUserPolicy);
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
