const mongoose = require('mongoose');

const EmissionFactorHubSchema = new mongoose.Schema({
  scope:{
     type: String,
    required: true,
    trim: true
  },
  category: {
    type: String,
    required: true,
    trim: true
  },
  activity: {
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
  'rupee', 'rupees', 'inr', '₹',
  'dirham', 'dirhams', 'aed', 'dh',
  'riyal', 'riyals', 'sar', 'sr',
  'dinar', 'dinars', 'kwd', 'bhd', 'jod',
  'singapore dollar', 'singapore dollars', 'sgd', 's$',
  'ringgit', 'malaysian ringgit', 'myr', 'rm',
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
  Co2e: {
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
EmissionFactorHubSchema.index({ category: 1, activity: 1, itemName: 1 });
EmissionFactorHubSchema.index({ category: 1 });
EmissionFactorHubSchema.index({ itemName: 1 });

module.exports = mongoose.model('EmissionFactorHub', EmissionFactorHubSchema);