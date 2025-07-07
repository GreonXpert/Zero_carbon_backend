// routes/ipccDataRoutes.js
const express = require('express');
const router = express.Router();
const ipccDataController = require('../../controllers/EmissionFactor/ipccDataController');
const { auth, checkRole } = require('../../middleware/auth');
const multer = require('multer');

// Configure multer for file uploads
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

// Apply authentication to all routes
router.use(auth);

// Define roles that can view data
const viewRoles = ['consultant', 'consultant_admin', 'super_admin'];
const editRoles = ['consultant_admin', 'super_admin'];

// Create a new IPCC data record
router.post(
  '/ipcc-data',
  checkRole(...editRoles),
  ipccDataController.addIPCCData
);

// Get all IPCC data with pagination and basic filters
router.get(
  '/ipcc-data',
  checkRole(...viewRoles),
  ipccDataController.getAllIPCCData
);

// Advanced filtering endpoint
router.get(
  '/ipcc-data/filter',
  checkRole(...viewRoles),
  ipccDataController.filterIPCCData
);

// Download all IPCC data as CSV
router.get(
  '/ipcc-data/download',
  checkRole(...viewRoles),
  ipccDataController.downloadIPCCDataCSV
);



// Get single IPCC data by ID
router.get(
  '/ipcc-data/:id',
  checkRole(...viewRoles),
  ipccDataController.getIPCCDataById
);

// Get update history for specific IPCC data
router.get(
  '/ipcc-data/:id/history',
  checkRole(...viewRoles),
  ipccDataController.getIPCCDataHistory
);

// Update IPCC data by ID
router.patch(
  '/ipcc-data/:id',
  checkRole(...editRoles),
  ipccDataController.updateIPCCData
);

// Delete single IPCC data by ID
router.delete(
  '/ipcc-data/:id',
  checkRole(...editRoles),
  ipccDataController.deleteIPCCData
);

// Delete multiple IPCC data records
router.delete(
    '/ipcc-data/delete/bulk',
    checkRole(...editRoles),
    ipccDataController.deleteIPCCData
)


// Unified bulk upload for CSV and Excel
router.post(
  '/ipcc-data/bulk-upload',
  checkRole(...editRoles),
  upload.single('file'),
  ipccDataController.bulkUploadIPCCData
);



// Test endpoint for debugging
router.get(
  '/ipcc-data/test',
  checkRole(...viewRoles),
  ipccDataController.testIPCCData
);

module.exports = router;