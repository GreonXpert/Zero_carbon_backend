const mongoose = require('mongoose');

const EditHistorySchema = new mongoose.Schema({
  editedAt: {
    type: Date,
    default: Date.now
  },
  editedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  reason: {
    type: String,
    default: 'Data correction'
  },
  previousValues: {
    type: mongoose.Schema.Types.Mixed
  },
  changeDescription: {
    type: String
  }
});

const SourceDetailsSchema = new mongoose.Schema({
  // For manual entries
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  // For API entries
  apiEndpoint: {
    type: String
  },
  // For IoT entries
  iotDeviceId: {
    type: String
  },
  // For CSV uploads
  fileName: {
    type: String
  },
  // Additional metadata
  dataSource: {
    type: String
  },
  requestId: {
    type: String
  },
  batchId: {
    type: String
  }
});

const DataEntrySchema = new mongoose.Schema({
  // Core identifiers
  clientId: {
    type: String,
    required: true,
    index: true
  },
  nodeId: {
    type: String,
    required: true,
    index: true
  },
  scopeIdentifier: {
    type: String,
    required: true,
    index: true
  },
  // Scope information
  scopeType: {
    type: String,
    required: true,
    enum: ['Scope 1', 'Scope 2', 'Scope 3']
  },
  // Input method
  inputType: {
    type: String,
    required: true,
    enum: ['manual', 'API', 'IOT'],
    index: true
  },
  // Timestamp information
  date: {
    type: String,
  }, // Format: "DD:MM:YYYY"
  time: {
    type: String,
  }, // Format: "HH:mm:ss"
  timestamp: {
    type: Date,
    required: true,
    index: true
  },
  // Data content
  dataValues: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    required: true,
    validate: {
      validator: function(v) {
        if (!(v instanceof Map)) return false;
        for (const [key, value] of v) {
          if (typeof value !== 'number' && isNaN(Number(value))) {
            return false;
          }
        }
        return true;
      },
      message: 'dataValues must be a key-value map with numeric values'
    }
  },
  // Cumulative tracking fields
  cumulativeValues: {
    type: Map,
    of: Number,
    default: () => new Map()
  },
  highData: {
    type: Map,
    of: Number,
    default: () => new Map()
  },
  lowData: {
    type: Map,
    of: Number,
    default: () => new Map()
  },
  lastEnteredData: {
    type: Map,
    of: Number,
    default: () => new Map()
  },

  // Total value + entry count tracking for this stream
  // - incomingTotalValue: sum of numeric values in this entry's dataValues
  // - cumulativeTotalValue: running total (previous cumulativeTotalValue + incomingTotalValue)
  // - entryCount: total number of entries stored so far for this stream
  dataEntryCumulative: {
    incomingTotalValue: { type: Number, default: 0 },
    cumulativeTotalValue: { type: Number, default: 0 },
    entryCount: { type: Number, default: 0 },
    lastUpdatedAt: { type: Date }
  },
  // Monthly summary flag
  isSummary: {
    type: Boolean,
    default: false
  },
  summaryPeriod: {
    month: Number,
    year: Number
  },
  // Emission factor
  emissionFactor: {
    type: String,
    enum: ['IPCC', 'DEFRA', 'EPA', 'Custom', 'Country', 'EmissionFactorHub'],
    default: ''
  },
  nodeType: {
    type: String,
    enum: ['Emission Source', 'Reduction'],
    default: 'Emission Source'
  },
  // Source tracking
  sourceDetails: SourceDetailsSchema,
  // Edit capability and tracking
  isEditable: {
    type: Boolean,
    default: function() {
      return this.inputType === 'manual';
    }
  },
  lastEditedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  lastEditedAt: {
    type: Date
  },
  editHistory: [EditHistorySchema],
  // Processing status
  processingStatus: {
    type: String,
    enum: ['pending', 'processing', 'processed', 'failed'],
    default: 'pending'
  },
  // Validation and quality
  validationStatus: {
    type: String,
    enum: ['valid', 'invalid', 'warning', 'pending_review'],
    default: 'valid'
  },
  validationErrors: [{
    field: String,
    message: String,
    severity: {
      type: String,
      enum: ['error', 'warning', 'info']
    }
  }],
  // Quality metrics
  dataQuality: {
    completeness: { type: Number, min: 0, max: 100 }, // Percentage
    accuracy: { type: Number, min: 0, max: 100 },
    consistency: { type: Number, min: 0, max: 100 },
    timeliness: { type: Number, min: 0, max: 100 }
  },
  // Emission calculation results
  calculatedEmissions: {
    incoming: {
      type: Map,
      of: {
        CO2: Number,
        CH4: Number,
        N2O: Number,
        CO2e: Number,
        emission: Number, // For process emissions
        combinedUncertainty: Number,
        CO2eWithUncertainty: Number,
        emissionWithUncertainty: Number // For process emissions
      }
    },
    cumulative: {
      type: Map,
      of: {
        CO2: Number,
        CH4: Number,
        N2O: Number,
        CO2e: Number,
        emission: Number, // For process emissions
        combinedUncertainty: Number,
        CO2eWithUncertainty: Number,
        emissionWithUncertainty: Number // For process emissions
      }
    },
    metadata: {
      scopeType: String,
      category: String,
      tier: String,
      emissionFactorSource: String,
      UAD: Number,
      UEF: Number,
      gwpValues: {
        CO2: Number,
        CH4: Number,
        N2O: Number,
        refrigerant: Number
      }
    }
  },
  // Emission calculation tracking
  emissionCalculationStatus: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'error'],
    default: 'pending'
  },
  emissionCalculatedAt: {
    type: Date
  },
  emissionCalculationError: {
    type: String
  },
  lastCalculated: {
    type: Date
  },
  // Emission factor tracking (for audit trail)
  appliedEmissionFactors: {
    source: {
      type: String,
      enum: ['IPCC', 'DEFRA', 'EPA', 'EmissionFactorHub', 'Custom', 'Country']
    },
    values: {
      CO2: Number,
      CH4: Number,
      N2O: Number
    },
    appliedAt: Date
  },
  // Total emissions summary (for quick access)
  emissionsSummary: {
    totalCO2: Number,
    totalCH4: Number,
    totalN2O: Number,
    totalCO2e: Number,
    totalCO2eWithUncertainty: Number,
    unit: String
  },
  calculatedReductions: {
    incoming: {
        type: Map,
        of: Number
    },
    cumulative: {
        type: Map,
        of: Number
    },
    breakdown: {
        baseline: {
            incoming: { type: Map, of: mongoose.Schema.Types.Mixed },
            cumulative: { type: Map, of: mongoose.Schema.Types.Mixed }
        },
        project: {
            incoming: { type: Map, of: mongoose.Schema.Types.Mixed },
            cumulative: { type: Map, of: mongoose.Schema.Types.Mixed }
        },
        leakage: {
            incoming: { type: Map, of: mongoose.Schema.Types.Mixed },
            cumulative: { type: Map, of: mongoose.Schema.Types.Mixed }
        },
        buffer: {
            incoming: { type: mongoose.Schema.Types.Mixed },
            cumulative: { type: mongoose.Schema.Types.Mixed }
        },
        netReduction: {
            incoming: { type: Number },
            cumulative: { type: Number }
        }
    }
  },
  // Approval workflow (for sensitive data)
  approvalStatus: {
    type: String,
    enum: ['auto_approved', 'pending_approval', 'approved', 'rejected'],
    default: 'auto_approved'
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  approvedAt: {
    type: Date
  },
  // Archiving
  isArchived: {
    type: Boolean,
    default: false
  },
  archivedAt: {
    type: Date
  },
  archivedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  // Additional metadata
  tags: [String],
  notes: String,
  externalId: String, // For external system integration
},
{
  timestamps: true,
  collection: 'dataentries'
});

