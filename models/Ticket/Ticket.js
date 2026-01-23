// models/Ticket/Ticket.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

/**
 * Counter for TicketID generation (per year)
 * Format: TKT-YYYY-00001
 */
const ticketCounterSchema = new Schema({
  _id: { type: String, required: true }, // e.g., "ticket_2024"
  seq: { type: Number, default: 0 },
});

// Prevent OverwriteModelError in dev/hot-reload
const TicketCounter =
  mongoose.models.TicketCounter || mongoose.model("TicketCounter", ticketCounterSchema);

/**
 * Attachment sub-schema
 */
const attachmentSchema = new Schema(
  {
    filename: { type: String, required: true },
    fileUrl: { type: String, required: true },
    s3Key: { type: String, required: true },
    bucket: { type: String, required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    uploadedAt: { type: Date, default: Date.now },
    fileSize: { type: Number }, // bytes
    mimeType: { type: String },
  },
  { _id: true }
);

/**
 * Related entities for context linking
 */
const relatedEntitiesSchema = new Schema(
  {
    flowchartId: { type: String },
    nodeId: { type: String },
    scopeIdentifier: { type: String },
    dataEntryId: { type: Schema.Types.ObjectId, ref: "DataEntry" },
    summaryId: { type: Schema.Types.ObjectId, ref: "EmissionSummary" },
    processFlowId: { type: String },
  },
  { _id: false }
);

/**
 * Last viewed by tracking
 */
const lastViewedBySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    viewedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

/**
 * Resolution details
 */
const resolutionSchema = new Schema(
  {
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    resolutionNotes: { type: String },
    resolutionDate: { type: Date },
    satisfactionRating: { type: Number, min: 1, max: 5 },
    userFeedback: { type: String },
  },
  { _id: false }
);

/**
 * 🆕 Consultant context tracking
 * Tracks consultant/consultant_admin relationship for reporting
 */
const consultantContextSchema = new Schema(
  {
    // For tickets created by consultants/consultant_admins about their own issues
    isConsultantIssue: { type: Boolean, default: false },
    
    // For tickets created by client users - track which consultant oversees this client
    consultantAdminId: { type: Schema.Types.ObjectId, ref: "User" },
    consultantAdminName: { type: String },
    
    assignedConsultantId: { type: Schema.Types.ObjectId, ref: "User" },
    assignedConsultantName: { type: String },
    
    // Timestamp when consultant context was set
    contextSetAt: { type: Date },
  },
  { _id: false }
);

/**
 * Main Ticket Schema
 */
const ticketSchema = new Schema(
  {
    // Unique ticket identifier
    ticketId: {
      type: String,
      unique: true,
      required: true,
      index: true,
    },

    // Client & User Context
    // 🆕 UPDATED: clientId is now optional - for consultant internal issues, will be "INTERNAL-SUPPORT"
    clientId: {
      type: String,
      required: true, // Still required, but will use system value for consultant issues
      index: true,
    },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    createdByType: {
      type: String,
      required: true,
      enum: [
        "super_admin",
        "consultant_admin",
        "consultant",
        "client_admin",
        "client_employee_head",
        "employee",
        "auditor",
        "viewer",
        "supportManager",
        "support",
      ],
      index: true,
    },

    // Owning queue (Support Manager for this ticket)
    supportManagerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
      default: null, // allow unassigned → super_admin queue fallback
    },

    // Working assignee (Support User after assignment)
    assignedTo: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    assignedToType: {
      type: String,
      enum: [
        "super_admin",
        "consultant_admin",
        "consultant",
        "client_admin",
        "client_employee_head",
        "employee",
        "viewer",
        "auditor",
        "supportManager",
        "support",
      ],
      default: null, // allow unassigned tickets
    },

    // 🆕 Consultant Context
    consultantContext: consultantContextSchema,

    // Ticket Details
    category: {
      type: String,
      required: true,
      enum: [
        "Data Issues",
        "Flowchart/Process Issues",
        "System Access",
        "Feature Requests",
        "Technical Support",
        "Compliance & Audit",
        "Billing & Subscription",
        "Consultant Support", // 🆕 New category for consultant-specific issues
        "Client Management", // 🆕 New category for client management issues
      ],
      index: true,
    },

    subCategory: {
      type: String,
    },

    subject: {
      type: String,
      required: true,
      maxlength: 200,
    },

    description: {
      type: String,
      required: true,
    },

    priority: {
      type: String,
      required: true,
      enum: ["critical", "high", "medium", "low"],
      default: "medium",
      index: true,
    },

    status: {
      type: String,
      required: true,
      enum: [
        "draft",
        "open",
        "assigned",
        "in_progress",
        "pending_info",
        "pending_approval",
        "resolved",
        "closed",
        "reopened",
        "escalated",
        "cancelled",
      ],
      default: "open",
      index: true,
    },

    // Related Entities
    relatedEntities: relatedEntitiesSchema,

    // Attachments
    attachments: [attachmentSchema],

    // Timeline Fields (timestamps plugin will manage createdAt/updatedAt)
    firstResponseAt: { type: Date },
    resolvedAt: { type: Date },
    closedAt: { type: Date },
    dueDate: { type: Date, index: true },

    // Escalation
    isEscalated: { type: Boolean, default: false, index: true },
    escalatedAt: { type: Date },
    escalatedBy: { type: Schema.Types.ObjectId, ref: "User" },
    escalationReason: { type: String },
    escalationLevel: { type: Number, default: 0, min: 0, max: 3 },

    // Metadata
    tags: [{ type: String }],
    watchers: [{ type: Schema.Types.ObjectId, ref: "User" }],
    viewCount: { type: Number, default: 0 },
    lastViewedBy: [lastViewedBySchema],

    // SLA/automation state (used by SLA checker: ticket.metadata.*)
    metadata: { type: Schema.Types.Mixed, default: {} },

    // Resolution
    resolution: resolutionSchema,

    // Approval (for critical changes)
    requiresApproval: { type: Boolean, default: false },
    approvalStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    approvalDate: { type: Date },

    // Sandbox flag
    sandbox: { type: Boolean, default: false, index: true },
  },
  {
    timestamps: true, // creates createdAt & updatedAt
  }
);

