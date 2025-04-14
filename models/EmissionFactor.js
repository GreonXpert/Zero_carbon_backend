const mongoose = require('mongoose');

const UnitSchema = new mongoose.Schema({
  type: String,
  kgCO2e: Number,
  kgCO2: Number,
  kgCH4: Number,
  kgN2O: Number,
  kgHFC: Number,
  kgPFC: Number,
  kgSF6: Number,
  kgNF3: Number 
});

const FuelSchema = new mongoose.Schema({
  name: String,
  units: [UnitSchema],
  reference: String,
  source: String
});

const ActivitySchema = new mongoose.Schema({
  name: String,
  fuels: [FuelSchema]
});

const EmissionFactorSchema = new mongoose.Schema({
  name: String,
  activities: [ActivitySchema]
});

module.exports = mongoose.model('EmissionFactor', EmissionFactorSchema);
