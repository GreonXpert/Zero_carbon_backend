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
  getCurrentCumulative
} = require('../../controllers/Organization/dataCollectionController');

const {
  getDataCompletionStats,
} = require('../../controllers/DataCollection/dataCompletionController');

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

// Configure multer for CSV uploads
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
    fileSize: 50 * 1024 * 1024 // 50MB limit
  }
});

// ============== Data Ingestion Routes ==============

/**
 * MANUAL DATA ENTRY
 * POST /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/manual-data
 */
router.post('/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/manual-data', saveManualData);

/**
 * CSV UPLOAD FOR MANUAL DATA
 * POST /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/upload-csv
 */
router.post(
  '/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/upload-csv',
  upload.single('csvFile'),
  uploadCSVData
);

// ============== Data Management Routes ==============

/**
 * EDIT MANUAL DATA ENTRY
 * PUT /api/data-collection/data-entries/:dataId
 */
router.put('/data-entries/:dataId', editManualData);

/**
 * DELETE MANUAL DATA ENTRY
 * DELETE /api/data-collection/data-entries/:dataId
 */
router.delete('/data-entries/:dataId', deleteManualData);

/**
 * GET DATA ENTRIES (with filtering and pagination)
 * GET /api/data-collection/clients/:clientId/data-entries
 * GET /api/data-collection/clients/:clientId/nodes/:nodeId/data-entries
 * GET /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/data-entries
 */
router.get('/clients/:clientId/data-entries', getDataEntries);
router.get('/clients/:clientId/nodes/:nodeId/data-entries', getDataEntries);
router.get('/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/data-entries', getDataEntries);

// ============== Configuration Routes ==============

/**
 * SWITCH INPUT TYPE FOR A SCOPE
 * PATCH /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/input-type
 */
router.patch('/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/input-type', switchInputType);

/**
 * DISCONNECT API/IoT SOURCE
 * POST /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/disconnect
 */
router.post('/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/disconnect', disconnectSource);

/**
 * RECONNECT API/IoT SOURCE
 * POST /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/reconnect
 */
router.post(
  '/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/reconnect',
  reconnectSource
);

// ============== Monitoring Routes ==============

/**
 * GET COLLECTION STATUS
 * GET /api/data-collection/clients/:clientId/collection-status
 */
router.get('/clients/:clientId/collection-status', getCollectionStatus);

/**
 * DATA COMPLETION STATISTICS
 * GET /api/data-collection/clients/:clientId/data-completion
 */
router.get(
  '/clients/:clientId/data-completion',
  auth,
  getDataCompletionStats
);

// ============== Monthly Summary Routes ==============

/**
 * CREATE MONTHLY SUMMARY (MANUAL)
 * POST /api/data-collection/summary/:clientId/:nodeId/:scopeIdentifier
 */
router.post(
  '/summary/:clientId/:nodeId/:scopeIdentifier',
  checkRole('super_admin', 'client_admin'),
  createMonthlySummaryManual
);

/**
 * GET MONTHLY SUMMARIES
 * GET /api/data-collection/summaries/:clientId/:nodeId/:scopeIdentifier
 */
router.get(
  '/summaries/:clientId/:nodeId/:scopeIdentifier',
  checkRole('super_admin', 'consultant_admin', 'consultant', 'client_admin', 'client_employee_head', 'employee', 'auditor'),
  getMonthlySummaries
);

/**
 * GET CURRENT CUMULATIVE VALUES
 * GET /api/data-collection/cumulative/:clientId/:nodeId/:scopeIdentifier
 */
router.get(
  '/cumulative/:clientId/:nodeId/:scopeIdentifier',
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

// ============== Export ==============
module.exports = {
  dataCollectionRouter: router,
  iotRouter
};