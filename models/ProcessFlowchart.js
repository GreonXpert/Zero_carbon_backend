// models/ProcessFlowchart.js
const mongoose = require('mongoose');

// Copied from Flowchart.js to be used in ProcessFlowchart
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
  // 🆕 NEW REDUCTION SETUP FIELDS (for Reduction nodes only)
  reductionSetup: {
    // Initial setup values (entered once during flowchart creation)
    initialBE: { 
      type: Number, 
      default: 0,
      description: 'Initial Baseline Emissions (tCO2e) - calculated during setup'
    },
    initialPE: { 
      type: Number, 
      default: 0,
      description: 'Initial Project Emissions (tCO2e) - calculated during setup'
    },
    initialLE: { 
      type: Number, 
      default: 0,
      description: 'Initial Leakage Emissions (tCO2e) - calculated during setup'
    },
    initialBufferPercentage: { 
      type: Number, 
      default: 0,
      min: 0,
      max: 100,
      description: 'Initial Buffer percentage - entered during setup'
    },
    initialBufferEmissions: { 
      type: Number, 
      default: 0,
      description: 'Initial Buffer Emissions (tCO2e) - calculated during setup'
    },
    initialNetReduction: { 
      type: Number, 
      default: 0,
      description: 'Initial Net Reduction (tCO2e) - calculated during setup'
    },
    
    // 🔧 THE KEY FIELD: Unit Reduction Factor
    unitReductionFactor: { 
      type: Number, 
      default: 0,
      description: 'Reduction factor per unit (tCO2e per unit) - calculated as initialNetReduction ÷ initialPE'
    },
    
    // Setup metadata
    setupCompletedAt: { 
      type: Date,
      description: 'When the initial reduction setup was completed'
    },
    setupCompletedBy: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'User',
      description: 'User who completed the initial reduction setup'
    },
    
    // Track if setup is completed
    isSetupCompleted: { 
      type: Boolean, 
      default: false,
      description: 'Whether the initial reduction setup has been completed'
    },
    
    // Optional: Store the calculation details for reference
    setupCalculationDetails: {
      setupAPDValues: { 
        type: Map, 
        of: Number,
        description: 'Original APD values used for setup calculation'
      },
      setupABDValues: { 
        type: Map, 
        of: Number,
        description: 'Original ABD values used for setup calculation' 
      },
      setupALDValues: { 
        type: Map, 
        of: Number,
        description: 'Original ALD values used for setup calculation'
      },
      setupEmissionFactor: { 
        type: Number,
        description: 'Emission factor used during setup'
      },
      setupNotes: { 
        type: String,
        description: 'Additional notes about the setup calculation'
      }
    }
  },

  // 🆕 REDUCTION CALCULATION MODE
  reductionCalculationMode: {
    type: String,
    enum: ['simple', 'advanced'],
    default: 'advanced',
    description: 'Simple: PE × unitReductionFactor, Advanced: Include LE and Buffer calculations'
  },
  // After the customEmissionFactor field, add:
