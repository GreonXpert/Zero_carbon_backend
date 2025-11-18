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

// NEW: net-reduction data completion / frequency stats
const {
  getNetReductionCompletionStats
} = require('../../controllers/DataCollection/dataCompletionController');


router.use(auth);

// :calculationMethodology must be 'methodology1' (methodology2 later)
router.post('/:clientId/:projectId/:calculationMethodology/manual', saveManualNetReduction);
router.post('/:clientId/:projectId/:calculationMethodology/api',    saveApiNetReduction);
router.post('/:clientId/:projectId/:calculationMethodology/iot',    saveIotNetReduction);
router.post('/:clientId/:projectId/:calculationMethodology/csv',    upload.single('file'), uploadCsvNetReduction);

router.get('/:clientId/:projectId/:calculationMethodology/stats',   getNetReductionStats);


// ---------------------------------------------------
// Net Reduction data completion (frequency-based) stats
// GET /api/net-reduction/:clientId/data-completion
// ---------------------------------------------------
router.get('/:clientId/data-completion',  getNetReductionCompletionStats);



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
