'use strict';

const express  = require('express');
const multer   = require('multer');
const router   = express.Router();

const { auth }                           = require('../../../../../common/middleware/auth');
const { requireActiveModuleSubscription } = require('../../../../../common/utils/Permissions/modulePermission');
const { attachSubmissionAccessContext }   = require('../middleware/submissionAccessContext');

const submissionCtrl = require('../controllers/submissionController');
const reviewerCtrl   = require('../controllers/reviewerController');
const approverCtrl   = require('../controllers/approverController');
const threadCtrl     = require('../controllers/threadController');
const importCtrl     = require('../controllers/importController');
const completionCtrl = require('../controllers/completionController');
const myTaskCtrl     = require('../controllers/myTaskController');
const escalationCtrl = require('../controllers/escalationController');

// ── Multer setup (memory storage — files sent to S3 / Textract) ───────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Common middleware for all routes ──────────────────────────────────────────
const gate = [auth, requireActiveModuleSubscription('esg_link')];
const gateWithCtx = [...gate, attachSubmissionAccessContext];

// ─── Literal routes (must be registered BEFORE parameterized routes) ──────────

// Notification preferences (no clientId — user-scoped)
router.get('/me/esg-notification-preferences',  ...gate, require('../controllers/notificationPrefController').getPreferences);
router.put('/me/esg-notification-preferences',  ...gate, require('../controllers/notificationPrefController').updatePreferences);

// ─── Client-scoped routes ─────────────────────────────────────────────────────

// Completion + dashboard (before :clientId/submissions to avoid Express param collision)
router.get('/:clientId/completion', ...gateWithCtx, completionCtrl.getCompletionStats);
router.get('/:clientId/approved',   ...gateWithCtx, completionCtrl.getApprovedData);
router.get('/:clientId/workflow-actions/:submissionId', ...gateWithCtx, completionCtrl.getWorkflowActions);

// My-task metrics — enriched card data for contributor / reviewer / approver
router.get('/:clientId/my-task-metrics', ...gateWithCtx, myTaskCtrl.getMyTaskMetrics);

// Per-mapping stats for MetricDetailPage
router.get('/:clientId/mappings/:mappingId/stats', ...gateWithCtx, myTaskCtrl.getMetricStats);

// Review queue (before /:clientId/submissions)
router.get('/:clientId/review-queue',   ...gateWithCtx, reviewerCtrl.getReviewQueue);
router.get('/:clientId/approval-queue', ...gateWithCtx, approverCtrl.getApprovalQueue);

// SLA escalation queue + manual trigger (before /:clientId/submissions)
router.get('/:clientId/escalations',            ...gateWithCtx, escalationCtrl.getEscalationQueue);
router.post('/:clientId/escalations/run-check', ...gateWithCtx, escalationCtrl.runEscalationCheck);

// ESG API key management
const esgApiKeyCtrl = require('../api-key/controllers/esgApiKeyController');
router.post('/:clientId/esg-api-keys',                        ...gate, esgApiKeyCtrl.createKey);
router.get('/:clientId/esg-api-keys',                         ...gate, esgApiKeyCtrl.listKeys);
router.get('/:clientId/esg-api-keys/:keyId',                  ...gate, esgApiKeyCtrl.getKeyDetails);
router.post('/:clientId/esg-api-keys/:keyId/renew',           ...gate, esgApiKeyCtrl.renewKey);
router.delete('/:clientId/esg-api-keys/:keyId',               ...gate, esgApiKeyCtrl.revokeKey);
// Connection toggle — pause / resume data ingestion without revoking the key
router.patch('/:clientId/esg-api-keys/:keyId/connect',        ...gate, esgApiKeyCtrl.connectKey);
router.patch('/:clientId/esg-api-keys/:keyId/disconnect',     ...gate, esgApiKeyCtrl.disconnectKey);

// Import routes (nodeId + mappingId in URL, NOT in file)

// Step 1 — parse & preview (read-only, no submissions created)
router.post(
  '/:clientId/nodes/:nodeId/mappings/:mappingId/import/preview',
  ...gate,
  (req, res, next) => { req.setTimeout(900000); next(); },
  upload.single('file'),
  importCtrl.importPreview
);

