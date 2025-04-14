// routes/gwpRoutes.js
const express = require('express');
const gwpController = require('../controllers/gwpController');

const router = express.Router();

// Routes for GWP
router.post('/add', gwpController.addGWP);
router.get('/all', gwpController.getAllGWP);
router.get('/:id', gwpController.getGWPById);
router.put('/update/:id', gwpController.updateGWP);
router.delete('/delete/:id', gwpController.deleteGWP);
router.get('/chemical/:chemicalName', gwpController.getGWPByChemicalName);
router.get('/chemicalFormula/:chemicalFormula',gwpController.getGWPByChemicalFormula)

module.exports = router;
