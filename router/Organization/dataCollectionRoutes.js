// routes/dataCollectionRoutes.js (UPDATED WITH API KEY PROTECTION)
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { auth, checkRole, checkPermission } = require("../../middleware/auth");
const { apiKeyMiddleware, apiKeyRateLimit } = require('../../middleware/apiKeyAuth');
const {
  saveAPIData,
  saveIoTData,
  saveManualData,
  uploadCSVData,
  editManualData,
  deleteManualData,
  switchInputType,
  getDataEntries,
  getCollectionStatus,
  disconnectSource,
  reconnectSource,
  createMonthlySummaryManual,
  getMonthlySummaries,
  getCurrentCumulative,
  updateInputTypeRealtime,
  getInputTypeStatistics,
  getDataValuesAndCumulative,
  //getSingleDataValueAndCumulative,
  streamDataValuesAndCumulative
} = require('../../controllers/Organization/dataCollectionController');

const {
  getDataCompletionStats,
} = require('../../controllers/DataCollection/dataCompletionController');

const {
  attachDataEntryAccessContext,
} = require('../../utils/Permissions/dataEntryPermission');

const uploadCsv = require('../../utils/uploads/organisation/csv/uploadCsvMulter');
const { uploadOcr } = require('../../utils/uploads/organisation/ocr/upload');
const {
  saveOCRData,
  extractOCRPreview,
  confirmOCRSave,
  verifyOCRData
} = require('../../controllers/Organization/ocrDataCollectionController');

const { getOCRFieldMappings } = require('../../controllers/Organization/ocrFeedbackController');

const { requireActiveModuleSubscription } = require('../../utils/Permissions/modulePermission');

// ── Module subscription gate ──────────────────────────────────────────────
// Shorthand for ZeroCarbon-specific route protection.
const zcGate = requireActiveModuleSubscription('zero_carbon');


// ============== PROTECTED API/IoT ENDPOINTS ==============
// These endpoints REQUIRE API key authentication and come BEFORE router.use(auth)

// ============== PROTECTED API/IoT ENDPOINTS ==============
// ⚠️ UPDATED: API key is now in URL params instead of headers
// These endpoints REQUIRE API key authentication and come BEFORE router.use(auth)

/**
 * DATA COLLECTION API DATA INGESTION
 * POST /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/:apiKey/api-data
 * 
 * ✅ PROTECTED with API Key (type: DC_API)
 * ⚠️ NEW: API key passed in URL as :apiKey parameter
 * 
 * Example:
 * POST /api/data-collection/clients/CLIENT123/nodes/NODE456/scopes/scope1/dcapi_abc123xyz456/api-data
 * Body: { value: 100, date: "2024-12-12", ... }
 */
router.post(
  '/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/:apiKey/api-data',
  apiKeyMiddleware.dataCollectionAPI,   // ✅ API Key Auth (from URL params)
  apiKeyRateLimit(100, 60000),           // Rate limit: 100 req/min
  saveAPIData
);

/**
 * DATA COLLECTION IoT DATA INGESTION
 * POST /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/:apiKey/iot-data
 * 
 * ✅ PROTECTED with API Key (type: DC_IOT)
 * ⚠️ NEW: API key passed in URL as :apiKey parameter
 * 
 * Example:
 * POST /api/data-collection/clients/CLIENT123/nodes/NODE456/scopes/scope1/dciot_abc123xyz456/iot-data
 * Body: { value: 100, timestamp: "2024-12-12T10:00:00Z", ... }
 */
router.post(
  '/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/:apiKey/iot-data',
  apiKeyMiddleware.dataCollectionIoT,   // ✅ API Key Auth (from URL params)
  apiKeyRateLimit(100, 60000),           // Rate limit: 100 req/min
  saveIoTData
);

