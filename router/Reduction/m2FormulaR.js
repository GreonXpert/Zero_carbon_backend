// routes/Reduction/m2FormulaR.js
const router = require('express').Router();
const ctrl = require('../../controllers/Reduction/m2FormulaController');
const { auth, checkRole } = require('../../middleware/auth');


// all endpoints require login + role
router.use(auth);

const works = ['consultant', 'consultant_admin', 'super_admin'];

// CRUD for formulas
router.post('/', checkRole(...works), ctrl.createFormula);
router.get('/', checkRole(...works),  ctrl.listFormulas);
router.get('/:formulaId',checkRole(...works),  ctrl.getFormula);
router.put('/:formulaId', checkRole(...works), ctrl.updateFormula);
router.delete('/:formulaId/:mode?',checkRole(...works), ctrl.deleteFormula);
// map formula to a reduction project (m2)
router.post('/attach/:clientId/:projectId',
 checkRole(...works), 
  ctrl.attachFormulaToReduction
);
router.post('/delete-requests/:requestId/approve', checkRole('super_admin','consultant_admin'), ctrl.approveDeleteRequest);
router.post('/delete-requests/:requestId/reject', checkRole('super_admin','consultant_admin'), ctrl.rejectDeleteRequest);
module.exports = router;
