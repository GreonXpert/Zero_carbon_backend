const express = require('express');
const router  = express.Router();

const {
  getEmissionFactors,
  getDistinctValues,
  superSearch,            // ← NEW
} = require('../../controllers/EmissionFactor/emissionFactorController');

// ── Existing endpoints (unchanged) ──────────────────────────────────────────
// GET /api/emission-factors?source=EPA&page=1&limit=20&sortBy=level1EPA&order=asc...
router.get('/', getEmissionFactors);

// GET /api/emission-factors/distinct?source=EPA&key=level1EPA
router.get('/distinct', getDistinctValues);

// ── Super Search (NEW) ───────────────────────────────────────────────────────
// GET /api/emission-factors/search?q=diesel&source=defra&page=1&limit=20
// GET /api/emission-factors/search?q=diesel,transport&source=all
// GET /api/emission-factors/search?q=deisel&source=epa          (typo-tolerant)
router.get('/search', superSearch);

module.exports = router;