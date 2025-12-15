// routes/Reduction/netReductionR.js (UPDATED - API Key in URL Params)
const express = require('express');
const router = express.Router();
const { auth } = require('../../middleware/auth');
const { apiKeyMiddleware, apiKeyRateLimit } = require('../../middleware/apiKeyAuth');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });

const {
  saveManualNetReduction,
  saveApiNetReduction,
  saveIotNetReduction,
  uploadCsvNetReduction,
  getNetReductionStats,
  listNetReductions,
  deleteManualNetReductionEntry,
  updateManualNetReductionEntry,
  disconnectNetReductionSource,
  reconnectNetReductionSource,
  switchNetReductionInputType,
  getNetReduction
} = require('../../controllers/Reduction/netReductionController');

const {
  getNetReductionCompletionStats
} = require('../../controllers/DataCollection/dataCompletionController');

// ============== PROTECTED API/IoT ENDPOINTS ==============
// ⚠️ UPDATED: API key is now in URL params instead of headers
// These endpoints REQUIRE API key authentication

/**
 * NET REDUCTION API DATA INGESTION
 * POST /api/net-reduction/:clientId/:projectId/:calculationMethodology/:apiKey/api
 * 
 * ✅ PROTECTED with API Key (type: NET_API)
 * ⚠️ NEW: API key passed in URL as :apiKey parameter
 * 
 * Example:
 * POST /api/net-reduction/CLIENT123/PROJECT456/method1/nrapi_abc123xyz456/api
 * Body: { value: 100, date: "2024-12-12", ... }
 */
router.post(
  '/:clientId/:projectId/:calculationMethodology/:apiKey/api',
  apiKeyMiddleware.netReductionAPI,     // ✅ API Key Auth (from URL params)
  apiKeyRateLimit(100, 60000),           // Rate limit: 100 req/min
  saveApiNetReduction
);

/**
 * NET REDUCTION IoT DATA INGESTION
 * POST /api/net-reduction/:clientId/:projectId/:calculationMethodology/:apiKey/iot
 * 
 * ✅ PROTECTED with API Key (type: NET_IOT)
 * ⚠️ NEW: API key passed in URL as :apiKey parameter
 * 
 * Example:
 * POST /api/net-reduction/CLIENT123/PROJECT456/method1/nriot_abc123xyz456/iot
 * Body: { value: 100, timestamp: "2024-12-12T10:00:00Z", ... }
 */
router.post(
  '/:clientId/:projectId/:calculationMethodology/:apiKey/iot',
  apiKeyMiddleware.netReductionIoT,     // ✅ API Key Auth (from URL params)
  apiKeyRateLimit(100, 60000),           // Rate limit: 100 req/min
  saveIotNetReduction
);

// ============== AUTHENTICATED ENDPOINTS ==============
// These endpoints require standard user authentication (JWT tokens)

router.use(auth);

/**
 * MANUAL NET REDUCTION DATA ENTRY
 * POST /api/net-reduction/:clientId/:projectId/:calculationMethodology/manual
 * Requires: Standard auth (consultant, client users)
 */
router.post('/:clientId/:projectId/:calculationMethodology/manual', saveManualNetReduction);

/**
 * CSV UPLOAD FOR NET REDUCTION
 * POST /api/net-reduction/:clientId/:projectId/:calculationMethodology/csv
 */
router.post('/:clientId/:projectId/:calculationMethodology/csv', upload.single('file'), uploadCsvNetReduction);



router.get('/', getNetReduction);
/**
 * GET NET REDUCTION STATISTICS
 * GET /api/net-reduction/:clientId/:projectId/:calculationMethodology/stats
 */
router.get('/:clientId/:projectId/:calculationMethodology/stats', getNetReductionStats);

/**
 * NET REDUCTION DATA COMPLETION STATS
 * GET /api/net-reduction/:clientId/:projectId/:calculationMethodology/completion-stats
 */
router.get('/:clientId/:projectId/:calculationMethodology/completion-stats', getNetReductionCompletionStats);

/**
 * LIST NET REDUCTION ENTRIES
 * GET /api/net-reduction/:clientId/:projectId/:calculationMethodology/list
 */
router.get('/:clientId/:projectId/:calculationMethodology/list', listNetReductions);

/**
 * DELETE MANUAL NET REDUCTION ENTRY
 * DELETE /api/net-reduction/:clientId/:projectId/:calculationMethodology/:entryId
 */
router.delete('/:clientId/:projectId/:calculationMethodology/:entryId', deleteManualNetReductionEntry);

/**
 * UPDATE MANUAL NET REDUCTION ENTRY
 * PUT /api/net-reduction/:clientId/:projectId/:calculationMethodology/:entryId
 */
router.put('/:clientId/:projectId/:calculationMethodology/:entryId', updateManualNetReductionEntry);

/**
 * DISCONNECT NET REDUCTION SOURCE
 * POST /api/net-reduction/:clientId/:projectId/:calculationMethodology/disconnect
 */
router.post('/:clientId/:projectId/:calculationMethodology/disconnect', disconnectNetReductionSource);

/**
 * RECONNECT NET REDUCTION SOURCE
 * POST /api/net-reduction/:clientId/:projectId/:calculationMethodology/reconnect
 */
router.post('/:clientId/:projectId/:calculationMethodology/reconnect', reconnectNetReductionSource);

/**
 * SWITCH NET REDUCTION INPUT TYPE
 * POST /api/net-reduction/:clientId/:projectId/:calculationMethodology/switch
 */
router.post('/:clientId/:projectId/:calculationMethodology/switch', switchNetReductionInputType);

module.exports = router;