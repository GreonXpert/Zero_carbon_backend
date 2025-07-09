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

  /**
 * Get the latest available AR assessment value for a chemical
 * Prioritizes AR7 > AR6 > AR5 > AR4 for future compatibility
 */
exports.getLatestARAssessment = async (chemicalNameOrFormula) => {
  try {
    if (!chemicalNameOrFormula) return { value: 0, assessment: null };
    
    const normalizedInput = chemicalNameOrFormula.toString().trim().toLowerCase();
    
    // Search by both chemical name and formula
    const gwpData = await GWP.findOne({
      $or: [
        { chemicalFormula: { $regex: new RegExp(`^${normalizedInput}$`, 'i') } },
        { chemicalName: { $regex: new RegExp(`^${normalizedInput}$`, 'i') } }
      ]
    });

    if (!gwpData || !gwpData.assessments || gwpData.assessments.size === 0) {
      return { value: 0, assessment: null, found: false };
    }

    // Priority order for assessments (future-proof for AR7)
    const priorityOrder = ['AR7', 'AR6', 'AR5', 'AR4'];
    
    for (const ar of priorityOrder) {
      if (gwpData.assessments.has(ar)) {
        return {
          value: gwpData.assessments.get(ar),
          assessment: ar,
          found: true,
          chemicalName: gwpData.chemicalName,
          chemicalFormula: gwpData.chemicalFormula
        };
      }
    }

    // Fallback to first available assessment
    const firstAssessment = Array.from(gwpData.assessments.keys())[0];
    const firstValue = gwpData.assessments.get(firstAssessment);
    
    return {
      value: firstValue || 0,
      assessment: firstAssessment,
      found: true,
      chemicalName: gwpData.chemicalName,
      chemicalFormula: gwpData.chemicalFormula
    };
    
  } catch (error) {
    console.error('Error getting latest AR assessment:', error);
    return { value: 0, assessment: null, found: false, error: error.message };
  }
};


/**
 * Bulk update GWP values for multiple chemicals
 * Useful when new AR assessments are released
 */
exports.bulkUpdateGWP = async (chemicalUpdates) => {
  try {
    const results = {
      updated: 0,
      failed: 0,
      errors: []
    };

    for (const update of chemicalUpdates) {
      try {
        const { chemicalName, chemicalFormula, newAssessment, value } = update;
        
        const filter = chemicalName 
          ? { chemicalName: { $regex: new RegExp(`^${chemicalName}$`, 'i') } }
          : { chemicalFormula: { $regex: new RegExp(`^${chemicalFormula}$`, 'i') } };

        const gwpDoc = await GWP.findOne(filter);
        
        if (gwpDoc) {
          // Add new assessment to existing assessments
          gwpDoc.assessments.set(newAssessment, value);
          await gwpDoc.save();
          results.updated++;
        } else {
          results.failed++;
          results.errors.push(`Chemical not found: ${chemicalName || chemicalFormula}`);
        }
      } catch (error) {
        results.failed++;
        results.errors.push(`Error updating ${update.chemicalName || update.chemicalFormula}: ${error.message}`);
      }
    }

    return results;
  } catch (error) {
    throw new Error(`Bulk update failed: ${error.message}`);
  }
};



/**
 * Check for chemicals that need GWP updates
 * Returns list of chemicals that don't have the latest AR assessment
 */
exports.checkForGWPUpdates = async (latestARVersion = 'AR6') => {
  try {
    const chemicalsNeedingUpdate = await GWP.find({
      [`assessments.${latestARVersion}`]: { $exists: false }
    }).select('chemicalName chemicalFormula assessments');

    return chemicalsNeedingUpdate.map(chemical => ({
      _id: chemical._id,
      chemicalName: chemical.chemicalName,
      chemicalFormula: chemical.chemicalFormula,
      currentAssessments: Array.from(chemical.assessments.keys()),
      missingAssessment: latestARVersion
    }));
  } catch (error) {
    throw new Error(`Error checking for GWP updates: ${error.message}`);
  }
};

/**
 * Add a new AR assessment to all existing chemicals
 * Use this when a new AR report is released (e.g., AR7)
 */
exports.addNewARToAllChemicals = async (req, res) => {
  try {
    const { assessmentType, defaultValue = 0 } = req.body;
    
    if (!assessmentType) {
      return res.status(400).json({ 
        message: 'Assessment type is required (e.g., AR7)' 
      });
    }

    // Update all chemicals that don't have this assessment
    const updateResult = await GWP.updateMany(
      { [`assessments.${assessmentType}`]: { $exists: false } },
      { $set: { [`assessments.${assessmentType}`]: defaultValue } }
    );

    res.status(200).json({
      message: `Successfully added ${assessmentType} assessment to chemicals`,
      modifiedCount: updateResult.modifiedCount,
      note: `Default value of ${defaultValue} was set. Update individual values as needed.`
    });
  } catch (error) {
    res.status(500).json({ 
      message: 'Failed to add new AR assessment', 
      error: error.message 
    });
  }
};

/**
 * Get GWP statistics and assessment coverage
 */
exports.getGWPStats = async (req, res) => {
  try {
    const totalChemicals = await GWP.countDocuments();
    
    // Get assessment coverage
    const assessmentStats = await GWP.aggregate([
      { $project: { 
          assessmentKeys: { $objectToArray: "$assessments" }
        }
      },
      { $unwind: "$assessmentKeys" },
      { $group: {
          _id: "$assessmentKeys.k",
          count: { $sum: 1 },
          avgValue: { $avg: "$assessmentKeys.v" },
          minValue: { $min: "$assessmentKeys.v" },
          maxValue: { $max: "$assessmentKeys.v" }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    res.status(200).json({
      totalChemicals,
      assessmentCoverage: assessmentStats,
      lastUpdated: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      message: 'Failed to get GWP statistics', 
      error: error.message 
    });
  }
};

/**
 * Enhanced search function for GWP values with fuzzy matching
 */
exports.searchGWPByUnit = async (unit, fuzzyMatch = true) => {
  try {
    if (!unit) return { value: 0, found: false };
    
    const normalizedUnit = unit.toString().trim().toLowerCase();
    
    // Exact match first
    let gwpData = await GWP.findOne({
      $or: [
        { chemicalFormula: { $regex: new RegExp(`^${normalizedUnit}$`, 'i') } },
        { chemicalName: { $regex: new RegExp(`^${normalizedUnit}$`, 'i') } }
      ]
    });

    // If no exact match and fuzzy matching is enabled
    if (!gwpData && fuzzyMatch) {
      gwpData = await GWP.findOne({
        $or: [
          { chemicalFormula: { $regex: new RegExp(normalizedUnit, 'i') } },
          { chemicalName: { $regex: new RegExp(normalizedUnit, 'i') } }
        ]
      });
    }

    if (!gwpData) {
      return { value: 0, found: false, searchTerm: unit };
    }

    // Get latest assessment value
    const latestAR = exports.getLatestARAssessment(unit);
    return latestAR;
    
  } catch (error) {
    console.error('Error searching GWP by unit:', error);
    return { value: 0, found: false, error: error.message };
  }
};