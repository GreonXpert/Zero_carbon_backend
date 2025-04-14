const mongoose = require("mongoose");

const TotalEmissionCO2eSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  period: { type: String, required: true }, // Example: "monthly" or "yearly"
  periodValue: { type: String, required: true }, // Example: "01/2025" for monthly, "2025" for yearly
  totalEmissionCO2e: { type: Number, required: true },
  totalEmissionCO2: { type: Number, required: true },
  totalEmissionCH4: { type: Number, required: true },
  totalEmissionN2O: { type: Number, required: true },
  cumulativeEmissionCO2e: { type: Number, required: true }, // Cumulative total CO2e till this period
  cumulativeEmissionCO2: { type: Number, required: true }, // Cumulative total CO2
  cumulativeEmissionCH4: { type: Number, required: true }, // Cumulative total CH4
  cumulativeEmissionN2O: { type: Number, required: true }, // Cumulative total N2O
}, { timestamps: true });

module.exports = mongoose.model("TotalEmissionCO2e", TotalEmissionCO2eSchema);
