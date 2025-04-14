const CalculationDataOfEmissionC02e = require('../models/CalculationDataOfEmissionC02e');

// Add new data
exports.addCalculationData = async (req, res) => {
  try {
    const { userId, source, reference } = req.body;

    // Check if data with the given userId already exists
    const existingData = await CalculationDataOfEmissionC02e.findOne({ userId });

    if (existingData) {
      return res.status(400).json({
        message: 'Calculation data for this user already exists',
      });
    }

    // Ensure source and reference are provided
    if (!source || !reference) {
      return res.status(400).json({ message: "Source and reference are required." });
    }

    // Create new data
    const newData = new CalculationDataOfEmissionC02e(req.body);
    await newData.save();
    res.status(201).json({ message: 'Calculation data added successfully', data: newData });
  } catch (error) {
    res.status(500).json({ message: 'Error adding calculation data', error: error.message });
  }
};



// Get all data
exports.getAllCalculationData = async (req, res) => {
  try {
    const data = await CalculationDataOfEmissionC02e.find()
      .populate('userId', 'userName email')
      .select('-__v');
    res.status(200).json({ message: 'All calculation data fetched successfully', data });
  } catch (error) {
    res.status(500).json({ message: 'Error fetching calculation data', error: error.message });
  }
};


// Get data by userId
exports.getCalculationDataByUserId = async (req, res) => {
  try {
    const { userId } = req.params;
    const data = await CalculationDataOfEmissionC02e.find({ userId })
      .populate('userId', 'userName email')
      .select('-__v');
    if (!data.length) {
      return res.status(404).json({ message: 'No data found for the specified user' });
    }
    res.status(200).json({ message: 'Data fetched successfully', data });
  } catch (error) {
    res.status(500).json({ message: 'Error fetching data', error: error.message });
  }
};


// Update data by userId
exports.updateCalculationDataByUserId = async (req, res) => {
  try {
    const { userId } = req.params;

    const updatedData = await CalculationDataOfEmissionC02e.findOneAndUpdate(
      { userId },
      req.body,
      { new: true, runValidators: true }
    );

    if (!updatedData) {
      return res.status(404).json({ message: 'No data found for the specified user' });
    }
    res.status(200).json({ message: 'Data updated successfully', data: updatedData });
  } catch (error) {
    res.status(500).json({ message: 'Error updating data', error: error.message });
  }
};


// Delete data by userId
exports.deleteCalculationDataByUserId = async (req, res) => {
  try {
    const { userId } = req.params;

    const deletedData = await CalculationDataOfEmissionC02e.findOneAndDelete({ userId });

    if (!deletedData) {
      return res.status(404).json({ message: 'No data found for the specified user' });
    }

    res.status(200).json({ message: 'Data deleted successfully', data: deletedData });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting data', error: error.message });
  }
};

