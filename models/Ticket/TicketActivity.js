// models/Ticket/TicketActivity.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * Attachment sub-schema (for comments)
 */
const activityAttachmentSchema = new Schema({
  filename: { type: String, required: true },
  fileUrl: { type: String, required: true },
  s3Key: { type: String, required: true },
  bucket: { type: String, required: true },
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  uploadedAt: { type: Date, default: Date.now },
  fileSize: { type: Number },
  mimeType: { type: String }
}, { _id: true });

/**
 * Comment details
 */
const commentSchema = new Schema({
  text: { type: String, required: true },
  isInternal: { type: Boolean, default: false },
  mentions: [{
    type: Schema.Types.ObjectId,
    ref: 'User'
  }]
}, { _id: false });

/**
 * Change tracking
 */
const changesSchema = new Schema({
  field: { type: String, required: true },
  oldValue: { type: String },
  newValue: { type: String }
}, { _id: false });

/**
 * Main TicketActivity Schema
 */
const ticketActivitySchema = new Schema({
  // Parent ticket
  ticket: {
    type: Schema.Types.ObjectId,
    ref: 'Ticket',
    required: true,
    index: true
  },

  // Activity type
  activityType: {
    type: String,
    required: true,
    enum: [
      'comment',
      'status_change',
      'assignment',
      'escalation',
      'attachment',
      'priority_change',
      'tag_change',
      'watcher_change',
      'resolution',
      'reopened',
      'created'
    ]
  },

  // Comment details (if activityType = comment)
  comment: commentSchema,

  // Change details (if activityType = status_change, etc.)
  changes: [changesSchema],

  // Attachments (if activityType = attachment or comment with files)
  attachments: [activityAttachmentSchema],

  // Who performed the activity
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

  // Timestamp
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },

  // Edit tracking
  isEdited: {
    type: Boolean,
    default: false
  },
  
  editedAt: {
    type: Date
  },

  // Soft delete
  isDeleted: {
    type: Boolean,
    default: false
  },
  
  deletedAt: {
    type: Date
  }
}, {
  timestamps: false // Using custom createdAt
});

// ===== INDEXES =====
ticketActivitySchema.index({ ticket: 1, createdAt: -1 });
ticketActivitySchema.index({ activityType: 1 });

module.exports = mongoose.model('TicketActivity', ticketActivitySchema);