emissionFactorValues: {
  // For DEFRA
  defraData: {
   
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
   
    unit: { type: String },
    fuelDensityLiter: { type: Number, default: null },
    fuelDensityM3: { type: Number, default: null },
    ghgUnits: [{ 
      unit: { type: String },
      ghgconversionFactor: { type: Number },
      gwpValue: { type: Number, default: 0 },
      gwpSearchField: { type: String, default: null },
      gwpLastUpdated: { type: Date, default: null }

    }],
  },
  
  // For EPA
  epaData: {
   
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
      //fugitive emisson Activity === SF6
      GWP_SF6: {type:Number, default: null},
      //fugitive emission Activity === CH4_leaks
      EmissionFactorFugitiveCH4Leak:{ type: Number, default: null },
      GWP_CH4_leak: { type: Number, default: null },
      EmissionFactorFugitiveCH4Component: { type: Number, default: null },
      GWP_CH4_Component : { type: Number, default: null },

      //Scope 3 - Upstream Leased Assests 

      // BuildingTotalS1_S2:  { type: Number, default: null },

      // GWP values for custom emission factors
      CO2_gwp: { type: Number, default: null },
      CH4_gwp: { type: Number, default: null },
      N2O_gwp: { type: Number, default: null },
      CO2e_gwp: { type: Number, default: null },

      gwpLastUpdated: { type: Date, default: null },

      // ⬇️ ADD inside emissionFactorValues.customEmissionFactor (ProcessFlowchart.js)
CO2_comment:  { type: String, default: '' },
CH4_comment:  { type: String, default: '' },
N2O_comment:  { type: String, default: '' },
CO2e_comment: { type: String, default: '' },
unit_comment: { type: String, default: '' },

industryAverageEmissionFactor_comment: { type: String, default: '' },
stoichiometicFactor_comment:           { type: String, default: '' },
conversionEfficiency_comment:          { type: String, default: '' },

chargeType_comment:                    { type: String, default: '' },
leakageRate_comment:                   { type: String, default: '' },
Gwp_refrigerant_comment:               { type: String, default: '' },
GWP_fugitiveEmission_comment:          { type: String, default: '' },
GWP_SF6_comment:                       { type: String, default: '' },

EmissionFactorFugitiveCH4Leak_comment:      { type: String, default: '' },
GWP_CH4_leak_comment:                       { type: String, default: '' },
EmissionFactorFugitiveCH4Component_comment: { type: String, default: '' },
GWP_CH4_Component_comment:                  { type: String, default: '' },

CO2_gwp_comment:  { type: String, default: '' },
CH4_gwp_comment:  { type: String, default: '' },
N2O_gwp_comment:  { type: String, default: '' },
CO2e_gwp_comment: { type: String, default: '' },

    },
  // Emission factor value // For EmissionFactorHub
    emissionFactorHubData: {
      scope:{type:String},
      category: { type: String },
      activity: { type: String },
      itemName: {type: String},
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
    enum: ['DEFRA','IPCC','EPA','EmissionFactorHub','Custom', 'Country','country', ''],
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
      customValues: {
    assetLifetime:         { type: Number, default: null },
    TDLossFactor:          { type: Number, default: null },
    defaultRecyclingRate:  { type: Number, default: null },
    equitySharePercentage: { type: Number, default: null },
    averageLifetimeEnergyConsumption: { type: Number, default: null }, // a.k.a averageLifetimeEnergyConsumption
    usePattern: { type: String, default: null }, // a.k.a UsePattern
    energyEfficiency: { type: Number, default: null }, // a.k.a EnergyEfficiency
     toIncineration: { type: Number, default: null }, // a.k.a ToIncineration
    toLandfill: { type: Number, default: null }, // a.k.a ToLandfill
    toDisposal: { type: Number, default: null } // a.k.a toDisposal

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
     TypeOfNode: {
    type: String,
    enum: ['Emission Source', 'Reduction'],
    default: 'Emission Source',
    description: 'Type of node means which type of data collection and calculation is going to be performed here'
  },
    department: { type: String },
    location: { type: String },
    longitude: { type: Number, default: null },
    latitude: { type: Number, default: null },
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
  sourcePosition: { type: String, required: true },
  targetPosition: { type: String, required: true },
});

const ProcessFlowchartSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  nodes: [NodeSchema],
  edges: [EdgeSchema],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lastModifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date },
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  version: { type: Number, default: 1 },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

// ** NEW CODE: Pre-save hook for edge validation **
ProcessFlowchartSchema.pre('save', function(next) {
  const flowchart = this;
  const MIN_EDGES_PER_NODE = 1;

  // If there are no nodes, no need to validate
  if (!flowchart.nodes || flowchart.nodes.length === 0) {
    return next();
  }

  const edgeCounts = new Map();
  
  // Initialize edge counts for all nodes to 0
  for (const node of flowchart.nodes) {
    edgeCounts.set(node.id, 0);
  }

  // Count edges for each node
  for (const edge of flowchart.edges) {
    if (edgeCounts.has(edge.source)) {
      edgeCounts.set(edge.source, edgeCounts.get(edge.source) + 1);
    }
    if (edgeCounts.has(edge.target)) {
      edgeCounts.set(edge.target, edgeCounts.get(edge.target) + 1);
    }
  }

  // Check if any node has fewer than the minimum required edges
  const invalidNodes = [];
  for (const node of flowchart.nodes) {
    const count = edgeCounts.get(node.id) || 0;
    if (count < MIN_EDGES_PER_NODE) {
      invalidNodes.push(`Node "${node.label}" (ID: ${node.id}) has only ${count} edge(s), but requires ${MIN_EDGES_PER_NODE}.`);
    }
  }

  if (invalidNodes.length > 0) {
    // If validation fails, pass an error to the next middleware (the save operation)
    const error = new Error(`Validation failed: ${invalidNodes.join(' ')}`);
    error.statusCode = 400; // Bad Request
    return next(error);
  }

  // If all nodes are valid, proceed with the save operation
  next();
});


ProcessFlowchartSchema.index({ clientId: 1, isDeleted: 1 });

module.exports = mongoose.model('ProcessFlowchart', ProcessFlowchartSchema);
