// routes/Reduction/netReductionSummaryR.js
const router = require('express').Router();
const { auth } = require('../../middleware/auth');
const {
  getClientSummary,
  recomputeClientSummaryNow,
  getProjectSummary
} = require('../../controllers/Reduction/netReductionSummaryController');

router.use(auth);

// GET client summary (add ?refresh=true to force recompute)
router.get('/:clientId', getClientSummary);

// Force recompute now
router.post('/:clientId/recompute', recomputeClientSummaryNow);

// One project view from the summary
router.get('/:clientId/:projectId', getProjectSummary);

module.exports = router;