// ===== INDEXES =====
ticketSchema.index({ ticketId: 1 }, { unique: true });
ticketSchema.index({ clientId: 1, status: 1, priority: 1, updatedAt: -1 });
ticketSchema.index({ assignedTo: 1, status: 1 });
ticketSchema.index({ createdBy: 1, status: 1 });
ticketSchema.index({ status: 1, dueDate: 1 });
ticketSchema.index({ isEscalated: 1, status: 1 });
ticketSchema.index({ sandbox: 1 });

// Support-manager queue performance
ticketSchema.index({ supportManagerId: 1, status: 1, updatedAt: -1 });

// 🆕 Consultant context indexes
ticketSchema.index({ "consultantContext.isConsultantIssue": 1 });
ticketSchema.index({ "consultantContext.consultantAdminId": 1, status: 1 });
ticketSchema.index({ "consultantContext.assignedConsultantId": 1, status: 1 });
ticketSchema.index({ createdByType: 1, status: 1 });

// Text index for search
ticketSchema.index({
  subject: "text",
  description: "text",
});

// ===== STATIC METHODS =====

/**
 * Generate next ticket ID
 * Format: TKT-YYYY-00001
 */
ticketSchema.statics.generateTicketId = async function () {
  const year = new Date().getFullYear();
  const counterKey = `ticket_${year}`;

  const counter = await TicketCounter.findByIdAndUpdate(
    counterKey,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );

  const seqStr = String(counter.seq).padStart(5, "0");
  return `TKT-${year}-${seqStr}`;
};

/**
 * Calculate SLA due date based on priority
 */
