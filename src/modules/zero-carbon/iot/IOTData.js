// models/IOTData.js
const mongoose = require('mongoose');

const IOTDataSchema = new mongoose.Schema({
  energyValue: {
    type: Number,
    required: true
  },
  energyProductId: {
    type: String,
    required: true
  },
  userName: {
    type: String,
    required: true
  },
  time: {
    type: String,
    required: true // Format: HH:MM:SS
  },
  date: {
    type: String,
    required: true // Format: DD/MM/YYYY
  },
  receivedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('IOTData', IOTDataSchema);
