// routes/emissionRoutes.js

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth'); // Your authentication middleware

// Import controllers
const {
  calculateEmissions,
  calculateBatchEmissions,
  getEmissionSummary
} = require('../controllers/Calculation/emissionCalculationController');

const {
  recalculateHistoricalEmissions
} = require('../controllers/Calculation/emissionIntegration');

const {
  createDataEntry,
  saveAPIData,
  saveIoTData,
  saveManualData,
  getDataByUserNode
} = require('../controllers/dataEntryController');



// Data Entry Routes with Emission Calculation
router.post('/data-entry/:clientId/:nodeId/:scopeIdentifier', auth, createDataEntry);
router.post('/data-entry/api/:clientId/:nodeId/:scopeIdentifier', auth, saveAPIData);
router.post('/data-entry/iot/:clientId/:nodeId/:scopeIdentifier', auth, saveIoTData);
router.post('/data-entry/manual/:clientId/:nodeId/:scopeIdentifier', auth, saveManualData);

// Get data entries
router.get('/data-entry/:clientId/:nodeId', auth, getDataByUserNode);

// Direct Emission Calculation Routes
router.post('/emissions/calculate', auth, calculateEmissions);
router.post('/emissions/calculate-batch', auth, calculateBatchEmissions);
router.post('/emissions/recalculate-historical', auth, recalculateHistoricalEmissions);

// Emission Summary and Reports
router.get('/emissions/summary', auth, getEmissionSummary);

// Example usage in app.js:
// app.use('/api', emissionRoutes);

module.exports = router;