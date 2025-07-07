const mongoose = require('mongoose');

// Schema for conversion factor history
const ConversionFactorHistorySchema = new mongoose.Schema({
  oldValue: { type: Number, required: true },
  newValue: { type: Number, required: true },
  changedAt: { type: Date, default: Date.now },
  changedBy: { type: String }
});

// Main DEFRA Data Schema
const DefraDataSchema = new mongoose.Schema({
  scope: { 
    type: String, 
    required: true
  },
  level1: { type: String, required: true },
  level2: { type: String, default: '' },
  level3: { type: String, default: '' },
  level4: { type: String, default: '' },
  columnText: { type: String, default: ''  },
  uom: { type: String, required: true }, // Unit of Measure
  ghgUnit: { 
    type: String, 
    required: true
    // Removed enum restriction to allow all GHG unit types
  },
  ghgConversionFactor: { type: Number, required: true },
  conversionFactorHistory: [ConversionFactorHistorySchema],
  createdBy: { type: String },
  updatedBy: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Compound index for uniqueness (excluding ghgConversionFactor)
DefraDataSchema.index({ 
  scope: 1, 
  level1: 1, 
  level2: 1, 
  level3: 1, 
  level4: 1, 
  columnText: 1,
  uom: 1, 
  ghgUnit: 1 
}, { unique: true });

// Pre-save middleware to update timestamps
DefraDataSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Method to check if conversion factor changed
DefraDataSchema.methods.hasConversionFactorChanged = function(newFactor) {
  return this.ghgConversionFactor !== newFactor;
};

// Method to update conversion factor with history
DefraDataSchema.methods.updateConversionFactor = function(newFactor, updatedBy) {
  if (this.hasConversionFactorChanged(newFactor)) {
    this.conversionFactorHistory.push({
      oldValue: this.ghgConversionFactor,
      newValue: newFactor,
      changedBy: updatedBy
    });
    this.ghgConversionFactor = newFactor;
    this.updatedBy = updatedBy;
    return true;
  }
  return false;
};

module.exports = mongoose.model('DefraData', DefraDataSchema);