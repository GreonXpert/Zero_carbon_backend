const mongoose = require("mongoose");

// Sub-schema for data input points
const DataInputPointSchema = new mongoose.Schema({
  pointId: { type: String, required: true },
  pointName: { type: String, required: true },
  nodeId: { type: String }, // Reference to flowchart node
  scopeIdentifier: { type: String }, // Reference to scope within node
  status: {
    type: String,
    enum: ["not_started", "on_going", "pending", "completed"],
    default: "not_started"
  },
  trainingCompletedFor: { type: String }, // For manual inputs - employee name/ID
  lastUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  lastUpdatedAt: { type: Date }
});

// Sub-schema for API input points
const APIInputPointSchema = new mongoose.Schema({
  pointId: { type: String, required: true },
  endpoint: { type: String, required: true },
  nodeId: { type: String },
  scopeIdentifier: { type: String },
  status: {
    type: String,
    enum: ["not_started", "on_going", "pending", "completed"],
    default: "not_started"
  },
  connectionStatus: {
    type: String,
    enum: ["not_connected", "testing", "connected", "failed"],
    default: "not_connected"
  },
  lastConnectionTest: { type: Date },
  lastUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  lastUpdatedAt: { type: Date }
});

// Sub-schema for IoT input points
const IoTInputPointSchema = new mongoose.Schema({
  pointId: { type: String, required: true },
  deviceName: { type: String, required: true },
  deviceId: { type: String },
  nodeId: { type: String },
  scopeIdentifier: { type: String },
  status: {
    type: String,
    enum: ["not_started", "on_going", "pending", "completed"],
    default: "not_started"
  },
  connectionStatus: {
    type: String,
    enum: ["not_connected", "configuring", "connected", "disconnected"],
    default: "not_connected"
  },
  lastDataReceived: { type: Date },
  lastUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  lastUpdatedAt: { type: Date }
});

// ✅ Add this near your other sub-schemas
const ProjectProfileSchema = new mongoose.Schema({
  projectName:   { type: String, required: true, trim: true },
  projectType:   { type: String, required: true, trim: true },
  description:   { type: String, default: '', trim: true },
}, { _id: false });