// Indexes for performance
DataEntrySchema.index({ clientId: 1, nodeId: 1, scopeIdentifier: 1 });
DataEntrySchema.index({ clientId: 1, timestamp: -1 });
DataEntrySchema.index({ inputType: 1, processingStatus: 1 });
DataEntrySchema.index({ 'sourceDetails.uploadedBy': 1 });
DataEntrySchema.index({ validationStatus: 1 });
DataEntrySchema.index({ approvalStatus: 1 });
DataEntrySchema.index({ isSummary: 1 });
DataEntrySchema.index({ 'summaryPeriod.month': 1, 'summaryPeriod.year': 1 });
DataEntrySchema.index({ clientId: 1, nodeId: 1, scopeIdentifier: 1, timestamp: -1 });
DataEntrySchema.index({ clientId: 1, processingStatus: 1, timestamp: -1 });
DataEntrySchema.index({ clientId: 1, 'summaryPeriod.year': -1, 'summaryPeriod.month': -1 });


// Compound index for efficient querying
DataEntrySchema.index({ 
  clientId: 1, 
  nodeId: 1, 
  scopeIdentifier: 1, 
  timestamp: -1 
});


// --- Add near top (after schema declaration) ---
// --- Add near top (after schema declaration) ---
const IST_OFFSET_MINUTES = 330; // +05:30

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Supports "DD/MM/YYYY" or "DD:MM:YYYY"
function normalizeDateStr(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  if (s.includes("/")) return s;          // DD/MM/YYYY
  if (s.includes(":")) return s;          // DD:MM:YYYY
  // Try DD-MM-YYYY -> DD/MM/YYYY
  if (s.includes("-")) return s.replace(/-/g, "/");
  return s;
}

