const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { auth, checkRole, checkPermission } = require("../middleware/auth"); // Using the comprehensive auth from middleware folder
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
} = require('../controllers/dataCollectionController');

// Configure multer for CSV uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/temp/'); // Temporary storage
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

// Apply authentication to all routes
router.use(auth);

// ============== Data Ingestion Routes ==============

// API Data Ingestion
// POST /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/api-data
router.post('/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/api-data', saveAPIData);

// IoT Data Ingestion
// POST /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/iot-data
router.post('/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/iot-data', saveIoTData);

// Manual Data Entry
// POST /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/manual-data
router.post('/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/manual-data', saveManualData);

// CSV Upload for Manual Data
// POST /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/upload-csv
router.post(
  '/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/upload-csv',
  upload.single('csvFile'),
  uploadCSVData
);

// ============== Data Management Routes ==============

// Edit Manual Data Entry
// PUT /api/data-collection/data-entries/:dataId
router.put('/data-entries/:dataId', editManualData);

router.delete('/data-entries/:dataId', deleteManualData);

// Get Data Entries (with filtering and pagination)
// GET /api/data-collection/clients/:clientId/data-entries
// GET /api/data-collection/clients/:clientId/nodes/:nodeId/data-entries
// GET /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/data-entries
router.get('/clients/:clientId/data-entries', getDataEntries);
router.get('/clients/:clientId/nodes/:nodeId/data-entries', getDataEntries);
router.get('/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/data-entries', getDataEntries);

// ============== Configuration Routes ==============

// Switch Input Type for a Scope
// PATCH /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/input-type
router.patch('/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/input-type', switchInputType);

// Disconnect API/IoT Source
// POST /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/disconnect
router.post('/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/disconnect', disconnectSource);

// ============== Monitoring Routes ==============

// Get Collection Status
// GET /api/data-collection/clients/:clientId/collection-status
router.get('/clients/:clientId/collection-status', getCollectionStatus);

// ============== Public IoT Endpoint (No Auth) ==============
// This endpoint is for IoT devices that may not support complex authentication
// Security is handled by device ID verification
const iotRouter = express.Router();

// POST /api/iot/data
iotRouter.post('/data', async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier, deviceId, data } = req.body;
    
    // Basic validation
    if (!clientId || !nodeId || !scopeIdentifier || !deviceId || !data) {
      return res.status(400).json({ 
        message: 'Missing required fields',
        required: ['clientId', 'nodeId', 'scopeIdentifier', 'deviceId', 'data']
      });
    }
    
    // Forward to main controller with device authentication
    req.params = { clientId, nodeId, scopeIdentifier };
    req.body = { ...data, deviceId };
    
    // Call the IoT data handler
    await saveIoTData(req, res);
    
  } catch (error) {
    console.error('IoT data ingestion error:', error);
    res.status(500).json({ 
      message: 'Failed to process IoT data',
      error: error.message 
    });
  }
});

router.post(
  '/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/reconnect',
  reconnectSource
);

// Monthly Summary Routes
router.post(
  '/summary/:clientId/:nodeId/:scopeIdentifier',
checkRole('super_admin', 'client_admin'),
  createMonthlySummaryManual
);

router.get(
  '/summaries/:clientId/:nodeId/:scopeIdentifier',
 checkRole('super_admin', 'consultant_admin', 'consultant', 'client_admin', 'client_employee_head', 'employee', 'auditor'),
  getMonthlySummaries
);

// Get Current Cumulative Values
router.get(
  '/cumulative/:clientId/:nodeId/:scopeIdentifier',
  checkRole('super_admin', 'consultant_admin', 'consultant', 'client_admin', 'client_employee_head', 'employee', 'auditor'),
  getCurrentCumulative
);

// ============== Export Routes ==============
module.exports = {
  dataCollectionRouter: router,
  iotRouter
};