// routes/iotRoutes.js
const express = require('express');
const router = express.Router();
const {
  saveIOTData,
  getAllIOTData,
  getIOTDataByUser,
  getIOTDataByProductId
} = require('../controllers/iotController');

// POST /api/iotdata - Save IoT data
router.post('/iotdata', saveIOTData);

// GET /api/iotdata - Get all IoT data with pagination
router.get('/iotdata', getAllIOTData);

// GET /api/iotdata/user/:userName - Get IoT data by user
router.get('/iotdata/user/:userName', getIOTDataByUser);

// GET /api/iotdata/product/:productId - Get IoT data by product ID
router.get('/iotdata/product/:productId', getIOTDataByProductId);

module.exports = router;
