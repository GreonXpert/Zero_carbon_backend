// routes/gwpRoutes.js
const express = require('express');
const gwpController = require('../controllers/gwpController');

const router = express.Router();

// Routes for GWP
router.post('/add', gwpController.addGWP);
router.get('/all', gwpController.getAllGWP);
router.get('/:id([0-9a-fA-F]{24})', gwpController.getGWPById);
router.put('/update/:id', gwpController.updateGWP);
router.delete('/delete/:id', gwpController.deleteGWP);
router.get('/chemical/:chemicalName', gwpController.getGWPByChemicalName);
router.get('/chemicalFormula/:chemicalFormula',gwpController.getGWPByChemicalFormula)
router.get('/gwp-value', gwpController.getGWPWithFilters);

// Get latest AR assessment for a specific chemical
router.get('/latest-ar/:chemicalNameOrFormula', async (req, res) => {
  try {
    const { chemicalNameOrFormula } = req.params;
    const result = await gwpController.getLatestARAssessment(chemicalNameOrFormula);
    
    if (!result.found) {
      return res.status(404).json({ 
        message: 'No GWP data found for the specified chemical',
        searchTerm: chemicalNameOrFormula
      });
    }
    
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ 
      message: 'Failed to get latest AR assessment', 
      error: error.message 
    });
  }
});

// Bulk update multiple chemicals with new AR assessments
router.post('/bulk-update', async (req, res) => {
  try {
    const { chemicalUpdates } = req.body;
    
    if (!Array.isArray(chemicalUpdates) || chemicalUpdates.length === 0) {
      return res.status(400).json({ 
        message: 'chemicalUpdates array is required and cannot be empty' 
      });
    }
    
    const results = await gwpController.bulkUpdateGWP(chemicalUpdates);
    
    res.status(200).json({
      message: 'Bulk update completed',
      results
    });
  } catch (error) {
    res.status(500).json({ 
      message: 'Bulk update failed', 
      error: error.message 
    });
  }
});

// Check which chemicals need updates for a specific AR version
router.get('/check-updates/:arVersion?', async (req, res) => {
  try {
    const { arVersion = 'AR6' } = req.params;
    const chemicalsNeedingUpdate = await gwpController.checkForGWPUpdates(arVersion);
    
    res.status(200).json({
      assessmentVersion: arVersion,
      chemicalsNeedingUpdate: chemicalsNeedingUpdate.length,
      chemicals: chemicalsNeedingUpdate
    });
  } catch (error) {
    res.status(500).json({ 
      message: 'Failed to check for updates', 
      error: error.message 
    });
  }
});

// Add new AR assessment to all chemicals (for when AR7 is released)
router.post('/add-new-ar', gwpController.addNewARToAllChemicals);

// Get GWP statistics and coverage
router.get('/stats', gwpController.getGWPStats);

// Search GWP by unit with fuzzy matching option
router.get('/search/unit/:unit', async (req, res) => {
  try {
    const { unit } = req.params;
    const { fuzzyMatch = 'true' } = req.query;
    
    const result = await gwpController.searchGWPByUnit(unit, fuzzyMatch === 'true');
    
    if (!result.found) {
      return res.status(404).json({
        message: 'No GWP data found for the specified unit',
        searchTerm: unit,
        suggestion: 'Try enabling fuzzy matching or check the unit spelling'
      });
    }
    
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ 
      message: 'Failed to search GWP by unit', 
      error: error.message 
    });
  }
});

// Update specific assessment for a chemical
router.put('/update-assessment/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { assessmentType, value } = req.body;
    
    if (!assessmentType || value === undefined) {
      return res.status(400).json({ 
        message: 'assessmentType and value are required' 
      });
    }
    
    const gwpData = await GWP.findById(id);
    if (!gwpData) {
      return res.status(404).json({ message: 'GWP data not found' });
    }
    
    // Update the specific assessment
    gwpData.assessments.set(assessmentType, value);
    await gwpData.save();
    
    res.status(200).json({
      message: `Successfully updated ${assessmentType} assessment`,
      data: gwpData
    });
  } catch (error) {
    res.status(500).json({ 
      message: 'Failed to update assessment', 
      error: error.message 
    });
  }
});

// Get GWP value by emission factor parameters (for direct integration)
router.post('/get-by-emission-factor', async (req, res) => {
  try {
    const { source, unit, ghgUnit, ghgUnitEPA, chemicalFormula } = req.body;
    
    let searchUnit = unit || ghgUnit || ghgUnitEPA || chemicalFormula;
    
    if (!searchUnit) {
      return res.status(400).json({ 
        message: 'At least one unit/chemical identifier is required' 
      });
    }
    
    const result = await gwpController.searchGWPByUnit(searchUnit, true);
    
    res.status(200).json({
      source,
      searchedUnit: searchUnit,
      gwpResult: result
    });
  } catch (error) {
    res.status(500).json({ 
      message: 'Failed to get GWP by emission factor', 
      error: error.message 
    });
  }
});

module.exports = router;
