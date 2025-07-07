const mongoose = require('mongoose');

// History schema to track updates
const HistorySchema = new mongoose.Schema({
   oldValue: { type: Number, required: true },
  newValue: { type: Number, required: true },
  changedAt: { type: Date, default: Date.now },
  changedBy: { type: String }
});


const IPCCDataSchema = new mongoose.Schema({
  // Hierarchical levels
  level1: { 
    type: String, 
    trim: true,
     default: ''
  },
  level2: { 
    type: String, 
    trim: true,
     default: ''
  },
  level3: { 
    type: String, 
    trim: true,
     default: ''
  },
  
  // Core fields
  Cpool: { 
    type: String,
    trim: true,
    default: ''
  },
  TypeOfParameter: { 
    type: String, 
    trim: true,
    default: ''
  },
  Description: { 
    type: String,
    trim: true,
    default: ''
  },
  TechnologiesOrPractices: { 
    type: String,
    trim: true,
    default: ''
  },
  ParametersOrConditions: { 
    type: String,
    trim: true,
    default: ''
  },
  RegionOrRegionalConditions: { 
    type: String,
    trim: true,
    default: ''
  },
  AbatementOrControlTechnologies: { 
    type: String,
    trim: true,
    default: ''
  },
  OtherProperties: { 
    type: String,
    trim: true,
    default: ''
  },
  
  // Value and measurement
  Value: { 
    type: Number, 
    required: true,
    default: 0
  },
  Unit: { 
    type: String, 
    required: true,
    trim: true,
    default: ''
  },
  Equation: { 
    type: String,
    trim: true,
    default: ''
  },
  
  // Reference information
  IPCCWorksheet: { 
    type: String,
    trim: true,
    default: ''
  },
  TechnicalReference: { 
    type: String,
    trim: true,
    default: ''
  },
  SourceOfData: { 
    type: String,
    trim: true,
    default: ''
  },
  DataProvider: { 
    type: String,
    trim: true,
    default: ''
  },
  
  createdBy: { type: String },
  updatedBy: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  // History tracking
  history: [HistorySchema],
  
  // Status for soft delete
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Compound index to check for duplicates
IPCCDataSchema.index({
  level1: 1,
  level2: 1,
  level3: 1,
  Cpool: 1,
  TypeOfParameter: 1,
  TechnologiesOrPractices: 1,
  ParametersOrConditions: 1,
  RegionOrRegionalConditions: 1,
  AbatementOrControlTechnologies: 1,
  Value: 1,
  Unit: 1
});

IPCCDataSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});
// Method to check if duplicate exists
IPCCDataSchema.statics.checkDuplicate = async function(data, excludeId = null) {
  const query = {
    level1: data.level1,
    level2: data.level2,
    level3: data.level3,
    Cpool: data.Cpool || null,
    TypeOfParameter: data.TypeOfParameter,
    TechnologiesOrPractices: data.TechnologiesOrPractices || null,
    ParametersOrConditions: data.ParametersOrConditions || null,
    RegionOrRegionalConditions: data.RegionOrRegionalConditions || null,
    AbatementOrControlTechnologies: data.AbatementOrControlTechnologies || null,
    Value: data.Value,
    Unit: data.Unit,
    isActive: true
  };
  
  if (excludeId) {
    query._id = { $ne: excludeId };
  }
  
  const duplicate = await this.findOne(query);
  return duplicate;
};

// Method to add history
IPCCDataSchema.methods.addHistory = function(userId, action, changedFields = {}, previousValues = {}) {
  this.history.push({
    updatedBy: userId,
    action,
    changedFields: new Map(Object.entries(changedFields)),
    previousValues: new Map(Object.entries(previousValues))
  });
};
// helper to push a history entry
IPCCDataSchema.methods.recordHistory = function(userId, oldObj = {}, newObj = {}) {
  this.history.push({
    oldValue: new Map(Object.entries(oldObj)),
    newValue: new Map(Object.entries(newObj)),
    changedBy: userId
  });
};

IPCCDataSchema.methods.hasValueChanged = function(newValue) {
  return this.Value !== newValue;
};

IPCCDataSchema.methods.updateValue = function(newValue, updatedBy) {
  if (this.hasValueChanged(newValue)) {
    this.history.push({
      oldValue: this.Value,
      newValue: newValue,
      changedBy: updatedBy
    });
    this.Value = newValue;
    this.updatedBy = updatedBy;
    return true;
  }
  return false;
};

module.exports = mongoose.model('IPCCData', IPCCDataSchema);