const DetailsforEmissonProfile = new mongoose.Schema({
  sourceName:         { type: String, default: "" },
  description:  { type: String, default: "" },
  facility: { type: String, default: "" },
  emissionDataTypes: {type: String, default: "" },
  relevantDepartment: { type: String, default: "" },
}, { _id: false });
const CategoryDetailsSchema = new mongoose.Schema(
  { details: DetailsforEmissonProfile },
  { _id: false }
);
const clientSchema = new mongoose.Schema(
  {
    clientId: {
      type: String,
      unique: true,
      required: true,
      index: true
    },
    // ===== NEW: SANDBOX FLAG =====
    sandbox: { 
      type: Boolean, 
      default: false 
    },
    
    stage: {
      type: String,
      enum: ["lead", "registered", "proposal", "active"],
      default: "lead",
      required: true
    },
    
    status: {
      type: String,
      enum: [
        // Lead statuses
        "contacted", "moved_to_next_stage",
        // Registered statuses
        "pending", "submitted", "rejected", "moved_to_proposal",
        // Proposal statuses
        "proposal_pending", "proposal_submitted", "proposal_rejected", "proposal_accepted",
        // Active statuses
        "active", "suspended", "expired", "renewed",
        //
        "submission_deleted", "proposal_deleted"
      ],
      default: "contacted"
    },

    // Workflow tracking fields
    workflowTracking: {
      // Flowchart status
      flowchartStatus: {
        type: String,
        enum: ["not_started", "on_going", "pending", "completed"],
        default: "not_started"
      },
      flowchartStartedAt: { type: Date },
      flowchartCompletedAt: { type: Date },
      
      // Process flowchart status
      processFlowchartStatus: {
        type: String,
        enum: ["not_started", "on_going", "pending", "completed"],
        default: "not_started"
      },
      processFlowchartStartedAt: { type: Date },
      processFlowchartCompletedAt: { type: Date },
      
      reduction: {
        status: {
          type: String,
          enum: ["not_started", "on_going", "pending", "completed"],
          default: "not_started"
        },
        startedAt: { type: Date },
        completedAt: { type: Date },
        projects: {
          totalCount:      { type: Number, default: 0 },
          activeCount:     { type: Number, default: 0 },
          completedCount:  { type: Number, default: 0 },
          pendingCount:    { type: Number, default: 0 },
          lastProjectCreatedAt: { type: Date }
        },
         // New: counts by data input type on Reduction projects
        dataInputPoints: {
          manual: { totalCount: { type: Number, default: 0 } },
          api:    { totalCount: { type: Number, default: 0 } },
          iot:    { totalCount: { type: Number, default: 0 } },
          totalDataPoints: { type: Number, default: 0 }
        }
      },

      // Assigned consultant
      assignedConsultantId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      consultantAssignedAt: { type: Date },
      
      // Data input points tracking
      dataInputPoints: {
        // Manual input points
        manual: {
          inputs: [DataInputPointSchema],
          totalCount: { type: Number, default: 0 },
          completedCount: { type: Number, default: 0 },
          pendingCount: { type: Number, default: 0 },
          onGoingCount: { type: Number, default: 0 },
          notStartedCount: { type: Number, default: 0 }
        },
        
        // API input points
        api: {
          inputs: [APIInputPointSchema],
          totalCount: { type: Number, default: 0 },
          completedCount: { type: Number, default: 0 },
          pendingCount: { type: Number, default: 0 },
          onGoingCount: { type: Number, default: 0 },
          notStartedCount: { type: Number, default: 0 }
        },
        
        // IoT input points
        iot: {
          inputs: [IoTInputPointSchema],
          totalCount: { type: Number, default: 0 },
          completedCount: { type: Number, default: 0 },
          pendingCount: { type: Number, default: 0 },
          onGoingCount: { type: Number, default: 0 },
          notStartedCount: { type: Number, default: 0 }
        },
        
        // Overall summary
        totalDataPoints: { type: Number, default: 0 },
        lastSyncedWithFlowchart: { type: Date }
      }
    },

    // Stage 1: Lead Information
    leadInfo: {
      companyName: { type: String, required: true },
      contactPersonName: { type: String, required: true },
      email: { type: String, required: true },
      mobileNumber: { type: String, required: true },
      leadSource: { 
        type: String,
        enum: ["online ads", "sales Team", "reference",'website','event'],

       },
      // ⬇️ New fields for conditional sources
      salesPersonName: { type: String },
      salesPersonEmployeeId: { type: String },
      referenceName:       { type: String },
      referenceContactNumber: { type: String },
      eventName: { type: String },
      eventPlace: { type: String },

      consultantAdminId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      assignedConsultantId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
      createdAt: { type: Date, default: Date.now },
      notes: { type: String },

      // ADD THESE NEW FIELDS:
       hasAssignedConsultant: { type: Boolean, default: false },
       consultantHistory: [{
       consultantId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
       consultantName: { type: String },
       employeeId: { type: String },
       assignedAt: { type: Date },
       unassignedAt: { type: Date },
       assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
       unassignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
       reasonForChange: { type: String },
       isActive: { type: Boolean, default: true }
      }]
    },
    
    // Stage 2: Registration/Data Submission (GHG Form Data)
    submissionData: {
       // Assessment Level Field (Add this at the top of submissionData)
  // ✅ In your SubmissionData schema, add/modify these fields:
      assessmentLevel: {
        type: [String],
        enum: ['reduction', 'decarbonization', 'organization', 'process'],
        default: []
      },
      projectProfile: {
        type: [ProjectProfileSchema],
        default: []
      },
      // Section A: Company Information
      companyInfo: {
        companyName: { type: String },
        companyAddress: { type: String },
        primaryContactPerson: {
          name: { type: String },
          designation: { type: String },
          email: { type: String },
          phoneNumber: { type: String }
        },
        alternateContactPerson: {
          name: { type: String },
          designation: { type: String },
          email: { type: String },
          phoneNumber: { type: String }
        },
      },
      // Common details schema used across Emissions Profile

      // Section B: Organizational Overview
      organizationalOverview: {
        industrySector: { type: String },
        companyDescription: { type: String },
        numberOfOperationalSites: { type: Number },
        sitesDetails: [{
          siteName: { type: String },
          location: { type: String },
          operation: { type: String },
          productionCapacity: { type: String },
          unit:   { type: String, default: "" },   // e.g., "employees", "m²", "t/yr"
          remark: { type: String, default: "" }    // free-text source/notes
        }],
        totalEmployees: { type: Number },
        employeesByFacility: [{
          facilityName: { type: String },
          employeeCount: { type: Number }
        }],
        accountingYear: { type: String }
      },
      
      // Section C: Emissions Profile
      emissionsProfile: {
        // Scope 1 Emissions (Direct Emissions)
        scope1: {
          stationaryCombustion: {
            included: { type: Boolean, default: false },
             details: DetailsforEmissonProfile
          },
          mobileCombustion: {
            included: { type: Boolean, default: false },
             details: DetailsforEmissonProfile
          },
          processEmissions: {
            included: { type: Boolean, default: false },
            details: DetailsforEmissonProfile
          },
          fugitiveEmissions: {
            included: { type: Boolean, default: false },
             details: DetailsforEmissonProfile
          }
        },
        
        // Scope 2 Emissions (Indirect Emissions from Energy)
        scope2: {
          purchasedElectricity: {
            included: { type: Boolean, default: false },
            details: DetailsforEmissonProfile
          },
          purchasedSteamHeating: {
            included: { type: Boolean, default: false },
            details: DetailsforEmissonProfile
          }
        },
        
        // Scope 3 Emissions (Other Indirect Emissions)
        scope3: {
          includeScope3: { type: Boolean, default: false },
          categories: {
            businessTravel: { type: Boolean, default: false },
            employeeCommuting: { type: Boolean, default: false },
            wasteGenerated: { type: Boolean, default: false },
            upstreamTransportation: { type: Boolean, default: false },
            downstreamTransportation: { type: Boolean, default: false },
            purchasedGoodsAndServices: { type: Boolean, default: false },
            capitalGoods: { type: Boolean, default: false },
            fuelAndEnergyRelated: { type: Boolean, default: false },
            upstreamLeasedAssets: { type: Boolean, default: false },
            downstreamLeasedAssets: { type: Boolean, default: false },
            processingOfSoldProducts: { type: Boolean, default: false },
            useOfSoldProducts: { type: Boolean, default: false },
            endOfLifeTreatment: { type: Boolean, default: false },
            franchises: { type: Boolean, default: false },
            investments: { type: Boolean, default: false }
          },
           // NEW: unified details for each of the 15 categories
categoriesDetails: {
  businessTravel:            { type: CategoryDetailsSchema, default: () => ({ details: {} }) },
  employeeCommuting:         { type: CategoryDetailsSchema, default: () => ({ details: {} }) },
  wasteGenerated:            { type: CategoryDetailsSchema, default: () => ({ details: {} }) },
  upstreamTransportation:    { type: CategoryDetailsSchema, default: () => ({ details: {} }) },
  downstreamTransportation:  { type: CategoryDetailsSchema, default: () => ({ details: {} }) },
  purchasedGoodsAndServices: { type: CategoryDetailsSchema, default: () => ({ details: {} }) },
  capitalGoods:              { type: CategoryDetailsSchema, default: () => ({ details: {} }) },
  fuelAndEnergyRelated:      { type: CategoryDetailsSchema, default: () => ({ details: {} }) },
  upstreamLeasedAssets:      { type: CategoryDetailsSchema, default: () => ({ details: {} }) },
  downstreamLeasedAssets:    { type: CategoryDetailsSchema, default: () => ({ details: {} }) },
  processingOfSoldProducts:  { type: CategoryDetailsSchema, default: () => ({ details: {} }) },
  useOfSoldProducts:         { type: CategoryDetailsSchema, default: () => ({ details: {} }) },
  endOfLifeTreatment:        { type: CategoryDetailsSchema, default: () => ({ details: {} }) },
  franchises:                { type: CategoryDetailsSchema, default: () => ({ details: {} }) },
  investments:               { type: CategoryDetailsSchema, default: () => ({ details: {} }) }
},

          otherIndirectSources: { type: String }
        }
      },
      
      // Section D: GHG Data Management
      ghgDataManagement: {
        previousCarbonAccounting: {
          conducted: { type: Boolean, default: false },
          details: { type: String },
          methodologies: { type: String }
        },
        dataTypesAvailable: {
          energyUsage: { type: Boolean, default: false },
          fuelConsumption: { type: Boolean, default: false },
          productionProcesses: { type: Boolean, default: false },
          otherDataTypes: { type: String },
          dataFormat: { type: String } // e.g., monthly logs, invoices, monitoring system outputs
        },
        isoCompliance: {
          hasEMSorQMS: { type: Boolean, default: false },
          containsGHGProcedures: { type: Boolean, default: false },
          certificationDetails: { type: String }
        }
      },
      
      // Section E: Additional Notes
      additionalNotes: {
        stakeholderRequirements: { type: String },
        additionalExpectations: { type: String },
        completedBy: { type: String },
        completionDate: { type: Date }
      },
      
      // Supporting Documents
      supportingDocuments: [{
        name: { type: String },
        url: { type: String },
        documentType: { type: String }, // e.g., ISO Certificate, Energy Bills, etc.
        uploadedAt: { type: Date, default: Date.now }
      }],
      
      // Submission Metadata
      submittedAt: { type: Date },
      submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      reviewNotes: { type: String },
      dataCompleteness: { type: Number, default: 0 }, // Percentage of required fields completed
      validationStatus: {
        type: String,
        enum: ["pending", "validated", "needs_revision"],
        default: "pending"
      }
    },
    
    // Stage 3: Proposal
// Stage 3: Proposal (minimal – toggle + approvals)
proposalData: {
  // A simple toggle that “Move to Proposal” will set
  submitted:      { type: Boolean, default: false },
  submittedAt:    { type: Date },
  submittedBy:    { type: mongoose.Schema.Types.ObjectId, ref: "User" },

  // (Optional) internal verification log (if you want to record who verified)
  verifiedAt:     { type: Date },
  verifiedBy:     { type: mongoose.Schema.Types.ObjectId, ref: "User" },

  // Final outcome fields used by accept/reject
  clientApprovalDate: { type: Date },
  approvedBy:         { type: String },
  rejectionReason:    { type: String }
},


    
    // Stage 4: Active Client
accountDetails: {
  clientAdminId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  defaultPassword: { type: String },
  passwordChanged: { type: Boolean, default: false },

  // Subscription Details
  subscriptionStartDate: { type: Date },
  subscriptionEndDate: { type: Date },
  subscriptionStatus: {
    type: String,
    enum: ["active", "suspended", "expired", "grace_period"],
    default: "active"
  },
  subscriptionType: { type: String },

  // 🔹 Subscription workflow (consultant → consultant admin / super admin)
  pendingSubscriptionRequest: {
    action: {
      type: String,
      // 👇 make sure these include the values you send from Postman / frontend
      enum: ["suspend", "reactivate", "renew", "extend"],
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    reason: { type: String },

    // who created the request (consultant or client_admin etc.)
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    requestedAt: { type: Date },

    // who approved/rejected (consultant_admin / super_admin)
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: Date },
    reviewComment: { type: String },
  },

  // Access Control
  isActive: { type: Boolean, default: true },
  suspensionReason: { type: String },
  suspendedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  suspendedAt: { type: Date },

  // Usage Metrics
  activeUsers: { type: Number, default: 0 },
  lastLoginDate: { type: Date },
  dataSubmissions: { type: Number, default: 0 },
},
    

    // Timeline tracking
    timeline: [{
      stage: { type: String },
      status: { type: String },
      action: { type: String },
      performedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      timestamp: { type: Date, default: Date.now },
      notes: { type: String }
    }],
    
    // Metadata
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
  },

  { timestamps: true }
);


