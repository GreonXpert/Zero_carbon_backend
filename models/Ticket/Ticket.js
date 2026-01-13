// models/Ticket/Ticket.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * Counter for TicketID generation (per year)
 * Format: TKT-YYYY-00001
 */
const ticketCounterSchema = new Schema({
  _id: { type: String, required: true }, // e.g., "ticket_2024"
  seq: { type: Number, default: 0 }
});

const TicketCounter = mongoose.model('TicketCounter', ticketCounterSchema);

/**
 * Attachment sub-schema
 */
const attachmentSchema = new Schema({
  filename: { type: String, required: true },
  fileUrl: { type: String, required: true },
  s3Key: { type: String, required: true },
  bucket: { type: String, required: true },
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  uploadedAt: { type: Date, default: Date.now },
  fileSize: { type: Number }, // bytes
  mimeType: { type: String }
}, { _id: true });

/**
 * Related entities for context linking
 */
const relatedEntitiesSchema = new Schema({
  flowchartId: { type: String },
  nodeId: { type: String },
  scopeIdentifier: { type: String },
  dataEntryId: { type: Schema.Types.ObjectId, ref: 'DataEntry' },
  summaryId: { type: Schema.Types.ObjectId, ref: 'EmissionSummary' },
  processFlowId: { type: String }
}, { _id: false });

/**
 * Last viewed by tracking
 */
const lastViewedBySchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  viewedAt: { type: Date, default: Date.now }
}, { _id: false });

/**
 * Resolution details
 */
const resolutionSchema = new Schema({
  resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  resolutionNotes: { type: String },
  resolutionDate: { type: Date },
  satisfactionRating: { type: Number, min: 1, max: 5 },
  userFeedback: { type: String }
}, { _id: false });

/**
 * Main Ticket Schema
 */
const ticketSchema = new Schema({
  // Unique ticket identifier
  ticketId: {
    type: String,
    unique: true,
    required: true
  },

  // Client & User Context
  clientId: {
    type: String,
    required: true,
    index: true
  },
  
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  createdByType: {
    type: String,
    required: true,
    enum: ['super_admin', 'consultant_admin', 'consultant', 'client_admin', 
           'client_employee_head', 'employee', 'auditor', 'viewer']
  },
  
  assignedTo: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },
  
  assignedToType: {
    type: String,
    enum: ['super_admin', 'consultant_admin', 'consultant', 'client_admin', 
           'client_employee_head', 'employee']
  },

  // Ticket Details
  category: {
    type: String,
    required: true,
    enum: ['Data Issues', 'Flowchart/Process Issues', 'System Access', 
           'Feature Requests', 'Technical Support', 'Compliance & Audit', 
           'Billing & Subscription']
  },
  
  subCategory: {
    type: String
  },
  
  subject: {
    type: String,
    required: true,
    maxlength: 200
  },
  
  description: {
    type: String,
    required: true
  },
  
  priority: {
    type: String,
    required: true,
    enum: ['critical', 'high', 'medium', 'low'],
    default: 'medium'
  },
  
  status: {
    type: String,
    required: true,
    enum: ['draft', 'open', 'assigned', 'in_progress', 'pending_info', 
           'pending_approval', 'resolved', 'closed', 'reopened', 
           'escalated', 'cancelled'],
    default: 'open'
  },

  // Related Entities
  relatedEntities: relatedEntitiesSchema,

  // Attachments
  attachments: [attachmentSchema],

  // Timeline Fields
  createdAt: {
    type: Date,
    default: Date.now
  },
  
  updatedAt: {
    type: Date,
    default: Date.now
  },
  
  firstResponseAt: {
    type: Date
  },
  
  resolvedAt: {
    type: Date
  },
  
  closedAt: {
    type: Date
  },
  
  dueDate: {
    type: Date
  },

  // Escalation
  isEscalated: {
    type: Boolean,
    default: false
  },
  
  escalatedAt: {
    type: Date
  },
  
  escalatedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },
  
  escalationReason: {
    type: String
  },
  
  escalationLevel: {
    type: Number,
    default: 0,
    min: 0,
    max: 3
  },

  // Metadata
  tags: [{
    type: String
  }],
  
  watchers: [{
    type: Schema.Types.ObjectId,
    ref: 'User'
  }],
  
  viewCount: {
    type: Number,
    default: 0
  },
  
  lastViewedBy: [lastViewedBySchema],

  // Resolution
  resolution: resolutionSchema,

  // Approval (for critical changes)
  requiresApproval: {
    type: Boolean,
    default: false
  },
  
  approvalStatus: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  
  approvedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },
  
  approvalDate: {
    type: Date
  },

  // Sandbox flag
  sandbox: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// ===== INDEXES =====
