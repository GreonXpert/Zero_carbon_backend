const mongoose = require("mongoose");

const CalculateEmissionCO2eSchema = new mongoose.Schema({
  periodOfDate: { type: String, required: true }, // Example: "monthly"
  startDate: { type: String, required: true }, // Format: "dd/mm/yyyy"
  endDate: { type: String, required: true }, // Format: "dd/mm/yyyy"
  consumedData: { type: Number, required: true }, // Example: 10
  assessmentType: { type: String, required: true }, // Example: "AR6"
  uncertaintyLevelConsumedData: { type: Number, default: 0 }, // Example: 1 (percentage)
  uncertaintyLevelEmissionFactor: { type: Number, default: 0 }, // Example: 1 (percentage)
  emissionCO2: { type: Number, required: true },
  emissionN2O: { type: Number, required: true },
  emissionCH4: { type: Number, required: true },
  emissionCO2e: { type: Number, required: true },
  standards: { type: String, required: true }, // From `CalculationDataOfEmissionC02e`
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  comments: { type: String, default: "" }, // Comments provided by the user
  documents: { type: String, default: "" }, // Link or reference to document
  fuelSupplier: { type: String, default: "" }, // Fuel supplier details
}, { timestamps: true });

module.exports = mongoose.model("CalculateEmissionCO2e", CalculateEmissionCO2eSchema);