// ===== NEW: ENFORCE SANDBOX/ACTIVE INVARIANTS =====
clientSchema.pre('save', function(next) {
  // Enforce the invariant: if sandbox === true then isActive === false
  // and if isActive === true then sandbox === false
  if (this.sandbox === true && this.isActive === true) {
    return next(new Error('Client cannot be both sandbox and active'));
  }
  
  // Auto-adjust to maintain invariant
  if (this.isModified('sandbox')) {
    if (this.sandbox === true) {
      this.isActive = false;
    }
  }
  
  if (this.isModified('isActive')) {
    if (this.isActive === true) {
      this.sandbox = false;
    }
  }
  
  next();
});



// --- Normalize assessmentLevel on every save (handles legacy values) ---
const ALLOWED_LEVELS = ['reduction', 'decarbonization', 'organization', 'process'];

clientSchema.pre('validate', function (next) {
  // Handle missing submissionData gracefully
  const raw = this?.submissionData?.assessmentLevel;

  // Convert to array
  let arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);

  // Normalize: trim/lowercase + alias + expand 'both' -> ['organization','process']
  arr = arr
    .map(v => String(v || '').trim().toLowerCase())
    .flatMap(v => {
      if (!v) return [];
      if (v === 'organisation') return ['organization'];
      if (v === 'both') return ['organization', 'process']; // legacy fix
      return [v];
    })
    // Keep only allowed values and dedupe
    .filter(v => ALLOWED_LEVELS.includes(v))
    .filter((v, i, a) => a.indexOf(v) === i);

  // Write back in the expected array shape
  if (!this.submissionData) this.submissionData = {};
  this.submissionData.assessmentLevel = arr;

  return next();
});

