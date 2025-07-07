// routes/fuelCombustionRoutes.js
const express = require('express');
const fuelCombustionController = require('../../controllers/EmissionFactor/fuelCombustionController');


const router = express.Router();

const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });

// Add new Fuel Combustion data
router.post('/add', fuelCombustionController.addFuelCombustion);

// Bulk upload Fuel Combustion data from CSV file
// accept any file‐field (avoids “Unexpected field”)
router.post(
  '/bulk-upload',
  upload.any(),
  fuelCombustionController.bulkUploadFuelCombustion
);

// Bulk download as CSV
router.get('/download', fuelCombustionController.downloadCSV);


// Filter Fuel Combustion data based on query parameters
router.get('/filter', fuelCombustionController.filterFuelCombustion);

// Update Fuel Combustion Data
router.put('/update/:id', fuelCombustionController.updateFuelCombustion);

// Get all Fuel Combustion data
router.get('/all', fuelCombustionController.getAllFuelCombustion);

// Get Fuel Combustion data by ID
router.get('/:id', fuelCombustionController.getFuelCombustionById);

// Filter Fuel Combustion data based on query parameters
router.get('/filter', fuelCombustionController.filterFuelCombustion);

// Delete Fuel Combustion data by ID
router.delete('/:id', fuelCombustionController.deleteFuelCombustionById);
module.exports = router;
