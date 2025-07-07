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

const clientSchema = new mongoose.Schema(
  {
    clientId: {
      type: String,
      unique: true,
      required: true,
      index: true
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
      
      // Section B: Organizational Overview
      organizationalOverview: {
        industrySector: { type: String },
        companyDescription: { type: String },
        numberOfOperationalSites: { type: Number },
        sitesDetails: [{
          siteName: { type: String },
          location: { type: String },
          operation: { type: String },
          productionCapacity: { type: String }
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
            details: {
              fuelType: { type: String },
              quantityUsed: { type: String },
              equipmentType: { type: String },
              operationalHours: { type: String }
            }
          },
          mobileCombustion: {
            included: { type: Boolean, default: false },
            details: {
              vehicleType: { type: String },
              fuelType: { type: String },
              distanceTraveled: { type: String },
              fuelConsumed: { type: String }
            }
          },
          processEmissions: {
            included: { type: Boolean, default: false },
            details: {
              processDescription: { type: String },
              emissionTypes: { type: String },
              quantitiesEmitted: { type: String }
            }
          },
          fugitiveEmissions: {
            included: { type: Boolean, default: false },
            details: {
              gasType: { type: String },
              leakageRates: { type: String },
              equipmentType: { type: String }
            }
          }
        },
        
        // Scope 2 Emissions (Indirect Emissions from Energy)
        scope2: {
          purchasedElectricity: {
            included: { type: Boolean, default: false },
            details: {
              monthlyConsumption: { type: String },
              annualConsumption: { type: String },
              supplierDetails: { type: String },
              unit: { type: String, default: "kWh" }
            }
          },
          purchasedSteamHeating: {
            included: { type: Boolean, default: false },
            details: {
              quantityPurchased: { type: String },
              sourceSupplier: { type: String },
              unit: { type: String }
            }
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
  // Stage 3: Proposal
proposalData: {
  proposalNumber: { type: String },
  proposalDate: { type: Date },
  validUntil: { type: Date },

  // Service Details
  servicesOffered: [
    {
      serviceName: { type: String },
      description: { type: String },
      deliverables: [{ type: String }],
      timeline: { type: String }
    }
  ],

  // Pricing
  pricing: {
    basePrice: { type: Number },
    additionalServices: [
      {
        name: { type: String },
        price: { type: Number }
      }
    ],
    discounts: [
      {
        type: { type: String },
        amount: { type: Number }
      }
    ],
    totalAmount: { type: Number },
    currency: { type: String, default: "INR" },
    paymentTerms: { type: String }
  },

  // Terms
  termsAndConditions: { type: String },
  sla: {
    responseTime: { type: String },
    resolutionTime: { type: String },
    availability: { type: String }
  },

  // Approval
  clientApprovalDate: { type: Date },
  approvedBy: { type: String },
  signedDocument: { type: String },
  rejectionReason: { type: String },

  // ─── JSON‐derived “Data Integration Points” (no defaults) ───────────────────
  totalDataIntegrationPoints: {
    type: Number,
    
  },

  scopes: {
    scope1_directEmissions: {
       name: {
      type: String,
      trim: true
    },
    dataType: {
      type: String,
      trim: true
    }
      // no default array here
    },

    scope2_energyConsumption: {
       name: {
      type: String,
      trim: true
    },
    dataType: {
      type: String,
      
      trim: true
    }
      // no default array here
    },

    scope3_purchasedGoodsServices: {
       name: {
      type: String,
      trim: true
    },
    dataType: {
      type: String,
      trim: true
    }
      // no default array here
    },

    manualDataCollection: {
       name: {
      type: String,
      trim: true
    },
    dataType: {
      type: String,
      trim: true
    }
      // no default array here
    },

    decarbonizationModule: {
       name: {
      type: String,
      
      trim: true
    },
    dataType: {
      type: String,
      
      trim: true
    }
      // no default array here
    }
  },
  
  consolidatedData: {
        scope1: {
          category: { type: String },           // e.g. "Direct Emissions"
          totalDataPoints: { type: Number },     // e.g. 12
          collectionMethods: [{ type: String }]                  // e.g. ["API", "Manual"]
        },
        scope2: {
          category: { type: String },           // e.g. "Energy Consumption"
          totalDataPoints: { type: Number },     // e.g. 1
          collectionMethods: [{ type: String }]                  // e.g. ["IoT"]
        },
        scope3: {
          category: { type: String },           // e.g. "Purchased Goods & Services"
          totalDataPoints: { type: Number },     // e.g. 2
          collectionMethods: [{ type: String }]                  // e.g. ["API", "Manual"]
        }
      
      // ─── End of “Data Integration Points” ───────────────────────────────────────
  }
  
  // ─── End of JSON‐derived “Data Integration Points” ───────────────────────────
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
      
      // Access Control
      isActive: { type: Boolean, default: true },
      suspensionReason: { type: String },
      suspendedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      suspendedAt: { type: Date },
      
      // Usage Metrics
      activeUsers: { type: Number, default: 0 },
      lastLoginDate: { type: Date },
      dataSubmissions: { type: Number, default: 0 }
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

// Indexes for performance
clientSchema.index({ "leadInfo.email": 1 });
clientSchema.index({ "leadInfo.consultantAdminId": 1 });
clientSchema.index({ stage: 1, status: 1 });
clientSchema.index({ "accountDetails.subscriptionEndDate": 1 });
clientSchema.index({ "workflowTracking.assignedConsultantId": 1 });
clientSchema.index({ "workflowTracking.flowchartStatus": 1 });
clientSchema.index({ "workflowTracking.processFlowchartStatus": 1 });


// Counter Schema for ClientID generation
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 }
});

const Counter = mongoose.model("Counter", counterSchema);

// Static method to generate ClientID
clientSchema.statics.generateClientId = async function() {
  const counter = await Counter.findByIdAndUpdate(
    { _id: "clientId" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  
  const paddedNumber = counter.seq < 1000 
    ? counter.seq.toString().padStart(3, '0') 
    : counter.seq.toString();
    
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

module.exports = mongoose.model("Client", clientSchema);