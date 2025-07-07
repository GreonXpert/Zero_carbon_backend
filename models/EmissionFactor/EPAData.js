const mongoose = require('mongoose');

//Schema for conversion factor of EPA data history
const ConversionFactorEPAHistorySchema = new mongoose.Schema({
  oldValue: { type: Number, required: true },
  newValue: { type: Number, required: true },
  changedAt: { type: Date, default: Date.now },
  changedBy: { type: String }
});

//Main EPA Data Schema
const EPADataSchema = new mongoose.Schema({
    scopeEPA: {
        type: String,
        required: true
    },
    level1EPA: { type: String, required: true },
    level2EPA: { type: String, default: '' },  
    level3EPA: { type: String, default: '' },
    level4EPA: { type: String, default: '' },  
    columnTextEPA: { type: String, default: '' },
    uomEPA: { type: String, required: true }, // Unit of Measure
    ghgUnitEPA: { 
        type: String, 
        required: true
        // Removed enum restriction to allow all GHG unit types
    },
    ghgConversionFactorEPA: { type: Number, required: true },
    conversionFactorHistoryEPA: [ConversionFactorEPAHistorySchema],
    createdBy: { type: String },
    updatedBy: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});


// Compound index for uniqueness (excluding ghgConversionFactor)
EPADataSchema.index({ 
    scopeEPA: 1, 
    level1EPA: 1, 
    level2EPA: 1, 
    level3EPA: 1, 
    level4EPA: 1, 
    columnTextEPA: 1,
    uomEPA: 1, 
    ghgUnitEPA: 1 
}, { unique: true });

// Pre-save middleware to update timestamps
EPADataSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

// Method to check if conversion factor changed
EPADataSchema.methods.hasConversionFactorChangedEPA = function(newFactor) {
    return this.ghgConversionFactorEPA !== newFactor;
}       

// Method to update conversion factor with history
EPADataSchema.methods.updateConversionFactorEPA = function(newFactor, updatedBy) {
    if (this.hasConversionFactorChangedEPA(newFactor)) {
        // Add to history
        this.conversionFactorHistoryEPA.push({
            oldValue: this.ghgConversionFactorEPA,
            newValue: newFactor,
            changedAt: Date.now(),
            changedBy: updatedBy
        });
        // Update the conversion factor
        this.ghgConversionFactorEPA = newFactor;
        this.updatedBy = updatedBy;
        return true;
    }
    return false;
}

module.exports = mongoose.model('EPAData', EPADataSchema);