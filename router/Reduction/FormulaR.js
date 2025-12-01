// routes/Reduction/m2FormulaR.js
const router = require('express').Router();
const ctrl = require('../../controllers/Reduction/FormulaController');
const { auth, checkRole } = require('../../middleware/auth');


// all endpoints require login + role
router.use(auth);

const works = ['consultant', 'consultant_admin', 'super_admin'];
const gets = ['consultant', 'consultant_admin', 'super_admin', 'client_admin', 'auditor'];

router.get('/delete-requests', checkRole(...works), ctrl.getDeleteRequestedIds);
router.get('/delete-requests/:requestId', checkRole(...works), ctrl.getDeleteRequestedById);
router.get('/delete-requests/filter/query', checkRole(...works), ctrl.filterDeleteRequested);

// CRUD for formulas
router.post('/', checkRole(...works), ctrl.createFormula);
router.get('/', checkRole(...gets),  ctrl.listFormulas);
router.get('/:formulaId',checkRole(...gets),  ctrl.getFormula);
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
