const mongoose = require('mongoose');

const CountryEmissionFactorSchema = new mongoose.Schema({
  country: { type: String, required: true },
  regionGrid: { type: String, required: true },
  emissionFactor: { type: String, required: true },
  reference: { type: String, default: "" },
  unit: { type: String, default: "kWh" },
  yearlyValues: [
    {
      from: { type: String, required: true },
      to: { type: String, required: true },
      periodLabel: { type: String, required: true },
      value: { type: Number, required: true }
    }
  ]
}, { timestamps: true });

module.exports = mongoose.model('CountryEmissionFactor', CountryEmissionFactorSchema);