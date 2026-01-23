const express = require('express');
const router = express.Router();
const defraController = require('../../controllers/EmissionFactor/DefraDataController');
const { auth, checkRole } = require('../../middleware/auth');
const multer = require('multer');
const path = require('path');


// Configure multer for file uploads
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(process.cwd(), 'uploads')),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
  }),
  limits: {
    fileSize: 250 * 1024 * 1024 // 250MB (adjust as needed)
  }
});

// Apply authentication to all routes
router.use(auth);

// Define roles that can view data
const viewRoles = ['consultant', 'consultant_admin', 'super_admin'];
const editRoles = ['consultant_admin', 'super_admin'];

// Create a new DEFRA data record
router.post(
  '/defra-data',
  checkRole(...editRoles),
  defraController.createDefraData
);

// Get all DEFRA data with pagination and basic filters
router.get(
  '/defra-data',
  checkRole(...viewRoles),
  defraController.getDefraData
);

// Advanced filtering endpoint
router.get(
  '/defra-data/filter',
  checkRole(...viewRoles),
  defraController.filterDefraData
);

// Download all DEFRA data as CSV
router.get(
  '/defra-data/download/csv',
  checkRole(...viewRoles),
  defraController.downloadDefraDataCSV
);

// Get single DEFRA data by ID
router.get(
  '/defra-data/:id',
  checkRole(...viewRoles),
  defraController.getDefraDataById
);

// Update DEFRA data by ID
router.patch(
  '/defra-data/:id',
  checkRole(...editRoles),
  defraController.updateDefraData
);

// Delete single DEFRA data by ID
router.delete(
  '/defra-data/:id',
  checkRole(...editRoles),
  defraController.deleteDefraData
);

// Delete multiple DEFRA data records
router.post(
  '/defra-data/delete/bulk',
  checkRole(...editRoles),
  defraController.deleteDefraData
);

// Unified bulk upload for CSV and Excel
router.post(
  '/defra-data/bulk-upload',
  checkRole(...editRoles),
  upload.single('file'),
  defraController.bulkUpload
);

// Test endpoint for debugging
router.get(
  '/defra-data/test',
  checkRole(...viewRoles),
  defraController.testDefraData
);

module.exports = router;