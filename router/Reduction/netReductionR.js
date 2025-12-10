// routes/Reduction/netReductionR.js (UPDATED WITH API KEY PROTECTION)
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
  switchNetReductionInputType
} = require('../../controllers/Reduction/netReductionController');

const {
  getNetReductionCompletionStats
} = require('../../controllers/DataCollection/dataCompletionController');

// ============== PROTECTED API/IoT ENDPOINTS ==============
// These endpoints REQUIRE API key authentication

/**
 * NET REDUCTION API DATA INGESTION
 * POST /api/net-reduction/:clientId/:projectId/:calculationMethodology/api
 * 
 * ✅ PROTECTED with API Key (type: NET_API)
 * Headers: X-API-Key: <your-api-key>
 */
router.post(
  '/:clientId/:projectId/:calculationMethodology/api',
  apiKeyMiddleware.netReductionAPI,     // ✅ API Key Auth
  apiKeyRateLimit(100, 60000),           // Rate limit: 100 req/min
  saveApiNetReduction
);

/**
 * NET REDUCTION IoT DATA INGESTION
 * POST /api/net-reduction/:clientId/:projectId/:calculationMethodology/iot
 * 
 * ✅ PROTECTED with API Key (type: NET_IOT)
 * Headers: X-API-Key: <your-api-key>
 */
router.post(
  '/:clientId/:projectId/:calculationMethodology/iot',
  apiKeyMiddleware.netReductionIoT,     // ✅ API Key Auth
  apiKeyRateLimit(100, 60000),           // Rate limit: 100 req/min
  saveIotNetReduction
);

// ============== AUTHENTICATED ENDPOINTS ==============
// These endpoints require standard user authentication

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

/**
 * GET NET REDUCTION STATISTICS
 * GET /api/net-reduction/:clientId/:projectId/:calculationMethodology/stats
 */
router.get('/:clientId/:projectId/:calculationMethodology/stats', getNetReductionStats);

/**
 * NET REDUCTION DATA COMPLETION STATS
 * GET /api/net-reduction/:clientId/data-completion
 */
router.get('/:clientId/data-completion', getNetReductionCompletionStats);

/**
 * LIST NET REDUCTIONS
 * GET /api/net-reduction
 */
router.get('/', listNetReductions);

/**
 * UPDATE MANUAL NET REDUCTION ENTRY
 * PATCH /api/net-reduction/:clientId/:projectId/:calculationMethodology/manual/:entryId
 */
router.patch(
  '/:clientId/:projectId/:calculationMethodology/manual/:entryId',
  updateManualNetReductionEntry
);

/**
 * DELETE MANUAL NET REDUCTION ENTRY
 * DELETE /api/net-reduction/:clientId/:projectId/:calculationMethodology/manual/:entryId
 */
router.delete(
  '/:clientId/:projectId/:calculationMethodology/manual/:entryId',
  deleteManualNetReductionEntry
);

/**
 * SWITCH INPUT TYPE
 * PATCH /api/net-reduction/:clientId/:projectId/input-type
 */
router.patch(
  '/:clientId/:projectId/input-type',
  auth,
  switchNetReductionInputType
);

/**
 * DISCONNECT EXTERNAL SOURCE (API/IoT)
 * PATCH /api/net-reduction/:clientId/:projectId/disconnect
 */
router.patch(
  '/:clientId/:projectId/disconnect',
  auth,
  disconnectNetReductionSource
);

/**
 * RECONNECT EXTERNAL SOURCE (API/IoT)
 * PATCH /api/net-reduction/:clientId/:projectId/reconnect
 */
router.patch(
  '/:clientId/:projectId/reconnect',
  auth,
  reconnectNetReductionSource
);

module.exports = router;