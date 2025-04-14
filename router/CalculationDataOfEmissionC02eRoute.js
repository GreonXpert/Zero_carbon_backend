const express = require('express');
const router = express.Router();
const calculationController = require('../controllers/CalculationDataOfEmissionC02eController');

// Routes for Calculation Data
router.post('/calculation-data', calculationController.addCalculationData);
router.get('/calculation-data', calculationController.getAllCalculationData);
router.get('/calculation-data/:userId', calculationController.getCalculationDataByUserId);
router.put('/calculation-data/:userId', calculationController.updateCalculationDataByUserId);
router.delete('/calculation-data/:userId', calculationController.deleteCalculationDataByUserId);

module.exports = router;
