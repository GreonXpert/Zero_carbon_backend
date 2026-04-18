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

// Review queue (before /:clientId/submissions)
router.get('/:clientId/review-queue',   ...gateWithCtx, reviewerCtrl.getReviewQueue);
router.get('/:clientId/approval-queue', ...gateWithCtx, approverCtrl.getApprovalQueue);

// ESG API key management
const esgApiKeyCtrl = require('../api-key/controllers/esgApiKeyController');
router.post('/:clientId/esg-api-keys',              ...gate, esgApiKeyCtrl.createKey);
router.get('/:clientId/esg-api-keys',               ...gate, esgApiKeyCtrl.listKeys);
router.get('/:clientId/esg-api-keys/:keyId',        ...gate, esgApiKeyCtrl.getKeyDetails);
router.post('/:clientId/esg-api-keys/:keyId/renew', ...gate, esgApiKeyCtrl.renewKey);
router.delete('/:clientId/esg-api-keys/:keyId',     ...gate, esgApiKeyCtrl.revokeKey);

// Import routes (nodeId + mappingId in URL, NOT in file)
router.post(
  '/:clientId/nodes/:nodeId/mappings/:mappingId/import/csv',
  ...gate,
  upload.single('file'),
  importCtrl.importCsv
);
router.post(
  '/:clientId/nodes/:nodeId/mappings/:mappingId/import/excel',
  ...gate,
  upload.single('file'),
  importCtrl.importExcel
);

// Submission CRUD
router.post('/:clientId/submissions',   ...gateWithCtx, submissionCtrl.createSubmission);
router.get('/:clientId/submissions',    ...gateWithCtx, submissionCtrl.listSubmissions);

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

// OCR
router.post(
  '/:clientId/submissions/:submissionId/ocr-extract',
  ...gate,
  upload.single('file'),
  importCtrl.ocrExtract
);
router.post('/:clientId/submissions/:submissionId/ocr-confirm', ...gate, importCtrl.ocrConfirm);

// Thread routes
router.get('/:clientId/submissions/:submissionId/thread',         ...gateWithCtx, threadCtrl.getThread);
router.post('/:clientId/submissions/:submissionId/thread/comment', ...gateWithCtx, threadCtrl.addComment);
router.post('/:clientId/submissions/:submissionId/thread/reply',   ...gateWithCtx, threadCtrl.reply);

// Submission get / patch / delete
router.get('/:clientId/submissions/:submissionId',    ...gateWithCtx, submissionCtrl.getSubmission);
router.patch('/:clientId/submissions/:submissionId',  ...gateWithCtx, submissionCtrl.updateDraft);
router.delete('/:clientId/submissions/:submissionId', ...gateWithCtx, submissionCtrl.deleteDraft);

module.exports = router;