// Supports "HH:mm", "H:mm", "HH:mm:ss"
function normalizeTimeStr(timeStr) {
  if (!timeStr) return null;
  const parts = String(timeStr).trim().split(":").map(v => parseInt(v, 10));
  const h = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  const sec = parts[2] ?? 0;
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
}

function buildISTTimestampFromDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;

  const d = normalizeDateStr(dateStr);
  const t = normalizeTimeStr(timeStr);
  if (!d || !t) return null;

  const parts = d.includes("/") ? d.split("/") : d.split(":");
  if (parts.length !== 3) return null;

  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const year = parseInt(parts[2], 10);
  if (!day || !month || !year) return null;

  const tp = t.split(":").map(v => parseInt(v, 10));
  const hour = tp[0] || 0;
  const minute = tp[1] || 0;
  const second = tp[2] || 0;

  // Interpret given date+time as IST, store absolute UTC instant
  const utcMs =
    Date.UTC(year, month - 1, day, hour, minute, second) - IST_OFFSET_MINUTES * 60 * 1000;

  return new Date(utcMs);
}

// ✅ IMPORTANT: run before validation so required timestamp never fails
DataEntrySchema.pre("validate", function (next) {
  try {
    if (this.isSummary) return next();

    if (this.date) this.date = normalizeDateStr(this.date);
    if (this.time) this.time = normalizeTimeStr(this.time);

    if (this.date && this.time) {
      const computed = buildISTTimestampFromDateTime(this.date, this.time);
      if (computed) this.timestamp = computed;
    }
    return next();
  } catch (err) {
    return next(err);
  }
});

// Pre-save middleware
DataEntrySchema.pre("save", async function (next) {
  try {
    if (this._skipRecalculation) {
      delete this._skipRecalculation;
      return next();
    }

    // ✅ Always force timestamp from date+time (do NOT depend on existing timestamp)
    if (!this.isSummary && this.date && this.time) {
      this.date = normalizeDateStr(this.date);
      this.time = normalizeTimeStr(this.time);

      const computed = buildISTTimestampFromDateTime(this.date, this.time);
      if (computed) this.timestamp = computed;
    }

    // existing logic...
    if (this.inputType !== "manual") this.isEditable = false;

    if (this.inputType === "manual" && this.approvalStatus === "auto_approved") {
      this.approvedAt = new Date();
    }

    if (!this.isSummary) {
      await this.calculateCumulativeValues();
    }

    return next();
  } catch (e) {
    return next(e);
  }
});

