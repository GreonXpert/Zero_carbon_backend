const express = require('express');
const router = express.Router();
const {
    addEmissionFactor,
    getAllEmissionFactors,
    getEmissionFactorById,
    updateEmissionFactor,
    deleteEmissionFactor,
    bulkImportCountryEmissionFactors,
    downloadCountryEmissionFactorsTemplate
} = require('../../controllers/EmissionFactor/countryEmissionFactorController');
const multer = require('multer');
const path = require('path');


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
    // Accept only CSV files
    if (file.mimetype === 'text/csv' || path.extname(file.originalname).toLowerCase() === '.csv') {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// Add new country emission factor
router.post('/add', addEmissionFactor);

// 1. bulk import via CSV upload (field name: csvFile)
router.post('/bulk-import', upload.single('csvFile'), bulkImportCountryEmissionFactors);

// 2. download a CSV template
router.get('/template', downloadCountryEmissionFactorsTemplate);

// Get all country emission factors
router.get('/all', getAllEmissionFactors);

// Get single country emission factor by ID
router.get('/:id', getEmissionFactorById);



// Update country emission factor by ID
router.put('/update/:id', updateEmissionFactor);

// Delete country emission factor by ID
router.delete('/delete/:id', deleteEmissionFactor);

module.exports = router;
