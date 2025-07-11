const mongoose = require('mongoose');

const ScopeDetailSchema = new mongoose.Schema({
  // Unique identifier for each scope detail entry
  scopeIdentifier: { 
    type: String, 
    required: true,
    description: 'Unique name/identifier to distinguish between multiple same scope types'
  },
  
  // Scope type (Scope 1, Scope 2, Scope 3)
  scopeType: { 
    type: String, 
    required: true,
    enum: ['Scope 1', 'Scope 2', 'Scope 3']
  },
  
  
  // Input type for this specific scope detail
  inputType: {
    type: String,
    required: true,
    enum: ['manual', 'IOT', 'API'],
    default: 'manual',
    description: 'Data input method for this specific scope'
  },
  
  // Whether this scope is connected to API/IOT
  apiStatus: { 
    type: Boolean, 
    default: false 
  },
  apiEndpoint: { 
    type: String, 
    default: '' 
  },
  iotStatus: { 
    type: Boolean, 
    default: false 
  },
  iotDeviceId: { 
    type: String, 
    default: '' 
  },
  calculationModel:{
    type: String,
    enum:['tier 1', 'tier 2', 'tier 3'],
    default: 'tier 1',
  },
  emissionFactor: { 
    type: String,
    enum: ['IPCC', 'DEFRA', 'EPA', 'EmissionFactorHub','Custom','Country', ''],
    default: '',
    description: 'Emission factor standard used'
  },
  // After the customEmissionFactor field, add:
emissionFactorValues: {
  // For DEFRA
  defraData: {
    scope: { type: String },
    level1: { type: String },
    level2: { type: String },
    level3: { type: String },
    level4: { type: String },
    columnText: { type: String },
    uom: { type: String },
    ghgUnits: [{ 
      unit: { type: String },
      ghgconversionFactor: { type: Number },
      gwpValue: { type: Number, default: 0 },
      gwpSearchField: { type: String, default: null },
      gwpLastUpdated: { type: Date, default: null }

    }],
   
  },
  
  // For IPCC
  ipccData: {
    level1: { type: String },
    level2: { type: String },
    level3: { type: String },
    cpool: { type: String },
    typeOfParameter: { type: String },
    unit: { type: String },
    value: { type: Number },
    description: { type: String },
    gwpValue: { type: Number, default: 0 },
      gwpSearchField: { type: String, default: null },
      gwpLastUpdated: { type: Date, default: null }
  },
  
  // For EPA
  epaData: {
    scopeEPA: { type: String },
    level1EPA: { type: String },
    level2EPA: { type: String },
    level3EPA: { type: String },
    level4EPA: { type: String },
    columnTextEPA: { type: String },
    uomEPA: { type: String },
    ghgUnitsEPA: [{
      unit: { type: String },
      ghgconversionFactor: { type: Number },
       gwpValue: { type: Number, default: 0 },
      gwpSearchField: { type: String, default: null },
      gwpLastUpdated: { type: Date, default: null }
    }],
    
  },
   countryData: {
      C: String,
      regionGrid: String,
      emissionFactor: String,
      reference: String,
      unit: String,
      yearlyValues: [{
        from: String,       // dd/mm/yyyy
        to: String,         // dd/mm/yyyy
        periodLabel: String,
        value: Number
      }]
    },

     customEmissionFactor: {
      CO2:  { type: Number, default: null },
      CH4:  { type: Number, default: null },
      N2O:  { type: Number, default: null },
      CO2e: { type: Number, default: null },
      unit: { type: String, default: '' },
      // Process Emission value 
      industryAverageEmissionFactor: { type: Number, default: null },
      stoichiometicFactor: { type: Number, default: null },
      conversionEfficiency: { type: Number, default: null },
     

      // fugitive emission Factor Values 
      chargeType: { type: String, default: '' },
      leakageRate: { type: Number, default: null },
      Gwp_refrigerant: { type: Number, default: '' },
      GWP_fugitiveEmission: { type: Number, default: null },

      // GWP values for custom emission factors
      CO2_gwp: { type: Number, default: 0 },
      CH4_gwp: { type: Number, default: 0 },
      N2O_gwp: { type: Number, default: 0 },
      gwpLastUpdated: { type: Date, default: null }
    },
  // Emission factor value // For EmissionFactorHub
    emissionFactorHubData: {
      factorId: { type: String },
      factorName: { type: String },
      category: { type: String },
      subcategory: { type: String },
      unit: { type: String },
      value: { type: Number },
      source: { type: String },
      reference: { type: String },
      // ADD GWP VALUE FOR EMISSIONFACTORHUB
      gwpValue: { type: Number, default: 0 },
      gwpSearchField: { type: String, default: null },
      gwpLastUpdated: { type: Date, default: null }
    },
  
  // Common metadata
  dataSource: {
    type: String,
    enum: ['DEFRA','IPCC','EPA','EmissionFactorHub','Custom', 'Country','country' ''],
    description: 'Source database for emission factor'
  },
  lastUpdated: { type: Date, default: Date.now }
},
  // Add these two new fields for uncertainty values
  UAD: {
    type: Number,
    default: 0,
    description: 'Activity Data Uncertainty percentage'
  },
  UEF: {
    type: Number,
    default: 0,
    description: 'Emission Factor Uncertainty percentage'
  },
  
  categoryName: { 
    type: String,
    description: 'Category name (e.g., Energy Industries, Manufacturing Industries)'
  },
  activity: { 
    type: String,
    description: 'Specific activity (e.g., 1.A.1 - Energy Industries)'
  },
  fuel: { 
    type: String,
    description: 'Fuel type (e.g., Aviation Gasoline, Diesel Oil)'
  },
  units: { 
    type: String,
    description: 'Measurement units (e.g., kg, litres, tonnes)'
  },
  
  // Scope 2 specific fields
  country: { type: String },
  regionGrid: { type: String },
  electricityUnit: { 
    type: String,
    enum: ['Wh', 'kWh', 'MWh', 'GWh', 'TWh', ''],
    default: '',
    description: 'Electricity consumption unit'
  },
  
  // Scope 3 specific fields
  scope3Category: { 
    type: String,
    description: 'Scope 3 category (e.g., Purchased goods and services)'
  },
  activityDescription: { type: String },
  itemName: { type: String },
  scope3Unit: { 
    type: String,
    description: 'Unit for Scope 3 (e.g., kg, tonnes, dollars)'
  },
  
  // Common fields
  description: { type: String },
  source: { 
    type: String,
    description: 'Data source (e.g., DEFRA Dataset 2025, IPCC Guidelines)'
  },
  reference: { 
    type: String,
    description: 'Reference URL or document'
  },
  
  // Data collection frequency
  collectionFrequency: {
    type: String,
    enum: ['real-time', 'daily', 'weekly', 'monthly', 'quarterly', 'annually'],
    default: 'monthly'
  },
  
  additionalInfo: { type: mongoose.Schema.Types.Mixed },

  // who the Employee Head assigned this scope to
  assignedEmployees: [{
  type: mongoose.Schema.Types.ObjectId,
  ref: 'User'
}]
});