// 🔹 POST-SAVE HOOK - Trigger recalculation of later entries when a historical entry is inserted
DataEntrySchema.post('save', async function(doc) {
  try {
    // Skip if this is part of a recalculation process or is a summary
    if (doc._skipRecalculation || doc._isRecalculating || doc.isSummary) {
      return;
    }
    
    // Check if there are any entries after this timestamp that need recalculation
    const laterEntriesCount = await this.constructor.countDocuments({
      clientId: doc.clientId,
      nodeId: doc.nodeId,
      scopeIdentifier: doc.scopeIdentifier,
      inputType: doc.inputType,
      timestamp: { $gt: doc.timestamp },
      _id: { $ne: doc._id },
      isSummary: false
    });
    
    if (laterEntriesCount > 0) {
      console.log(`🔄 Found ${laterEntriesCount} data entries after this timestamp. Triggering recalculation...`);
      
      // Import the recalculation helper
      const { recalculateDataEntriesAfter } = require('../../utils/Calculation/recalculateHelpers');
      
      // Trigger recalculation in background (don't await to avoid blocking)
      setImmediate(async () => {
        try {
          await recalculateDataEntriesAfter(doc);
          
          // 🔹 After recalculation, trigger summary updates
          console.log(`📊 Triggering emission summary recalculation for client: ${doc.clientId}`);
          try {
            const { updateSummariesOnDataChange } = require('../../controllers/Calculation/CalculationSummary');
            await updateSummariesOnDataChange(doc);
            console.log(`📊 ✅ Emission summary recalculation completed`);
          } catch (summaryError) {
            console.error(`📊 ❌ Error recalculating emission summary:`, summaryError);
          }
        } catch (recalcError) {
          console.error('❌ Error in post-save recalculation:', recalcError);
        }
      });
    } else {
      // No later entries, but still trigger summary update for this period
      console.log(`📊 No later entries. Triggering emission summary update for client: ${doc.clientId}`);
      setImmediate(async () => {
        try {
          const { updateSummariesOnDataChange } = require('../../controllers/Calculation/CalculationSummary');
          await updateSummariesOnDataChange(doc);
          console.log(`📊 ✅ Emission summary update completed`);
        } catch (summaryError) {
          console.error(`📊 ❌ Error updating emission summary:`, summaryError);
        }
      });
    }
  } catch (error) {
    console.error('❌ Error in DataEntry post-save hook:', error);
    // Don't throw - we don't want to break the save operation
  }
});

// Method to validate data format
DataEntrySchema.methods.validateDataFormat = function() {
  if (!this.dataValues || !(this.dataValues instanceof Map)) {
    throw new Error('Invalid format: Please update dataValues to be key-value structured for cumulative tracking.');
  }
  
  for (const [key, value] of this.dataValues) {
    if (typeof value !== 'number' && isNaN(Number(value))) {
      throw new Error(`Invalid format: Value for key "${key}" must be numeric for cumulative tracking.`);
    }
  }
  
  return true;
};

// Method to calculate cumulative values for all input types
DataEntrySchema.methods.calculateCumulativeValues = async function() {
  // Skip if this is a summary entry
  if (this.isSummary) return;
  
  // Validate format first
  this.validateDataFormat();
  
  // Find the latest previous entry for the same stream
  const previousEntry = await this.constructor.findOne({
    clientId: this.clientId,
    nodeId: this.nodeId,
    scopeIdentifier: this.scopeIdentifier,
    inputType: this.inputType,
    _id: { $ne: this._id },
    timestamp: { $lt: this.timestamp },
    isSummary: false // Don't consider summary entries for cumulative calculation
  }).sort({ timestamp: -1 });
  
  // Initialize tracking maps
  const cumulativeValues = new Map();
  const highData = new Map();
  const lowData = new Map();
  const lastEnteredData = new Map();

  // Track totals for this entry
  let incomingTotalValue = 0;
  
  // Process each incoming value
  for (const [key, value] of this.dataValues) {
    const numValue = Number(value);

    // Add to entry total
    incomingTotalValue += numValue;
    
    // Store last entered
    lastEnteredData.set(key, numValue);
    
    // Calculate cumulative
    let cumulativeValue = numValue;
    if (previousEntry && previousEntry.cumulativeValues) {
      const prevCumulative = previousEntry.cumulativeValues.get(key) || 0;
      cumulativeValue = prevCumulative + numValue;
    }
    cumulativeValues.set(key, cumulativeValue);
    
    // Update high/low
    let highValue = numValue;
    let lowValue = numValue;
    
    if (previousEntry && previousEntry.highData && previousEntry.lowData) {
      const prevHigh = previousEntry.highData.get(key);
      const prevLow = previousEntry.lowData.get(key);
      
      if (prevHigh !== undefined) {
        highValue = Math.max(prevHigh, numValue);
      }
      if (prevLow !== undefined) {
        lowValue = Math.min(prevLow, numValue);
      }
    }
    
    highData.set(key, highValue);
    lowData.set(key, lowValue);
  }
  
  // Build dataEntryCumulative (total sum + total count)
  const prevCum = previousEntry?.dataEntryCumulative?.cumulativeTotalValue || 0;
  const prevCount = previousEntry?.dataEntryCumulative?.entryCount || 0;
  this.dataEntryCumulative = {
    incomingTotalValue,
    cumulativeTotalValue: prevCum + incomingTotalValue,
    entryCount: prevCount + 1,
    lastUpdatedAt: new Date()
  };

  // Update the document
  this.cumulativeValues = cumulativeValues;
  this.highData = highData;
  this.lowData = lowData;
  this.lastEnteredData = lastEnteredData;
};

