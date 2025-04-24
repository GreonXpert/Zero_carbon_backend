// models/CalculateEmissionCO2e.js

const mongoose = require("mongoose");

const CalculateEmissionCO2eSchema = new mongoose.Schema({
  siteId: { type: String },             // ← now optional
  periodOfDate: { type: String, required: true },
  startDate:    { type: String, required: true },
  endDate:      { type: String, required: true },
  consumedData: { type: Number, required: true },
  assessmentType:                 { type: String, required: true },
  uncertaintyLevelConsumedData:   { type: Number, default: 0 },
  uncertaintyLevelEmissionFactor: { type: Number, default: 0 },
  emissionCO2:  { type: Number, required: true },
  emissionCH4:  { type: Number, required: true },
  emissionN2O:  { type: Number, required: true },
  emissionCO2e: { type: Number, required: true },
  standards:  { type: String, required: true },
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  comments:   { type: String, default: "" },
  documents:  { type: String, default: "" },
  fuelSupplier: { type: String, default: "" },

  // embed the nodes & edges at time of calculation
  flowchartNodes: { type: [mongoose.Schema.Types.Mixed], default: [] },
  flowchartEdges: { type: [mongoose.Schema.Types.Mixed], default: [] },

  // full raw inputs, with per-entry emissions
  rawData: { type: [mongoose.Schema.Types.Mixed], default: [] }
}, { timestamps: true });

module.exports = mongoose.model("CalculateEmissionCO2e", CalculateEmissionCO2eSchema);
