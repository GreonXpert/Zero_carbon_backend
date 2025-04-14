const mongoose = require("mongoose");

const TotalEmissionElectricitySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  period: { type: String, required: true }, // Example: "monthly" or "yearly"
  periodValue: { type: String, required: true }, // Example: "01/2025" for monthly, "2025" for yearly
  totalEmissionCO2e: { type: Number, required: true }, // Total calculated CO2e emissions
  cumulativeEmissionCO2e: { type: Number, required: true }, // Cumulative total CO2e till this period
}, { timestamps: true });

module.exports = mongoose.model("TotalEmissionElectricity", TotalEmissionElectricitySchema);