// Static method to create monthly summary for Manual/CSV
DataEntrySchema.statics.createMonthlySummary = async function(clientId, nodeId, scopeIdentifier, month, year) {
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0, 23, 59, 59, 999);
  
  // Find all entries for the month
  const entries = await this.find({
    clientId,
    nodeId,
    scopeIdentifier,
    inputType: { $in: ['manual'] },
    timestamp: { $gte: startDate, $lte: endDate },
    isSummary: false
  }).sort({ timestamp: 1 });
  
  if (entries.length === 0) return null;
  
  // Get the last entry of the month to preserve cumulative values
  const lastEntry = entries[entries.length - 1];
  
  // Calculate monthly aggregates
  const monthlyTotals = new Map();
  const monthlyHighs = new Map();
  const monthlyLows = new Map();
  
  // Process all entries to get monthly totals
  for (const entry of entries) {
    for (const [key, value] of entry.dataValues) {
      const numValue = Number(value);
      
      // Add to monthly total
      const currentTotal = monthlyTotals.get(key) || 0;
      monthlyTotals.set(key, currentTotal + numValue);
      
      // Update monthly high
      const currentHigh = monthlyHighs.get(key);
      if (currentHigh === undefined || numValue > currentHigh) {
        monthlyHighs.set(key, numValue);
      }
      
      // Update monthly low
      const currentLow = monthlyLows.get(key);
      if (currentLow === undefined || numValue < currentLow) {
        monthlyLows.set(key, numValue);
      }
    }
  }
  
  // Create summary entry preserving cumulative values from last entry
  const summaryEntry = new this({
    clientId,
    nodeId,
    scopeIdentifier,
    scopeType: lastEntry.scopeType,
    inputType: lastEntry.inputType,
    date: endDate.toLocaleDateString('en-GB').replace(/\//g, ':'),
    time: '23:59:59',
    timestamp: endDate,
    dataValues: monthlyTotals, // Monthly totals
    cumulativeValues: lastEntry.cumulativeValues, // Preserve cumulative from last entry
    highData: lastEntry.highData, // Preserve all-time highs
    lowData: lastEntry.lowData, // Preserve all-time lows
    lastEnteredData: lastEntry.lastEnteredData, // Last value from the month
    dataEntryCumulative: lastEntry.dataEntryCumulative, // Preserve all-time total/count tracking
    emissionFactor: lastEntry.emissionFactor,
    sourceDetails: {
      uploadedBy: lastEntry.sourceDetails?.uploadedBy,
      dataSource: 'Monthly Summary'
    },
    isSummary: true,
    summaryPeriod: { month, year },
    processingStatus: 'processed',
    isEditable: false
  });
  
  // Save summary
  await summaryEntry.save();
  
  // Delete individual entries
  await this.deleteMany({
    _id: { $in: entries.map(e => e._id) }
  });
  
  return summaryEntry;
};

