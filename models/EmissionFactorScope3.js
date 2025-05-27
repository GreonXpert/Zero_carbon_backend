const mongoose = require('mongoose');

const EmissionFactorScope3Schema = new mongoose.Schema({
  category: {
    type: String,
    required: true,
    trim: true
  },
  activityDescription: {
    type: String,
    required: true,
    trim: true
  },
  itemName: {
    type: String,
    required: true,
    trim: true
  },
  unit: {
    type: String,
    required: true,
    enum: [
      'dollar', 'dollars', 'usd', '$',
      'number', 'count', 'pieces',
      'tonnes', 'tons', 'tonne', 'ton',
      'kg', 'kilogram', 'kilograms',
      'litter', 'litre', 'litres', 'liter', 'liters', 'l',
      'gallon', 'gallons', 'gal',
      'km', 'kilometer', 'kilometers',
      'mile', 'miles',
      'kwh', 'kWh', 'mwh', 'MWh',
      'cubic_meter', 'm3', 'm³',
      'square_meter', 'm2', 'm²',
      'hour', 'hours', 'hr', 'hrs',
      'passenger-km', 'pkm',
      'tonne-km', 'tkm',
      'other'
    ]
  },
  emissionFactor: {
    type: Number,
    required: true,
    min: 0
  },
  source: {
    type: String,
    required: true,
    trim: true
  },
  reference: {
    type: String,
    default: '',
    trim: true
  },
  year: {
    type: Number,
    default: new Date().getFullYear()
  },
  region: {
    type: String,
    default: 'Global',
    trim: true
  },
  notes: {
    type: String,
    default: '',
    trim: true
  }
}, {
  timestamps: true
});

// Create compound index for efficient searching
EmissionFactorScope3Schema.index({ category: 1, activityDescription: 1, itemName: 1 });
EmissionFactorScope3Schema.index({ category: 1 });
EmissionFactorScope3Schema.index({ itemName: 1 });

module.exports = mongoose.model('EmissionFactorScope3', EmissionFactorScope3Schema);