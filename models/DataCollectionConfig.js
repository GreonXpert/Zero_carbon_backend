const mongoose = require('mongoose');
const { Schema } = mongoose;

const DataCollectionConfigSchema = new Schema({
  // Unique identifiers
  clientId: {
    type: String,
    required: true,
    index: true
  },
  nodeId: {
    type: String,
    required: true
  },
  scopeIdentifier: {
    type: String,
    required: true
  },
  scopeType: {
    type: String,
    enum: ['Scope 1', 'Scope 2', 'Scope 3'],
    required: true
  },
  
  // Current input configuration
  inputType: {
    type: String,
    enum: ['manual', 'API', 'IOT'],
    required: true
  },
  
  // Collection frequency and scheduling
  collectionFrequency: {
    type: String,
    enum: ['real-time', 'daily', 'weekly', 'monthly', 'quarterly', 'annually'],
    // required: true
  },
  
  // Connection details
  connectionDetails: {
    // API specific
    apiEndpoint: String,
    apiKey: String,
    apiHeaders: Schema.Types.Mixed,
    apiMethod: {
      type: String,
      enum: ['GET', 'POST'],
      default: 'GET'
    },
    
    // IoT specific
    deviceId: String,
    deviceType: String,
    mqttTopic: String,
    
    // Common
    isActive: {
      type: Boolean,
      default: false
    },
    lastConnectionTest: Date,
    connectionErrors: [String]
  },
  
  // Data collection tracking
  collectionStatus: {
    lastCollectionDate: Date,
    lastCollectionTime: String,
    nextDueDate: Date,
    totalDataPointsCollected: {
      type: Number,
      default: 0
    },
    lastDataPointId: {
      type: Schema.Types.ObjectId,
      ref: 'DataEntry'
    },
    consecutiveFailures: {
      type: Number,
      default: 0
    },
    isOverdue: {
      type: Boolean,
      default: false
    }
  },
  
  // Data validation rules
  validationRules: {
    minValue: Number,
    maxValue: Number,
    allowedUnits: [String],
    requiredFields: [String],
    customValidation: String // JavaScript function as string
  },
  
  // Alert configuration
  alertConfig: {
    enableAlerts: {
      type: Boolean,
      default: true
    },
    alertOnMissedCollection: {
      type: Boolean,
      default: true
    },
    alertOnDataAnomaly: {
      type: Boolean,
      default: false
    },
    alertRecipients: [{
      userId: {
        type: Schema.Types.ObjectId,
        ref: 'User'
      },
      notificationMethods: {
        email: Boolean,
        inApp: Boolean
      }
    }],
    gracePeriodHours: {
      type: Number,
      default: 24
    }
  },
  
  // History of input type changes
  inputTypeHistory: [{
    previousType: String,
    newType: String,
    changedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    changedAt: Date,
    reason: String
  }],
  
  // Metadata
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    // required: true
  },
  lastModifiedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },
  isActive: {
    type: Boolean,
    default: true
  }

}, {
  timestamps: true
});

// Unique compound index
DataCollectionConfigSchema.index({ clientId: 1, nodeId: 1, scopeIdentifier: 1 }, { unique: true });

// Index for finding overdue collections
DataCollectionConfigSchema.index({ 'collectionStatus.nextDueDate': 1, 'collectionStatus.isOverdue': 1 });

// Calculate next due date based on frequency
DataCollectionConfigSchema.methods.calculateNextDueDate = function(fromDate = null) {
  const baseDate = fromDate || this.collectionStatus.lastCollectionDate || new Date();
  let nextDue = new Date(baseDate);
  
  switch (this.collectionFrequency) {
    case 'real-time':
      // Real-time doesn't have a due date
      return null;
    case 'daily':
      nextDue.setDate(nextDue.getDate() + 1);
      break;
    case 'weekly':
      nextDue.setDate(nextDue.getDate() + 7);
      break;
    case 'monthly':
      nextDue.setMonth(nextDue.getMonth() + 1);
      break;
    case 'quarterly':
      nextDue.setMonth(nextDue.getMonth() + 3);
      break;
    case 'annually':
      nextDue.setFullYear(nextDue.getFullYear() + 1);
      break;
  }
  
  return nextDue;
};

// Update collection status after receiving data
DataCollectionConfigSchema.methods.updateCollectionStatus = function(dataEntryId, timestamp) {
  this.collectionStatus.lastCollectionDate = timestamp;
  this.collectionStatus.lastCollectionTime = timestamp.toTimeString().split(' ')[0];
  this.collectionStatus.totalDataPointsCollected += 1;
  this.collectionStatus.lastDataPointId = dataEntryId;
  this.collectionStatus.consecutiveFailures = 0;
  this.collectionStatus.isOverdue = false;
  
  // Calculate next due date for manual inputs
  if (this.inputType === 'manual') {
    this.collectionStatus.nextDueDate = this.calculateNextDueDate(timestamp);
  }
  
  // Set connection as active for API/IoT
  if (['API', 'IOT'].includes(this.inputType)) {
    this.connectionDetails.isActive = true;
  }
};

// Check if collection is overdue
DataCollectionConfigSchema.methods.checkOverdueStatus = function() {
  if (!this.collectionStatus.nextDueDate || this.inputType !== 'manual') {
    return false;
  }
  
  const now = new Date();
  const gracePeriod = this.alertConfig.gracePeriodHours * 60 * 60 * 1000; // Convert hours to milliseconds
  
  return (now - this.collectionStatus.nextDueDate) > gracePeriod;
};

// Static method to find all overdue collections
DataCollectionConfigSchema.statics.findOverdueCollections = function() {
  const now = new Date();
  return this.find({
    inputType: 'manual',
    'collectionStatus.nextDueDate': { $lt: now },
    'collectionStatus.isOverdue': false,
    isActive: true
  });
};

module.exports = mongoose.model('DataCollectionConfig', DataCollectionConfigSchema);