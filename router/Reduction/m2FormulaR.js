// routes/Reduction/m2FormulaR.js
const express = require('express');
const router = express.Router();
const { auth } = require('../../middleware/auth');

const {
  createFormula,
  getFormula,
  listFormulas,
  updateFormula,
  deleteFormula
} = require('../../controllers/Reduction/m2FormulaController');

router.use(auth);

// CRUD (scaffold; not wired into M1/M2 calculations yet)
router.post('/formulas',            createFormula);    // body: { clientId?, name, expression, ... }
router.get('/formulas',             listFormulas);     // query: clientId?, category?, q?
router.get('/formulas/:id',         getFormula);
router.put('/formulas/:id',         updateFormula);
router.delete('/formulas/:id',      deleteFormula);

module.exports = router;
