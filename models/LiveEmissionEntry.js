// models/LiveEmissionEntry.js
const mongoose = require('mongoose');

const LiveEmissionEntrySchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  nodeId:   { type: String, required: true },   // reference to flowchart node ID (site)
  quantity: { type: Number, required: true },   // raw data input value
  emissionCO2:  { type: Number, required: true },
  emissionCH4:  { type: Number, required: true },
  emissionN2O:  { type: Number, required: true },
  emissionCO2e: { type: Number, required: true },
  timestamp:    { type: Date, default: Date.now } // explicit timestamp of entry
}, { timestamps: true });

// TTL index: auto-delete entries 30 days after creation
LiveEmissionEntrySchema.index({ createdAt: 1 }, { expireAfterSeconds: 2592000 }); // 30 days

module.exports = mongoose.model('LiveEmissionEntry', LiveEmissionEntrySchema);