// Method to check if user can edit this entry
DataEntrySchema.methods.canBeEditedBy = async function(userId, userType = null) {
  // Entry must be editable
  if (!this.isEditable) return { allowed: false, reason: 'Entry is not editable' };
  
  // Entry must be manual type
  if (this.inputType !== 'manual') {
    return { allowed: false, reason: 'Only manual entries can be edited' };
  }
  
  const User = mongoose.model('User');
  const user = await User.findById(userId);
  if (!user) return { allowed: false, reason: 'User not found' };
  
  // Check hierarchy permissions
  // Super admin can edit any manual entry
  if (user.userType === 'super_admin') {
    return { allowed: true, reason: 'Super admin access' };
  }
  
  // Consultant admin who created the client can edit
  if (user.userType === 'consultant_admin') {
    const Client = mongoose.model('Client');
    const client = await Client.findOne({ clientId: this.clientId });
    if (client && client.leadInfo?.createdBy?.toString() === userId.toString()) {
      return { allowed: true, reason: 'Consultant admin who created client' };
    }
  }
  
  // Client admin can edit their own client's data
  if (user.userType === 'client_admin' && user.clientId === this.clientId) {
    return { allowed: true, reason: 'Client admin access' };
  }
  
  // Employee head can edit data from their assigned nodes
  if (user.userType === 'client_employee_head' && user.clientId === this.clientId) {
    const Flowchart = mongoose.model('Flowchart');
    const flowchart = await Flowchart.findOne({ 
      clientId: this.clientId, 
      isActive: true 
    });
    
    if (flowchart) {
      const node = flowchart.nodes.find(n => n.id === this.nodeId);
      if (node && node.details.employeeHeadId?.toString() === userId.toString()) {
        return { allowed: true, reason: 'Employee head of assigned node' };
      }
    }
  }
  
  // Employee can edit data they created or are assigned to
  if (user.userType === 'employee' && user.clientId === this.clientId) {
    // Check if they created this entry
    if (this.sourceDetails?.uploadedBy?.toString() === userId.toString()) {
      return { allowed: true, reason: 'Created by user' };
    }
    
    // Check if they are assigned to this scope
    const Flowchart = mongoose.model('Flowchart');
    const flowchart = await Flowchart.findOne({ 
      clientId: this.clientId, 
      isActive: true 
    });
    
    if (flowchart) {
      const node = flowchart.nodes.find(n => n.id === this.nodeId);
      if (node) {
        const scope = node.details.scopeDetails.find(s => s.scopeIdentifier === this.scopeIdentifier);
        if (scope) {
          const assignedEmployees = scope.assignedEmployees || [];
          if (assignedEmployees.map(id => id.toString()).includes(userId.toString())) {
            return { allowed: true, reason: 'Assigned to scope' };
          }
        }
      }
    }
  }
  
  return { allowed: false, reason: 'Insufficient permissions' };
};

// Method to add edit history entry
DataEntrySchema.methods.addEditHistory = function(editedBy, reason, previousValues, changeDescription) {
  if (!this.editHistory) {
    this.editHistory = [];
  }
  
  this.editHistory.push({
    editedAt: new Date(),
    editedBy,
    reason: reason || 'Data correction',
    previousValues,
    changeDescription
  });
  
  this.lastEditedBy = editedBy;
  this.lastEditedAt = new Date();
};

// Method to validate data quality
DataEntrySchema.methods.validateDataQuality = function() {
  const errors = [];
  
  // Check for required fields
  if (!this.dataValues || Object.keys(this.dataValues).length === 0) {
    errors.push({
      field: 'dataValues',
      message: 'Data values cannot be empty',
      severity: 'error'
    });
  }
  
  // Check timestamp validity
  if (!this.timestamp || isNaN(this.timestamp.getTime())) {
    errors.push({
      field: 'timestamp',
      message: 'Invalid timestamp',
      severity: 'error'
    });
  }
  
  // Check for future dates
  if (this.timestamp > new Date()) {
    errors.push({
      field: 'timestamp',
      message: 'Data cannot be from future dates',
      severity: 'warning'
    });
  }
  
  // Scope-specific validations
  if (this.scopeType === 'Scope 1' && !this.emissionFactor) {
    errors.push({
      field: 'emissionFactor',
      message: 'Emission factor is required for Scope 1',
      severity: 'warning'
    });
  }
  
  this.validationErrors = errors;
  this.validationStatus = errors.some(e => e.severity === 'error') ? 'invalid' : 
                         errors.some(e => e.severity === 'warning') ? 'warning' : 'valid';
  
  return errors;
};

