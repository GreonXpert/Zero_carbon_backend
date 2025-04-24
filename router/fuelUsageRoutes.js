// routes/fuelUsageRoutes.js
const express = require('express');
const router = express.Router();
const fuelCtrl = require('../controllers/FuelUsageController');
const auth = require('../middleware/auth');              // JWT auth middleware
const multer = require('multer');

// Multer setup for file uploads (store file in memory)
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    // Accept only .csv or .json files
    if (file.mimetype === 'text/csv' || file.mimetype === 'application/json' ||
        file.originalname.match(/\.(csv|json)$/)) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV or JSON files are allowed'), false);
    }
  }
});

router.post('/upload', auth, upload.single('file'), fuelCtrl.uploadFuelUsageFile);

// We handle auth inside the controller for '/api/fuel-usage' to allow Basic auth.
router.post('/', fuelCtrl.createFuelUsageViaApi);

// (Optional) Protected route to list fuel usages for user
router.get('/', auth, async (req, res) => {
  try {
    const data = await FuelUsage.find({ user: req.user._id }).populate('fuelCombustion');
    res.status(200).json({ data });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch fuel usage data", error: err.message });
  }
});

module.exports = router;
