// routes/processflowR.js
const express = require('express');
const { authenticate } = require('../utils/authenticate');
const {
  saveProcessFlowchart,
  getProcessFlowchart,
  updateProcessFlowchart,
  deleteProcessNode
} = require('../controllers/processflowController');

const router = express.Router();

router.post('/save', saveProcessFlowchart);
router.get('/get/:userId', getProcessFlowchart);
router.patch('/update', authenticate, updateProcessFlowchart);
router.delete('/delete', authenticate, deleteProcessNode);

module.exports = router;