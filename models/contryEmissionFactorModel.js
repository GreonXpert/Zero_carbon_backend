const mongoose = require('mongoose');

const CountryEmissionFactorSchema = new mongoose.Schema({
    country: { type: String, required: true },
    regionGrid: { type: String, required: true },
    emissionFactor: { type: String, required: true }, // tCO2/MWh
    reference: { type: String, default: "" },
    unit: { type: String, default: 'kWh' },
    yearlyValues: [
        {
            from: { type: String, required: true }, // dd/mm/yyyy
            to: { type: String, required: true },   // dd/mm/yyyy
            periodLabel: { type: String, required: true }, // e.g., march-2020 to march-2021
            value: { type: Number, required: true }
        }
    ]
}, { timestamps: true });

module.exports = mongoose.model('CountryEmissionFactor', CountryEmissionFactorSchema);