ticketSchema.index({ ticketId: 1 }, { unique: true });
ticketSchema.index({ clientId: 1, status: 1, priority: 1, updatedAt: -1 });
ticketSchema.index({ assignedTo: 1, status: 1 });
ticketSchema.index({ createdBy: 1, status: 1 });
ticketSchema.index({ status: 1, dueDate: 1 });
ticketSchema.index({ category: 1 });
ticketSchema.index({ isEscalated: 1, status: 1 });
ticketSchema.index({ sandbox: 1 });

// Text index for search
ticketSchema.index({ 
  subject: 'text', 
  description: 'text' 
});

// ===== STATIC METHODS =====

/**
 * Generate next ticket ID
 * Format: TKT-YYYY-00001
 */
ticketSchema.statics.generateTicketId = async function() {
  const year = new Date().getFullYear();
  const counterKey = `ticket_${year}`;
  
  const counter = await TicketCounter.findByIdAndUpdate(
    counterKey,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  
  const seqStr = String(counter.seq).padStart(5, '0');
  return `TKT-${year}-${seqStr}`;
};

/**
 * Calculate SLA due date based on priority
 */
ticketSchema.statics.calculateDueDate = function(priority, createdAt = new Date()) {
  const SLA_CONFIG = {
    critical: 4 * 60 * 60 * 1000,          // 4 hours
    high: 24 * 60 * 60 * 1000,             // 24 hours
    medium: 3 * 24 * 60 * 60 * 1000,       // 3 days
    low: 7 * 24 * 60 * 60 * 1000           // 7 days
  };
  
  const slaTime = SLA_CONFIG[priority] || SLA_CONFIG.medium;
  return new Date(createdAt.getTime()  + slaTime);
};

/**
 * Check if ticket is overdue
 */
ticketSchema.methods.isOverdue = function() {
  if (!this.dueDate) return false;
  if (['resolved', 'closed', 'cancelled'].includes(this.status)) return false;
  return new Date() > this.dueDate;
};

/**
 * Check if ticket is due soon (80% of SLA elapsed)
 */
ticketSchema.methods.isDueSoon = function() {
  if (!this.dueDate) return false;
  if (['resolved', 'closed', 'cancelled'].includes(this.status)) return false;
  
  const now = new Date();
  const created = this.createdAt;
  const due = this.dueDate;
  
  const totalTime = due.getTime() - created.getTime();
  const elapsed = now.getTime() - created.getTime();
  const percentElapsed = (elapsed / totalTime) * 100;
  
  return percentElapsed >= 80 && percentElapsed < 100;
};

/**
 * Get time remaining until due (in milliseconds)
 */
ticketSchema.methods.getTimeRemaining = function() {
  if (!this.dueDate) return null;
  const now = new Date();
  return this.dueDate.getTime() - now.getTime();
};

/**
 * Add a watcher
 */
ticketSchema.methods.addWatcher = function(userId) {
  const userIdStr = userId.toString();
  const watcherIds = this.watchers.map(w => w.toString());
  
  if (!watcherIds.includes(userIdStr)) {
    this.watchers.push(userId);
  }
};

/**
 * Remove a watcher
 */
ticketSchema.methods.removeWatcher = function(userId) {
  const userIdStr = userId.toString();
  this.watchers = this.watchers.filter(w => w.toString() !== userIdStr);
};

/**
 * Record view
 */
ticketSchema.methods.recordView = function(userId) {
  this.viewCount = 1;
  
  // Update or add lastViewedBy entry (limit to 10 recent viewers)
  const existingIndex = this.lastViewedBy.findIndex(
    v => v.userId.toString() === userId.toString()
  );
  
  if (existingIndex >= 0) {
    this.lastViewedBy[existingIndex].viewedAt = new Date();
  } else {
    this.lastViewedBy.unshift({
      userId: userId,
      viewedAt: new Date()
    });
    
    // Keep only last 10 viewers
    if (this.lastViewedBy.length > 10) {
      this.lastViewedBy = this.lastViewedBy.slice(0, 10);
    }
  }
};

// ===== MIDDLEWARE =====

// Update timestamps
ticketSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Ensure watchers include creator and assignee
ticketSchema.pre('save', function(next) {
  // Add creator as watcher
  if (this.createdBy) {
    this.addWatcher(this.createdBy);
  }
  
  // Add assignee as watcher
  if (this.assignedTo) {
    this.addWatcher(this.assignedTo);
  }
  
  next();
});

const Ticket = mongoose.model('Ticket', ticketSchema);

module.exports = { Ticket, TicketCounter };
