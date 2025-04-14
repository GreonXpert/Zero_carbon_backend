const mongoose = require('mongoose');

const CalculationOfElectricitySchema = new mongoose.Schema({
  scopeDetail: { type: String, required: true }, // Example: "Scope 2"
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // Reference to User
  country: { type: String, required: true }, // Example: "India"
  region: { type: String, required: true }, // Example: "Indian Grid"
  emissionFactor: { type: String, required: true }, // Example: "Grid Emission Factor"
  consumedAmount: { type: Number, required: true }, // Example: 100 (MWh)
  periodOfDate: { type: String, required: true }, // Example: "monthly", "2-months", "yearly"
  startDate: { type: String, required: true }, // Format: "dd/mm/yyyy"
  endDate: { type: String, required: true }, // Format: "dd/mm/yyyy"
  uncertaintyLevelConsumedData: { type: Number, default: 0 }, // Example: 2 (percentage)
  uncertaintyLevelEmissionFactor: { type: Number, default: 0 }, // Example: 1 (percentage)
  emissionCO2e: { type: Number, required: true }, // Calculated CO2e Emission
  billAmount:{type: Number, default: 0, required: true}
}, { timestamps: true });

module.exports = mongoose.model('CalculationOfElectricity', CalculationOfElectricitySchema);