// ============== AUTHENTICATED ENDPOINTS ==============
// Apply authentication to all remaining routes
router.use(auth);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/temp/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `data-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || path.extname(file.originalname).toLowerCase() === '.csv') {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'), false);
    }
  },
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

// ============== Data Ingestion Routes ==============

/**
 * MANUAL DATA ENTRY
 * POST /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/manual-data
 */
router.post('/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/manual-data', zcGate, saveManualData);

/**
 * CSV UPLOAD FOR MANUAL DATA
 * POST /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/upload-csv
 */
router.post(
  '/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/upload-csv',
    zcGate,
  uploadCsv.single('csvFile'),   // ✅ MEMORY STORAGE
  uploadCSVData
);

/**
 * OCR DOCUMENT UPLOAD — LEGACY one-shot flow
 * POST /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/ocr-data
 * Multipart field name: ocrFile (single)
 * Accepted types: image/jpeg, image/png, image/tiff, application/pdf (max 20MB)
 * Extracts fields and saves DataEntry immediately (no preview step).
 */
router.post(
  '/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/ocr-data',
    zcGate,
  (req, res, next) => { req.setTimeout(120000); next(); },
  uploadOcr.single('ocrFile'),
  saveOCRData
);

/**
 * OCR EXTRACT & PREVIEW — STEP 1 of two-step flow
 * POST /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/ocr-extract
 * Multipart field name: ocrFiles (array, up to 20 images OR 1 PDF)
 * Accepted types: image/jpeg, image/png, image/tiff, application/pdf (max 20MB per file)
 *
 * Returns all extracted fields with model-match suggestions.
 * Does NOT save any DataEntry. Returns an extractionId for Step 2.
 */
router.post(
  '/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/ocr-extract',
  zcGate,
  (req, res, next) => { req.setTimeout(180000); next(); }, // 3 min for multi-file
  uploadOcr.array('ocrFiles', 20),
  extractOCRPreview
);

/**
 * OCR CONFIRM & SAVE — STEP 2 of two-step flow
 * POST /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/ocr-confirm
 * Body: JSON { extractionId?, records: [{ recordIndex, date, time, s3Key,
 *              ocrConfidence, sourceFile, confirmedDataValues, corrections }] }
 *
 * Saves user-confirmed values as DataEntry records and triggers emission calculation.
 * Also stores field-mapping feedback to improve future OCR suggestions.
 */
router.post(
  '/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/ocr-confirm',
  zcGate,
  confirmOCRSave
);

/**
 * OCR VERIFY — Read-only value inspection before saving
 * POST /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/verify-ocr
 * Multipart field name: ocrFile (single image — JPEG, PNG, or TIFF)
 *
 * Runs OCR (Tesseract + AWS Textract fallback), extracts ALL numeric key-value
 * pairs from the image and groups them by type:
 *   • consumptionValues  — kWh / m³ / liters etc.
 *   • monetaryValues     — ₹ bill amounts, charges, payable
 *   • meterReadings      — current / previous meter register numbers
 *   • demandValues       — kW / kVA demand
 *   • otherValues        — everything else numeric
 *
 * Also returns:
 *   • scopeInfo           — which field THIS scope needs and why
 *   • detectedPrimaryValue — best-match value for the primary field (e.g. 815 kWh for Scope 2)
 *   • suggestedDataValues  — ready to pass directly to /ocr-confirm
 *
 * Does NOT write any DataEntry to the database.
 *
 * Example:
 * POST /api/data-collection/clients/Greon001/nodes/node-scope2-electricity-01/scopes/scope2-purchased-electricity-ocr-defra-2/verify-ocr
 * Body: form-data { ocrFile: <image> }
 */
router.post(
  '/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/verify-ocr',
    zcGate,
  (req, res, next) => { req.setTimeout(120000); next(); },
  uploadOcr.single('ocrFile'),
  verifyOCRData
);

/**
 * OCR LEARNED MAPPINGS (admin/debug)
 * GET /api/data-collection/clients/:clientId/ocr-field-mappings?scopeIdentifier=xxx
 * Returns the accumulated field-mapping feedback for a client.
 */
router.get(
  '/clients/:clientId/ocr-field-mappings',
    zcGate,
  getOCRFieldMappings
);


// ============== Data Management Routes ==============

/**
 * EDIT MANUAL DATA ENTRY
 * PUT /api/data-collection/data-entries/:dataId
 */
router.put('/data-entries/:dataId', zcGate, editManualData);

/**
 * DELETE MANUAL DATA ENTRY
 * DELETE /api/data-collection/data-entries/:dataId
 */
router.delete('/data-entries/:dataId', zcGate, deleteManualData);

/**
 * GET DATA ENTRIES (with filtering and pagination)
 * GET /api/data-collection/clients/:clientId/data-entries
 * GET /api/data-collection/clients/:clientId/nodes/:nodeId/data-entries
 * GET /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/data-entries
 *
 * attachDataEntryAccessContext builds the role-based access context ONCE
 * and attaches it to req so that buildDataEntryFilters can apply it without
 * any additional DB queries inside the controller.
 */
router.get('/clients/:clientId/data-entries', zcGate, attachDataEntryAccessContext, getDataEntries);
router.get('/clients/:clientId/nodes/:nodeId/data-entries', zcGate, attachDataEntryAccessContext, getDataEntries);
router.get('/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/data-entries', zcGate, attachDataEntryAccessContext, getDataEntries);

// ============== Configuration Routes ==============

/**
 * SWITCH INPUT TYPE FOR A SCOPE
 * PATCH /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/input-type
 */
router.patch('/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/input-type', zcGate, switchInputType);

/**
 * DISCONNECT API/IoT SOURCE
 * POST /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/disconnect
 */
router.post('/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/disconnect', zcGate, disconnectSource);

/**
 * RECONNECT API/IoT SOURCE
 * POST /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/reconnect
 */
router.post(
  '/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/reconnect',
  zcGate,
  reconnectSource
);

// ============== Monitoring Routes ==============

/**
 * GET COLLECTION STATUS
 * GET /api/data-collection/clients/:clientId/collection-status
 */
router.get('/clients/:clientId/collection-status', zcGate, getCollectionStatus);

/**
 * DATA COMPLETION STATISTICS
 * GET /api/data-collection/clients/:clientId/data-completion
 */
router.get(
  '/clients/:clientId/data-completion',
  zcGate,
  attachDataEntryAccessContext,
  getDataCompletionStats
);

// ============== Monthly Summary Routes ==============

/**
 * CREATE MONTHLY SUMMARY (MANUAL)
 * POST /api/data-collection/summary/:clientId/:nodeId/:scopeIdentifier
 */
router.post(
  '/summary/:clientId/:nodeId/:scopeIdentifier',
  zcGate,
  checkRole('super_admin', 'client_admin'),
  createMonthlySummaryManual
);

/**
 * GET MONTHLY SUMMARIES
 * GET /api/data-collection/summaries/:clientId/:nodeId/:scopeIdentifier
 */
router.get(
  '/summaries/:clientId/:nodeId/:scopeIdentifier',
    zcGate,
  checkRole('super_admin', 'consultant_admin', 'consultant', 'client_admin', 'client_employee_head', 'employee', 'auditor'),
  getMonthlySummaries
);

/**
 * GET CURRENT CUMULATIVE VALUES
 * GET /api/data-collection/cumulative/:clientId/:nodeId/:scopeIdentifier
 */
router.get(
  '/cumulative/:clientId/:nodeId/:scopeIdentifier',
    zcGate,
  checkRole('super_admin', 'consultant_admin', 'consultant', 'client_admin', 'client_employee_head', 'employee', 'auditor'),
  getCurrentCumulative
);

// ============== Public IoT Endpoint (Legacy - consider deprecating) ==============
const iotRouter = express.Router();

/**
 * LEGACY PUBLIC IoT ENDPOINT
 * POST /api/iot/data
 * 
 * ⚠️ DEPRECATED: Use the protected IoT endpoint with API key instead
 * This endpoint is kept for backward compatibility but should be migrated
 */
iotRouter.post('/data', async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier, deviceId, data } = req.body;
    
    if (!clientId || !nodeId || !scopeIdentifier || !deviceId || !data) {
      return res.status(400).json({ 
        message: 'Missing required fields',
        required: ['clientId', 'nodeId', 'scopeIdentifier', 'deviceId', 'data']
      });
    }
    
    req.params = { clientId, nodeId, scopeIdentifier };
    req.body = { ...data, deviceId };
    
    await saveIoTData(req, res);
    
  } catch (error) {
    console.error('IoT data ingestion error:', error);
    res.status(500).json({ 
      message: 'Failed to process IoT data',
      error: error.message 
    });
  }
});

// ============================================================================
// 📊 INPUT TYPE MANAGEMENT ROUTES
// ============================================================================

/**
 * UPDATE INPUT TYPE IN REAL-TIME
 * PATCH /api/data-collection/data-entries/:dataId/input-type
 * 
 * ✅ Updates the inputType of a specific data entry
 * ✅ Broadcasts update via Socket.IO in real-time
 * ✅ Adds to edit history for audit trail
 * 
 * Required Body:
 * {
 *   "newInputType": "manual" | "API" | "IOT",
 *   "reason": "Optional reason for change"
 * }
 * 
 * Example:
 * PATCH /api/data-collection/data-entries/6985f25ac87da39bb65e04ce/input-type
 * Body: { "newInputType": "manual", "reason": "Converting to manual for correction" }
 */
router.patch(
  '/data-entries/:dataId/input-type',
  auth,  // Authentication required
  updateInputTypeRealtime
);


/**
 * GET INPUT TYPE STATISTICS - CLIENT LEVEL
 * GET /api/data-collection/clients/:clientId/input-type-stats
 * 
 * ✅ Returns count of manual, API, and IOT entries for entire client
 * 
 * Query Parameters (Optional):
 * - startDate: ISO date string (e.g., "2024-01-01")
 * - endDate: ISO date string (e.g., "2024-12-31")
 * - includeSummaries: "true" or "false" (default: "false")
 * 
 * Example:
 * GET /api/data-collection/clients/Greon017/input-type-stats
 * GET /api/data-collection/clients/Greon017/input-type-stats?startDate=2024-01-01&endDate=2024-12-31
 */
router.get(
  '/clients/:clientId/input-type-stats',
  auth,
  attachDataEntryAccessContext,
  getInputTypeStatistics
);


/**
 * GET INPUT TYPE STATISTICS - NODE LEVEL
 * GET /api/data-collection/clients/:clientId/nodes/:nodeId/input-type-stats
 * 
 * ✅ Returns count of manual, API, and IOT entries for specific node
 * 
 * Query Parameters (Optional):
 * - startDate: ISO date string
 * - endDate: ISO date string
 * - includeSummaries: "true" or "false"
 * 
 * Example:
 * GET /api/data-collection/clients/Greon017/nodes/greon017-node-cdec7a/input-type-stats
 */
router.get(
  '/clients/:clientId/nodes/:nodeId/input-type-stats',
  auth,
  attachDataEntryAccessContext,
  getInputTypeStatistics
);


/**
 * GET INPUT TYPE STATISTICS - SCOPE LEVEL
 * GET /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/input-type-stats
 * 
 * ✅ Returns count of manual, API, and IOT entries for specific scope
 * ✅ Most granular level of statistics
 * 
 * Query Parameters (Optional):
 * - startDate: ISO date string
 * - endDate: ISO date string
 * - includeSummaries: "true" or "false"
 * 
 * Example:
 * GET /api/data-collection/clients/Greon017/nodes/greon017-node-cdec7a/scopes/COK-SC-DG-FY25/input-type-stats
 */
router.get(
  '/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/input-type-stats',
  auth,
  attachDataEntryAccessContext,
  getInputTypeStatistics
);

// ============================================================================
// MINIMAL DATA ROUTES - Only dataValues & dataEntryCumulative
// ============================================================================

/**
 * @route   GET /api/v1/data/entries/minimal
 * @desc    Get paginated data entries with only dataValues and dataEntryCumulative
 * @access  Private
 * @returns Minimal data entries (75% smaller payload)
 * 
 * Query Parameters:
 * - clientId (string): Filter by client
 * - nodeId (string): Filter by node
 * - scopeIdentifier (string): Filter by scope
 * - startDate (date): Filter entries from this date
 * - endDate (date): Filter entries until this date
 * - inputType (string): Filter by API|IOT|MANUAL|CSV
 * - page (number): Page number (default: 1)
 * - limit (number): Items per page (default: 500, max: 5000)
 * - sortBy (string): Sort field (default: timestamp)
 * - sortOrder (string): asc|desc (default: desc)
 */
router.get('/entries/minimal', auth, attachDataEntryAccessContext, getDataValuesAndCumulative);

// /**
//  * @route   GET /api/v1/data/entries/minimal/:dataId
//  * @desc    Get single data entry with only dataValues and dataEntryCumulative
//  * @access  Private
//  * @returns Single minimal data entry
//  * 
//  * Query Parameters:
//  * - clientId (string): Client ID for authorization check
//  */
// router.get('/entries/minimal/:dataId', auth, getSingleDataValueAndCumulative);

/**
 * @route   GET /api/v1/data/entries/stream
 * @desc    Server-Sent Events stream for real-time data updates
 * @access  Private
 * @returns EventSource stream of minimal data entries
 * 
 * Query Parameters:
 * - clientId (string): Required - Client to stream data for
 * - nodeId (string): Optional - Filter by specific node
 * - scopeIdentifier (string): Optional - Filter by specific scope
 * 
 * Usage Example (Frontend):
 * ```javascript
 * const eventSource = new EventSource(
 *   '/api/v1/data/entries/stream?clientId=CL001&nodeId=NODE123',
 *   { headers: { 'Authorization': `Bearer ${token}` } }
 * );
 * 
 * eventSource.onmessage = (event) => {
 *   const { type, data } = JSON.parse(event.data);
 *   if (type === 'initial') {
 *     // Initial data load
 *     console.log('Initial entries:', data);
 *   } else if (type === 'update') {
 *     // Real-time update
 *     console.log('New/updated entry:', data);
 *   }
 * };
 * ```
 */
router.get('/entries/stream', auth, attachDataEntryAccessContext, streamDataValuesAndCumulative);



// ============== Export ==============
module.exports = {
  dataCollectionRouter: router,
  iotRouter
};