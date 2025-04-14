const mongoose = require('mongoose');

const CalculationDataOfEmissionC02eSchema = new mongoose.Schema({
  scopeDetails: { type: String, required: true }, // Example: "scope1"
  combustionType: { type: String, required: true }, // Example: "Stationary Combustion"
  standards: { type: String, required: true }, // Example: "IPCC"
  activity: { type: String, required: true }, // Example: "1.A.1 - Energy Industries"
  fuel: { type: String, required: true }, // Example: "Aviation Gasoline"
  unit: { type: String, required: true }, // Example: "KgL"
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // Reference to User
  source: { type: String, required: true }, // Example: "DEFRA Dataset 2025"
  reference: { type: String, required: true }, // Example: "https://example.com/defra-data"
}, { timestamps: true });

module.exports = mongoose.model('CalculationDataOfEmissionC02e', CalculationDataOfEmissionC02eSchema);
