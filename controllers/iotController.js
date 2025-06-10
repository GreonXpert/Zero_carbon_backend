// controllers/iotController.js
const IOTData = require('../models/IOTData');

// Helper function to format current date and time
const getCurrentDateTime = () => {
  const now = new Date();
  
  // Format time as HH:MM:SS
  const time = now.toTimeString().split(' ')[0]; // Gets HH:MM:SS part
  
  // Format date as DD/MM/YYYY
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0'); // Months are 0-indexed
  const year = now.getFullYear();
  const date = `${day}/${month}/${year}`;
  
  return { time, date };
};

// Save IoT data from API endpoint
const saveIOTData = async (req, res) => {
  try {
    console.log('📡 Received IoT data via API:', req.body);
    
    const { energyValue, energy_product_id, userName } = req.body;

    // Validate required fields
    if (!energyValue || !energy_product_id || !userName) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: energyValue, energy_product_id, userName'
      });
    }

    // Get current formatted date and time
    const { time, date } = getCurrentDateTime();

    // Create new IoT data entry
    const iotData = new IOTData({
      energyValue: parseFloat(energyValue),
      energyProductId: energy_product_id,
      userName: userName.trim(),
      time,
      date
    });

    // Save to database
    const savedData = await iotData.save();
    console.log('💾 IoT data saved to database:', savedData);

    // Emit real-time update via Socket.IO (if available)
    if (global.io) {
      global.io.emit('newIoTData', {
        id: savedData._id,
        energyValue: savedData.energyValue,
        energyProductId: savedData.energyProductId,
        userName: savedData.userName,
        time: savedData.time,
        date: savedData.date,
        receivedAt: savedData.receivedAt
      });
      console.log('📡 Real-time update sent via Socket.IO');
    }

    return res.status(201).json({
      success: true,
      message: 'IoT data saved successfully',
      data: savedData
    });

  } catch (error) {
    console.error('❌ Error saving IoT data:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to save IoT data',
      error: error.message
    });
  }
};

// Get all IoT data with pagination
const getAllIOTData = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    // Get data with pagination, sorted by newest first
    const iotData = await IOTData.find()
      .sort({ receivedAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await IOTData.countDocuments();

    return res.status(200).json({
      success: true,
      data: iotData,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: limit
      }
    });

  } catch (error) {
    console.error('❌ Error fetching IoT data:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch IoT data',
      error: error.message
    });
  }
};

// Get IoT data by userName
const getIOTDataByUser = async (req, res) => {
  try {
    const { userName } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const iotData = await IOTData.find({ userName })
      .sort({ receivedAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await IOTData.countDocuments({ userName });

    return res.status(200).json({
      success: true,
      data: iotData,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: limit
      }
    });

  } catch (error) {
    console.error('❌ Error fetching user IoT data:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch user IoT data',
      error: error.message
    });
  }
};

// Get IoT data by energy product ID
const getIOTDataByProductId = async (req, res) => {
  try {
    const { productId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const iotData = await IOTData.find({ energyProductId: productId })
      .sort({ receivedAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await IOTData.countDocuments({ energyProductId: productId });

    return res.status(200).json({
      success: true,
      data: iotData,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: limit
      }
    });

  } catch (error) {
    console.error('❌ Error fetching product IoT data:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch product IoT data',
      error: error.message
    });
  }
};

// Function to handle MQTT data (called from MQTT subscriber)
const handleMQTTData = async (mqttData) => {
  try {
    console.log('📡 Received IoT data via MQTT:', mqttData);

    const { energyValue, energy_product_id, userName } = mqttData;

    // Validate required fields
    if (!energyValue || !energy_product_id || !userName) {
      console.error('❌ Missing required MQTT fields:', mqttData);
      return false;
    }

    // Get current formatted date and time
    const { time, date } = getCurrentDateTime();

    // Create new IoT data entry
    const iotData = new IOTData({
      energyValue: parseFloat(energyValue),
      energyProductId: energy_product_id,
      userName: userName.trim(),
      time,
      date
    });

    // Save to database
    const savedData = await iotData.save();
    console.log('💾 MQTT IoT data saved to database:', savedData);

    // Emit real-time update via Socket.IO
    if (global.io) {
      global.io.emit('newIoTData', {
        id: savedData._id,
        energyValue: savedData.energyValue,
        energyProductId: savedData.energyProductId,
        userName: savedData.userName,
        time: savedData.time,
        date: savedData.date,
        receivedAt: savedData.receivedAt
      });
      console.log('📡 Real-time MQTT update sent via Socket.IO');
    }

    return savedData;

  } catch (error) {
    console.error('❌ Error handling MQTT data:', error);
    return false;
  }
};

module.exports = {
  saveIOTData,
  getAllIOTData,
  getIOTDataByUser,
  getIOTDataByProductId,
  handleMQTTData
};