// Step 2 — import with user-confirmed column mapping
router.post(
  '/:clientId/nodes/:nodeId/mappings/:mappingId/import/mapped',
  ...gate,
  (req, res, next) => { req.setTimeout(900000); next(); },
  upload.single('file'),
  importCtrl.importMapped
);

// Direct imports (file already matches template format)
router.post(
  '/:clientId/nodes/:nodeId/mappings/:mappingId/import/csv',
  ...gate,
  (req, res, next) => { req.setTimeout(900000); next(); },
  upload.single('file'),
  importCtrl.importCsv
);
router.post(
  '/:clientId/nodes/:nodeId/mappings/:mappingId/import/excel',
  ...gate,
  (req, res, next) => { req.setTimeout(900000); next(); },
  upload.single('file'),
  importCtrl.importExcel
);

// Import job progress polling
router.get(
  '/import/progress/:jobId',
  ...gate,
  importCtrl.getImportProgress
);

// Submission CRUD
router.post('/:clientId/submissions',             ...gateWithCtx, submissionCtrl.createSubmission);
router.get('/:clientId/submissions',              ...gateWithCtx, submissionCtrl.listSubmissions);

// ── Batch endpoints — MUST be registered before /:submissionId routes ─────────
// Create multiple draft submissions in one request
router.post('/:clientId/submissions/batch',        ...gateWithCtx, submissionCtrl.createBatchSubmissions);
// Submit multiple drafts for review in one request
router.post('/:clientId/submissions/batch-submit', ...gateWithCtx, submissionCtrl.batchSubmitForReview);

// Submission actions (specific paths BEFORE /:submissionId generic)
router.post('/:clientId/submissions/:submissionId/submit',       ...gateWithCtx, submissionCtrl.submitForReview);
router.post('/:clientId/submissions/:submissionId/resubmit',     ...gateWithCtx, submissionCtrl.resubmit);
router.post('/:clientId/submissions/:submissionId/clarify',      ...gateWithCtx, reviewerCtrl.requestClarification);
router.post('/:clientId/submissions/:submissionId/review-pass',  ...gateWithCtx, reviewerCtrl.reviewPass);
router.post('/:clientId/submissions/:submissionId/approve',      ...gateWithCtx, approverCtrl.approve);
router.post('/:clientId/submissions/:submissionId/reject',       ...gateWithCtx, approverCtrl.reject);

// Evidence upload (S3 file)
router.post(
  '/:clientId/submissions/:submissionId/evidence',
  ...gate,
  upload.single('file'),
  submissionCtrl.uploadEvidence
);

// Evidence URL (paste a Drive / OneDrive / SharePoint link)
router.post(
  '/:clientId/submissions/:submissionId/evidence/url',
  ...gate,
  submissionCtrl.addEvidenceUrl
);

// OCR — standalone scan (no submissionId needed — extract values before creating submission)
router.post(
  '/:clientId/ocr-scan',
  ...gate,
  upload.single('file'),
  importCtrl.ocrScan
);

// OCR — submission-scoped extract + confirm (legacy path, kept for compatibility)
router.post(
  '/:clientId/submissions/:submissionId/ocr-extract',
  ...gate,
  upload.single('file'),
  importCtrl.ocrExtract
);
router.post('/:clientId/submissions/:submissionId/ocr-confirm', ...gate, importCtrl.ocrConfirm);

// Thread routes
router.get('/:clientId/submissions/:submissionId/thread',          ...gateWithCtx, threadCtrl.getThread);
router.post('/:clientId/submissions/:submissionId/thread/comment', ...gateWithCtx, threadCtrl.addComment);
router.post('/:clientId/submissions/:submissionId/thread/reply',   ...gateWithCtx, threadCtrl.reply);
router.patch('/:clientId/submissions/:submissionId/thread/read',   ...gate,        threadCtrl.markThreadRead);

// Bulk operations
router.post('/:clientId/submissions/batch-delete', ...gateWithCtx, submissionCtrl.batchDeleteDrafts);

// Submission get / patch / delete
router.get('/:clientId/submissions/:submissionId',    ...gateWithCtx, submissionCtrl.getSubmission);
router.patch('/:clientId/submissions/:submissionId',  ...gateWithCtx, submissionCtrl.updateDraft);
router.delete('/:clientId/submissions/:submissionId', ...gateWithCtx, submissionCtrl.deleteDraft);

module.exports = router;
