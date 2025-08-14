// routes/Reduction/m2FormulaR.js
const express = require('express');
const router = express.Router();
const { auth } = require('../../middleware/auth');
const {
  createFormula,
  listFormulas,
  getFormula,
  updateFormula,
  deleteFormula
} = require('../../controllers/Reduction/m2FormulaController');

router.use(auth);

// CRUD
router.post('/',        createFormula);   // create
router.get('/',         listFormulas);    // list
router.get('/:id',      getFormula);      // get one
router.put('/:id',      updateFormula);   // update
router.delete('/:id',   deleteFormula);   // soft delete

module.exports = router;
