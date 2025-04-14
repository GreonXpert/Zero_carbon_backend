// routes/fuelCombustionRoutes.js
const express = require('express');
const fuelCombustionController = require('../controllers/fuelCombustionController');

const router = express.Router();

// Add new Fuel Combustion data
router.post('/add', fuelCombustionController.addFuelCombustion);


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