// Add a pre-save hook to validate custom emission factor
ScopeDetailSchema.pre('save', function(next) {
  if (this.emissionFactor === 'Custom' && this.scopeType === 'Scope 1') {
    // Validate that at least one custom emission factor is provided
    const customFactors = this.customEmissionFactor;
    if (!customFactors.CO2 && !customFactors.CH4 && !customFactors.N2O && !customFactors.CO2e) {
      return next(new Error('When using Custom emission factor, at least one of CO2, CH4, N2O, or CO2e must be provided'));
    }
  }
  next();
});

const NodeSchema = new mongoose.Schema({
  id: { type: String, required: true },
  label: { type: String, required: true },
  position: {
    x: { type: Number, required: true },
    y: { type: Number, required: true },
  },
  parentNode: { type: String, default: null },
  
  // Node details
  details: {
    // Node-level properties
    nodeType: { 
      type: String,
      description: 'Type of node (e.g., facility, department, process)'
    },
    department: { type: String },
    location: { type: String },
     // ← here ↓
  employeeHeadId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    description: 'The User._id of the Employee Head responsible for this node'
  },
    
    // Array of scope details - each with its own input type
    scopeDetails: [ScopeDetailSchema],
    
    // Node metadata
    additionalDetails: { type: mongoose.Schema.Types.Mixed, default: {} }
  }
});

const EdgeSchema = new mongoose.Schema({
  id: { type: String, required: true },
  source: { type: String, required: true },
  target: { type: String, required: true },
});

const FlowchartSchema = new mongoose.Schema({
  // Client ID this flowchart belongs to
  clientId: { 
    type: String, 
    required: true,
    index: true 
  },
  
  // User who created the flowchart
  createdBy: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  }, 
  
  // User type who created (for quick filtering)
  creatorType: {
    type: String,
    required: true,
    enum: ['super_admin', 'consultant_admin', 'consultant']
  },
  
  // Track last modification
  lastModifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  nodes: [NodeSchema],
  edges: [EdgeSchema],
  
  // Metadata
  version: { type: Number, default: 1 },
  isActive: { type: Boolean, default: true }
}, {
  timestamps: true
});

// Indexes for performance
FlowchartSchema.index({ clientId: 1, createdBy: 1 });
FlowchartSchema.index({ creatorType: 1 });

// IMPORTANT: Remove any existing unique index on edges.id
// This prevents the E11000 duplicate key error when edges array is empty
FlowchartSchema.index({ 'edges.id': 1 }, { sparse: true });

const Flowchart = mongoose.model('Flowchart', FlowchartSchema);

module.exports = Flowchart;