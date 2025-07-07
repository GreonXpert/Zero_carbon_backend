const express = require('express');
const router = express.Router();
const epaController = require('../../controllers/EmissionFactor/EPADataController');
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


// Create a new EPA data record
router.post(
  '/epa-data',
  checkRole(...editRoles),
  epaController.createEPAData
);

// Get all EPA data with pagination and basic filters
router.get(
  '/epa-data',
  checkRole(...viewRoles),
  epaController.getEPAData
);

// Advanced filtering endpoint
router.get(
  '/epa-data/filter',
  checkRole(...viewRoles),
  epaController.filterEPAData
);

// Download all EPA data as CSV
router.get(
  '/epa-data/download/csv',
  checkRole(...viewRoles),
  epaController.downloadEPADataCSV
);

// Get single EPA data by ID
router.get(
  '/epa-data/:id',
  checkRole(...viewRoles),
  epaController.getEPADataById
);

// Update EPA data by ID
router.patch(
  '/epa-data/:id',
  checkRole(...editRoles),
  epaController.updateEPAData
);

// Delete EPA data by ID
router.delete(
  '/epa-data/:id',
  checkRole(...editRoles),
  epaController.deleteEPAData
);

// Delete multiple EPA data records
router.post(
  '/epa-data/delete/bulk',
  checkRole(...editRoles),
  epaController.deleteEPAData
);

// Upload EPA data from CSV file
router.post(
  '/epa-data/upload',
  checkRole(...editRoles),
  upload.single('file'),
  epaController.uploadEPADataFromCSV
);


module.exports = router;