// Virtual for formatted timestamp
DataEntrySchema.virtual('formattedTimestamp').get(function() {
  return `${this.date} ${this.time}`;
});

// Virtual for human-readable edit count
DataEntrySchema.virtual('editCount').get(function() {
  return this.editHistory ? this.editHistory.length : 0;
});

// Static method to find entries by user permissions
DataEntrySchema.statics.findWithPermissions = async function(userId, clientId, filters = {}) {
  const User = mongoose.model('User');
  const user = await User.findById(userId);
  if (!user) return [];
  
  const baseQuery = { clientId, ...filters };
  
  // Super admin sees all
  if (user.userType === 'super_admin') {
    return this.find(baseQuery);
  }
  
  // Client admin sees all client data
  if (user.userType === 'client_admin' && user.clientId === clientId) {
    return this.find(baseQuery);
  }
  
  // Employee head sees their node data
  if (user.userType === 'client_employee_head' && user.clientId === clientId) {
    const Flowchart = mongoose.model('Flowchart');
    const flowchart = await Flowchart.findOne({ clientId, isActive: true });
    
    if (flowchart) {
      const assignedNodes = flowchart.nodes.filter(
        n => n.details.employeeHeadId?.toString() === userId.toString()
      );
      const nodeIds = assignedNodes.map(n => n.id);
      
      if (nodeIds.length > 0) {
        baseQuery.nodeId = { $in: nodeIds };
        return this.find(baseQuery);
      }
    }
  }
  
  // Employee sees their assigned scope data
  if (user.userType === 'employee' && user.clientId === clientId) {
    const Flowchart = mongoose.model('Flowchart');
    const flowchart = await Flowchart.findOne({ clientId, isActive: true });
    
    if (flowchart) {
      const assignedScopes = [];
      flowchart.nodes.forEach(node => {
        node.details.scopeDetails.forEach(scope => {
          const assignedEmployees = scope.assignedEmployees || [];
          if (assignedEmployees.map(id => id.toString()).includes(userId.toString())) {
            assignedScopes.push({
              nodeId: node.id,
              scopeIdentifier: scope.scopeIdentifier
            });
          }
        });
      });
      
      if (assignedScopes.length > 0) {
        baseQuery.$or = assignedScopes.map(scope => ({
          nodeId: scope.nodeId,
          scopeIdentifier: scope.scopeIdentifier
        }));
        return this.find(baseQuery);
      }
    }
  }
  
  return [];
};

// Static method for bulk operations with permission checks
DataEntrySchema.statics.bulkUpdateWithPermissions = async function(userId, updates) {
  const results = { success: 0, failed: 0, errors: [] };
  
  for (const update of updates) {
    try {
      const entry = await this.findById(update.entryId);
      if (!entry) {
        results.failed++;
        results.errors.push({ entryId: update.entryId, error: 'Entry not found' });
        continue;
      }
      
      const canEdit = await entry.canBeEditedBy(userId);
      if (!canEdit.allowed) {
        results.failed++;
        results.errors.push({ 
          entryId: update.entryId, 
          error: `Permission denied: ${canEdit.reason}` 
        });
        continue;
      }
      
      // Apply updates
      Object.assign(entry, update.data);
      entry.addEditHistory(userId, update.reason, entry.toObject(), update.changeDescription);
      
      await entry.save();
      results.success++;
      
    } catch (error) {
      results.failed++;
      results.errors.push({ entryId: update.entryId, error: error.message });
    }
  }
  
  return results;
};

// Static method to get latest cumulative values
DataEntrySchema.statics.getLatestCumulative = async function(clientId, nodeId, scopeIdentifier, inputType) {
  const latest = await this.findOne({
    clientId,
    nodeId,
    scopeIdentifier,
    inputType
  }).sort({ timestamp: -1 });
  
  if (!latest) return null;
  
  return {
    cumulativeValues: latest.cumulativeValues,
    highData: latest.highData,
    lowData: latest.lowData,
    lastEnteredData: latest.lastEnteredData,
    dataEntryCumulative: latest.dataEntryCumulative || null
  };
};

module.exports = mongoose.model('DataEntry', DataEntrySchema);