ticketSchema.statics.calculateDueDate = function (priority, createdAt = new Date()) {
  const SLA_CONFIG = {
    critical: 4 * 60 * 60 * 1000, // 4 hours
    high: 24 * 60 * 60 * 1000, // 24 hours
    medium: 3 * 24 * 60 * 60 * 1000, // 3 days
    low: 7 * 24 * 60 * 60 * 1000, // 7 days
  };

  const slaTime = SLA_CONFIG[priority] || SLA_CONFIG.medium;
  return new Date(createdAt.getTime() + slaTime);
};

/**
 * Check if ticket is overdue
 */
ticketSchema.methods.isOverdue = function () {
  if (!this.dueDate) return false;
  if (["resolved", "closed", "cancelled"].includes(this.status)) return false;
  return new Date() > this.dueDate;
};

/**
 * Check if ticket is due soon (80% of SLA elapsed)
 */
ticketSchema.methods.isDueSoon = function () {
  if (!this.dueDate) return false;
  if (["resolved", "closed", "cancelled"].includes(this.status)) return false;

  const now = new Date();
  const created = this.createdAt;
  const due = this.dueDate;

  const totalTime = due.getTime() - created.getTime();
  if (totalTime <= 0) return false;

  const elapsed = now.getTime() - created.getTime();
  const percentElapsed = (elapsed / totalTime) * 100;

  return percentElapsed >= 80 && percentElapsed < 100;
};

/**
 * Get time remaining until due (in milliseconds)
 */
ticketSchema.methods.getTimeRemaining = function () {
  if (!this.dueDate) return null;
  const now = new Date();
  return this.dueDate.getTime() - now.getTime();
};

/**
 * 🆕 Check if this is an internal consultant issue
 */
ticketSchema.methods.isInternalIssue = function () {
  return this.clientId === 'INTERNAL-SUPPORT' || this.consultantContext?.isConsultantIssue === true;
};

/**
 * Add a watcher
 */
ticketSchema.methods.addWatcher = function (userId) {
  if (!userId) return;
  const userIdStr = userId.toString();
  const watcherIds = (this.watchers || []).map((w) => w.toString());

  if (!watcherIds.includes(userIdStr)) {
    this.watchers.push(userId);
  }
};

/**
 * Remove a watcher
 */
ticketSchema.methods.removeWatcher = function (userId) {
  if (!userId) return;
  const userIdStr = userId.toString();
  this.watchers = (this.watchers || []).filter((w) => w.toString() !== userIdStr);
};

/**
 * Record view
 */
ticketSchema.methods.recordView = function (userId) {
  this.viewCount = (this.viewCount || 0) + 1;

  // Update or add lastViewedBy entry (limit to 10 recent viewers)
  const existingIndex = (this.lastViewedBy || []).findIndex(
    (v) => v.userId.toString() === userId.toString()
  );

  if (existingIndex >= 0) {
    this.lastViewedBy[existingIndex].viewedAt = new Date();
  } else {
    this.lastViewedBy.unshift({
      userId: userId,
      viewedAt: new Date(),
    });

    // Keep only last 10 viewers
    if (this.lastViewedBy.length > 10) {
      this.lastViewedBy = this.lastViewedBy.slice(0, 10);
    }
  }
};

// ===== MIDDLEWARE =====

// assignedToType is required only when assignedTo is set
ticketSchema.pre("validate", function (next) {
  if (this.assignedTo && !this.assignedToType) {
    return next(new Error("assignedToType is required when assignedTo is set"));
  }
  next();
});

// Ensure watchers include creator and assignee
ticketSchema.pre("save", function (next) {
  if (this.createdBy) this.addWatcher(this.createdBy);
  if (this.assignedTo) this.addWatcher(this.assignedTo);
  
  // 🆕 Auto-add consultant admin and consultant to watchers if present
  if (this.consultantContext?.consultantAdminId) {
    this.addWatcher(this.consultantContext.consultantAdminId);
  }
  if (this.consultantContext?.assignedConsultantId) {
    this.addWatcher(this.consultantContext.assignedConsultantId);
  }
  
  next();
});

// Prevent OverwriteModelError in dev/hot-reload
const Ticket = mongoose.models.Ticket || mongoose.model("Ticket", ticketSchema);

module.exports = { Ticket, TicketCounter };