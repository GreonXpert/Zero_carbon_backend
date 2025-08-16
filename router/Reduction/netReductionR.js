// routes/netReductionR.js
const express = require('express');
const router = express.Router();
const { auth } = require('../../middleware/auth');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });

const {
  saveManualNetReduction,
  saveApiNetReduction,
  saveIotNetReduction,
  uploadCsvNetReduction,
  getNetReductionStats,
  listNetReductions,
  deleteManualNetReductionEntry,
  updateManualNetReductionEntry
} = require('../../controllers/Reduction/netReductionController');

router.use(auth);

// :calculationMethodology must be 'methodology1' (methodology2 later)
router.post('/:clientId/:projectId/:calculationMethodology/manual', saveManualNetReduction);
router.post('/:clientId/:projectId/:calculationMethodology/api',    saveApiNetReduction);
router.post('/:clientId/:projectId/:calculationMethodology/iot',    saveIotNetReduction);
router.post('/:clientId/:projectId/:calculationMethodology/csv',    upload.single('file'), uploadCsvNetReduction);

router.get('/:clientId/:projectId/:calculationMethodology/stats',   getNetReductionStats);

router.get(
  '/',
  
 listNetReductions
);


// Edit & Delete manual entries
router.patch(
  '/:clientId/:projectId/:calculationMethodology/manual/:entryId',
  
  updateManualNetReductionEntry
);

router.delete(
  '/:clientId/:projectId/:calculationMethodology/manual/:entryId',
  
  deleteManualNetReductionEntry
);

module.exports = router;
