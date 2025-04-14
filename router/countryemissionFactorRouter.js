const express = require('express');
const router = express.Router();
const {
    addEmissionFactor,
    getAllEmissionFactors,
    getEmissionFactorById,
    updateEmissionFactor,
    deleteEmissionFactor
} = require('../controllers/countryEmissionFactorController');

// Add new country emission factor
router.post('/add', addEmissionFactor);

// Get all country emission factors
router.get('/all', getAllEmissionFactors);

// Get single country emission factor by ID
router.get('/:id', getEmissionFactorById);

// Update country emission factor by ID
router.put('/update/:id', updateEmissionFactor);

// Delete country emission factor by ID
router.delete('/delete/:id', deleteEmissionFactor);

module.exports = router;
