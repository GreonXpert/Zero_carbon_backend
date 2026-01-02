// models/ApiKeyRequest.js
const mongoose = require('mongoose');

const ApiKeyRequestSchema = new mongoose.Schema({
  clientId: String,
  keyType: { type: String, enum: ['DC_API','DC_IOT','NET_API','NET_IOT'] },
  nodeId: String,
  scopeIdentifier: String,
  projectId: String,
  calculationMethodology: String,

  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: ['pending','approved','rejected'], default:'pending' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ApiKeyRequest', ApiKeyRequestSchema);
