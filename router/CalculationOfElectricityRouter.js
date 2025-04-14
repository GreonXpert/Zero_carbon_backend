const express = require('express');
const router = express.Router();
const electricityController = require('../controllers/CalculationOfElectricityController');

// Calculate and save electricity emissions
router.post('/calculate-electricity-emission', electricityController.calculateAndSaveElectricityEmission);

// Get electricity emissions by userId
router.get('/electricity-emissions/:userId', electricityController.getElectricityEmissionsByUserId);

// Edit electricity emissions by userId
router.put('/electricity-emissions/:userId', electricityController.editElectricityEmissionsByUserId);

// Delete electricity emissions by userId
// Delete electricity emissions by userId and dates
router.delete('/electricity-emissions/:userId', electricityController.deleteElectricityEmissionsByUserIdAndDates);


module.exports = router;