// ✅ Normalize legacy single-string -> array on nested path
clientSchema.path('submissionData.assessmentLevel').set((v) => {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  return [String(v)];
});


// Indexes for performance
clientSchema.index({ "leadInfo.email": 1 });
clientSchema.index({ "leadInfo.consultantAdminId": 1 });
clientSchema.index({ stage: 1, status: 1 });
clientSchema.index({ "accountDetails.subscriptionEndDate": 1 });
clientSchema.index({ "workflowTracking.assignedConsultantId": 1 });
clientSchema.index({ "workflowTracking.flowchartStatus": 1 });
clientSchema.index({ "workflowTracking.processFlowchartStatus": 1 });
clientSchema.index({ sandbox: 1 }); // NEW INDEX


// Counter Schema for ClientID generation
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 }
});

const Counter = mongoose.model("Counter", counterSchema);

// ===== NEW: SANDBOX COUNTER =====
const sandboxCounterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 }
});

const SandboxCounter = mongoose.model("SandboxCounter", sandboxCounterSchema);

// Static method to generate ClientID
clientSchema.statics.generateClientId = async function() {
  const counter = await Counter.findByIdAndUpdate(
    { _id: "clientId" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  
  // Production IDs start from Greon0 followed by padded numbers
  const paddedNumber = counter.seq.toString().padStart(3, '0');
  return `Greon0${paddedNumber}`;
};

// ===== NEW: Generate Sandbox Client ID =====
clientSchema.statics.generateSandboxClientId = async function() {
  const counter = await SandboxCounter.findByIdAndUpdate(
    { _id: "sandboxClientId" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  
  // Sandbox IDs: Greon01, Greon02, etc. (no leading 0 after Greon)
  const paddedNumber = counter.seq.toString().padStart(2, '0');
  return `Greon${paddedNumber}`;
};



// Method to calculate data completeness
clientSchema.methods.calculateDataCompleteness = function() {
  const requiredFields = [
    'submissionData.companyInfo.companyName',
    'submissionData.companyInfo.companyAddress',
    'submissionData.companyInfo.primaryContactPerson.name',
    'submissionData.companyInfo.primaryContactPerson.email',
    'submissionData.organizationalOverview.industrySector',
    'submissionData.organizationalOverview.numberOfOperationalSites',
    'submissionData.organizationalOverview.totalEmployees',
    'submissionData.organizationalOverview.accountingYear'
  ];
  
  let completedFields = 0;
  requiredFields.forEach(field => {
    const value = field.split('.').reduce((obj, key) => obj?.[key], this);
    if (value) completedFields++;
  });
  
  return Math.round((completedFields / requiredFields.length) * 100);
};
// Helper method to update input point counts
clientSchema.methods.updateInputPointCounts = function(type) {
  const section = this.workflowTracking.dataInputPoints[type];
  const inputs = section.inputs || [];

  section.totalCount     = inputs.length;
  section.completedCount = inputs.filter(p => p.status === 'completed').length;
  section.pendingCount   = inputs.filter(p => p.status === 'pending').length;
  section.onGoingCount   = inputs.filter(p => p.status === 'on_going').length;
  section.notStartedCount= inputs.filter(p => p.status === 'not_started').length;

  // Recalculate overall
  this.workflowTracking.dataInputPoints.totalDataPoints =
    this.workflowTracking.dataInputPoints.manual.totalCount +
    this.workflowTracking.dataInputPoints.api.totalCount +
    this.workflowTracking.dataInputPoints.iot.totalCount;
};
clientSchema.methods.getWorkflowDashboard = function() {
  const w = this.workflowTracking;
  return {
    flowchartStatus: w.flowchartStatus,
    processFlowchartStatus: w.processFlowchartStatus,
    dataInputPoints: {
      manual:   { total: w.dataInputPoints.manual.totalCount,   completed: w.dataInputPoints.manual.completedCount,   pending: w.dataInputPoints.manual.pendingCount },
      api:      { total: w.dataInputPoints.api.totalCount,      completed: w.dataInputPoints.api.completedCount,      pending: w.dataInputPoints.api.pendingCount },
      iot:      { total: w.dataInputPoints.iot.totalCount,      completed: w.dataInputPoints.iot.completedCount,      pending: w.dataInputPoints.iot.pendingCount },
      overall:  w.dataInputPoints.totalDataPoints
    }
  };
};
// ===== 1. ADD THIS METHOD TO YOUR CLIENT SCHEMA (Client.js) =====

// Method to update workflow tracking based on assessment level
clientSchema.methods.updateWorkflowBasedOnAssessment = function() {
  const al = this.submissionData?.assessmentLevel;
  const levels = Array.isArray(al) ? al : (al ? [al] : []);

  const currentFlowchartStatus = this.workflowTracking.flowchartStatus;
  const currentProcessFlowchartStatus = this.workflowTracking.processFlowchartStatus;

  const hasOrg       = levels.includes('organization');
  const hasProc      = levels.includes('process');
  const hasReduction = levels.includes('reduction');

  // Ensure reduction block exists if selected
  if (hasReduction && !this.workflowTracking.reduction) {
    this.workflowTracking.reduction = { status: 'not_started' };
  }

  if (hasOrg && hasProc) {
    if (currentFlowchartStatus === 'not_started') {
      this.workflowTracking.flowchartStatus = 'not_started';
    }
    if (currentProcessFlowchartStatus === 'not_started') {
      this.workflowTracking.processFlowchartStatus = 'not_started';
    }
    return;
  }

  if (hasOrg) {
    if (currentFlowchartStatus === 'not_started') {
      this.workflowTracking.flowchartStatus = 'not_started';
    }
    this.workflowTracking.processFlowchartStatus = 'not_started';
    this.workflowTracking.processFlowchartStartedAt = undefined;
    this.workflowTracking.processFlowchartCompletedAt = undefined;
    return;
  }

  if (hasProc) {
    if (currentProcessFlowchartStatus === 'not_started') {
      this.workflowTracking.processFlowchartStatus = 'not_started';
    }
    this.workflowTracking.flowchartStatus = 'not_started';
    this.workflowTracking.flowchartStartedAt = undefined;
    this.workflowTracking.flowchartCompletedAt = undefined;
    return;
  }

  // If neither org nor process is selected, leave existing statuses as-is.
  // Reduction status is managed by the workflow utility (see utils/workflow.js).
};


module.exports = mongoose.model("Client", clientSchema);