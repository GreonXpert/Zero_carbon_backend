// routes/reductionR.js
const express = require('express');
const router = express.Router();
const { auth } = require('../../middleware/auth');
const {
  createReduction,
  getReduction,
  updateReduction,
  recalculateReduction,
  deleteReduction,
  deleteFromDB,
  restoreSoftDeletedReduction,
  getAllReductions,
  assignEmployeeHeadToProject,
  assignEmployeesToProject
} = require('../../controllers/Reduction/reductionController');
const { uploadReductionMedia } = require('../../utils/uploads/reductionUpload');

router.use(auth);

// Create: consultant_admin (creator of lead) or assigned consultant
router.post('/:clientId',uploadReductionMedia, createReduction);

router.get('/getall',getAllReductions);



router.get('/:clientId/:projectId', getReduction);

// Update
router.put('/:clientId/:projectId',uploadReductionMedia, updateReduction);

// Force recalc (optional convenience)
router.post('/:clientId/:projectId/recalculate', recalculateReduction);

// Delete (soft)
router.delete('/:clientId/:projectId', deleteReduction);

// --- ADD this new read-only route for soft-deleted items ---
router.patch('/:clientId/:projectId/restore', restoreSoftDeletedReduction);
// Hard delete from DB (super admin only)
// Note: This is a destructive operation and should be used with caution
router.delete('/:clientId/:projectId/hard', deleteFromDB);

// Team assignment for a Reduction project
router.patch('/:clientId/:projectId/assign-employee-head', assignEmployeeHeadToProject);
router.patch('/:clientId/:projectId/assign-employees',      assignEmployeesToProject);


module.exports = router;
