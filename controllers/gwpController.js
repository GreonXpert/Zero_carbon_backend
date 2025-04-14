// controllers/gwpController.js
const GWP = require('../models/GWP');

// Add new GWP entry
// Add new GWP entry
exports.addGWP = async (req, res) => {
    try {
      const { chemicalName, chemicalFormula, assessments } = req.body;
  
      if (!chemicalName || !chemicalFormula || !assessments) {
        return res.status(400).json({ message: 'All fields (chemicalName, chemicalFormula, assessments) are required.' });
      }
  
      const newGWP = new GWP({
        chemicalName,
        chemicalFormula, // Add chemical formula
        assessments,
      });
  
      await newGWP.save();
  
      res.status(201).json({ message: 'GWP data added successfully!', data: newGWP });
    } catch (error) {
      res.status(500).json({ message: 'Failed to add GWP data', error: error.message });
    }
  };

// Get all GWP data
exports.getAllGWP = async (req, res) => {
  try {
    const gwpData = await GWP.find();
    res.status(200).json(gwpData);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch GWP data', error: error.message });
  }
};

// Update GWP entry (supports dynamic addition of assessments)
exports.updateGWP = async (req, res) => {
    try {
      const { id } = req.params;
      const { chemicalName, chemicalFormula, assessments } = req.body;
  
      // Check for all required fields
      if (!chemicalName || !chemicalFormula || !assessments) {
        return res.status(400).json({ message: 'chemicalName, chemicalFormula, and assessments are required fields.' });
      }
  
      const updatedGWP = await GWP.findByIdAndUpdate(
        id,
        { chemicalName, chemicalFormula, assessments },
        { new: true, runValidators: true } // Returns the updated document and applies validation
      );
  
      if (!updatedGWP) {
        return res.status(404).json({ message: 'GWP data not found' });
      }
  
      res.status(200).json({ message: 'GWP data updated successfully!', data: updatedGWP });
    } catch (error) {
      res.status(500).json({ message: 'Failed to update GWP data', error: error.message });
    }
  };
  

// Delete GWP entry
exports.deleteGWP = async (req, res) => {
  try {
    const { id } = req.params;

    const deletedGWP = await GWP.findByIdAndDelete(id);
    if (!deletedGWP) return res.status(404).json({ message: 'GWP data not found' });

    res.status(200).json({ message: 'GWP data deleted successfully!' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to delete GWP data', error: error.message });
  }
};

// Get a single GWP entry by ID
exports.getGWPById = async (req, res) => {
  try {
    const { id } = req.params;

    const gwpData = await GWP.findById(id);
    if (!gwpData) return res.status(404).json({ message: 'GWP data not found' });

    res.status(200).json(gwpData);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch GWP data', error: error.message });
  }
};

// Get a single GWP using Chemical Name
// Get a single GWP using Chemical Name
exports.getGWPByChemicalName = async (req, res) => {
    try {
      const { chemicalName } = req.params;
  
      // Pass the chemicalName as a query object
      const gwpData = await GWP.findOne({ chemicalName });
      if (!gwpData) return res.status(404).json({ message: 'GWP data not found' });
  
      res.status(200).json(gwpData);
    } catch (error) {
      res.status(500).json({ message: 'Failed to fetch GWP data', error: error.message });
    }
  };
  

  exports.getGWPByChemicalFormula = async (req, res) => {
    try {
      const { chemicalFormula } = req.params;
  
      // Pass the chemicalName as a query object
      const gwpData = await GWP.findOne({ chemicalFormula });
      if (!gwpData) return res.status(404).json({ message: 'GWP data not found' });
  
      res.status(200).json(gwpData);
    } catch (error) {
      res.status(500).json({ message: 'Failed to fetch GWP data', error: error.message });
    }
  };