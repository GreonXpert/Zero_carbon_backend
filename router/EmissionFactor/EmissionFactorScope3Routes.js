const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const emissionFactorScope3Controller = require('../../controllers/EmissionFactor/EmissionFactorScope3Controller');

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

// Routes for Scope 3 Emission Factors

// POST /api/scope3-emission-factors/add - Add new Scope 3 emission factor
router.post('/add', emissionFactorScope3Controller.addEmissionFactorScope3);

// GET /api/scope3-emission-factors/all - Get all Scope 3 emission factors
router.get('/all', emissionFactorScope3Controller.getAllEmissionFactorsScope3);

// GET /api/scope3-emission-factors/filter - Filter/Search Scope 3 emission factors
router.get('/filter', emissionFactorScope3Controller.filterEmissionFactorsScope3);

// GET /api/scope3-emission-factors/categories - Get unique categories (with query parameter support)
router.get('/keys', emissionFactorScope3Controller.getUniqueCategories);

// GET /api/scope3-emission-factors/items - Get items by category and activity
router.get('/items', emissionFactorScope3Controller.getItemsByCategoryAndActivity);



// GET /api/scope3-emission-factors/activities/:category - Get activities by category
router.get('/activities/:category', emissionFactorScope3Controller.getActivitiesByCategory);

// GET /api/scope3-emission-factors/csv-template - Download CSV template
router.get('/csv-template', emissionFactorScope3Controller.downloadCSVTemplate);

// POST /api/scope3-emission-factors/bulk-import - Bulk import emission factors (CSV upload or manual data)
router.post('/bulk-import', upload.single('csvFile'), emissionFactorScope3Controller.bulkImportEmissionFactorsScope3);

// GET /api/scope3-emission-factors/:id - Get Scope 3 emission factor by ID
router.get('/:id', emissionFactorScope3Controller.getEmissionFactorScope3ById);

// PUT /api/scope3-emission-factors/update/:id - Update Scope 3 emission factor by ID
router.put('/update/:id', emissionFactorScope3Controller.updateEmissionFactorScope3);

// DELETE /api/scope3-emission-factors/delete/:id - Delete Scope 3 emission factor by ID
router.delete('/delete/:id', emissionFactorScope3Controller.deleteEmissionFactorScope3);

module.exports = router;