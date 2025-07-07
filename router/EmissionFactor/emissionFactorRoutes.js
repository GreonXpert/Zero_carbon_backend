const express = require('express');
const router = express.Router();
const { getEmissionFactors,  getDistinctValues } = require('../../controllers/EmissionFactor/emissionFactorController');

// GET /api/emission-factors?source=EPA&page=1&limit=20&sortBy=level1EPA&order=asc&scopeEPA=Scope1...
router.get('/', getEmissionFactors);

// GET /api/emission-factors/distinct
// Fetch all distinct values for a given key (including yearlyValues.from/to for Country)
router.get('/distinct', getDistinctValues);

module.exports = router;
