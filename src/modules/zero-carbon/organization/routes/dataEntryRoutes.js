const express = require('express');
const router = express.Router();
const {
  createDataEntry,
  getDataByUserNode
} = require('../controllers/dataEntryController');

// Create a new data entry for a given user and node
// POST /api/data-entry/:userId/:nodeId
router.post('/:userId/:nodeId', createDataEntry);



// Get all entries for a given user and node
// GET /api/data-entry/:userId/:nodeId
router.get('/:userId/:nodeId', getDataByUserNode);

module.exports = router;
