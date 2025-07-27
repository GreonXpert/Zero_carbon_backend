const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const EmissionFactorHubController = require('../../controllers/EmissionFactor/EmissionFactorHubController');
const {auth,checkRole} = require ('../../middleware/auth');

// Configure multer for CSV file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/csv/'); // Make sure this directory exists
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'scope3-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const m = file.mimetype;
    if (
      ext === '.csv' ||
      m === 'text/csv' || 
      m === 'application/vnd.ms-excel' ||
      m === 'application/csv'
    ){
      cb(null, true); 
    }else{
      cb(new Error('Only CSV files are allowed'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// Apply authentication to all routes
router.use(auth)

// Define roles that can view data 
const viewRoles = ['consultant','consultant_admin','super_admin',]
const editRoles = ['consultant_admin','super_admin']

// Routes for Scope 3 Emission Factors

// POST /api/scope3-emission-factors/add - Add new Scope 3 emission factor
router.post('/add', checkRole(...editRoles),EmissionFactorHubController.addEmissionFactorHub);

// GET /api/scope3-emission-factors/all - Get all Scope 3 emission factors
router.get('/all',checkRole(...viewRoles), EmissionFactorHubController.getAllEmissionFactorsHub);

// GET /api/scope3-emission-factors/categories - Get unique categories (with query parameter support)
router.get('/keys',checkRole(...viewRoles), EmissionFactorHubController.getUniqueFieldValues);

// GET /api/scope3-emission-factors/filter - Filter/Search Scope 3 emission factors
router.get('/filter',checkRole(...viewRoles), EmissionFactorHubController.filterEmissionFactorsHub);



// GET /api/scope3-emission-factors/items - Get items by category and activity
router.get('/items',checkRole(...viewRoles), EmissionFactorHubController.getItemsByCategoryAndActivity);



// GET /api/scope3-emission-factors/activities/:category - Get activities by category
router.get('/activities/:category',checkRole(...viewRoles), EmissionFactorHubController.getActivitiesByCategory);

// GET /api/scope3-emission-factors/csv-template - Download CSV template
router.get('/csv-template',checkRole(...editRoles), EmissionFactorHubController.downloadCSVTemplate);

// POST /api/scope3-emission-factors/bulk-import - Bulk import emission factors (CSV upload or manual data)
router.post('/bulk-import', upload.single('csvFile'),checkRole(...editRoles), EmissionFactorHubController.bulkImportEmissionFactorsHub);

// GET /api/scope3-emission-factors/:id - Get Scope 3 emission factor by ID
router.get('/:id', checkRole(...viewRoles),EmissionFactorHubController.getEmissionFactorHubById);

// PUT /api/scope3-emission-factors/update/:id - Update Scope 3 emission factor by ID
router.put('/update/:id',checkRole(...editRoles), EmissionFactorHubController.updateEmissionFactorHub);

// DELETE /api/scope3-emission-factors/delete/:id - Delete Scope 3 emission factor by ID
router.delete('/delete/:id',checkRole(...editRoles), EmissionFactorHubController.deleteEmissionFactorHub);

module.exports = router;