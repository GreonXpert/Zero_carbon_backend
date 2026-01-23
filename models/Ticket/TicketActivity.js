// models/Ticket/TicketActivity.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

/**
 * Attachment sub-schema (for comments)
 */
const activityAttachmentSchema = new Schema(
  {
    filename: { type: String, required: true },
    fileUrl: { type: String, required: true },
    s3Key: { type: String, required: true },
    bucket: { type: String, required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    uploadedAt: { type: Date, default: Date.now },
    fileSize: { type: Number },
    mimeType: { type: String },
  },
  { _id: true }
);

/**
 * Comment details
 */
const commentSchema = new Schema(
  {
    text: { type: String, required: true },
    isInternal: { type: Boolean, default: false },
    mentions: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
  },
  { _id: false }
);

/**
 * Change tracking
 */
const changesSchema = new Schema(
  {
    field: { type: String, required: true },
    oldValue: { type: String },
    newValue: { type: String },
  },
  { _id: false }
);

/**
 * Main TicketActivity Schema
 */
const ticketActivitySchema = new Schema(
  {
    // Parent ticket
    ticket: {
      type: Schema.Types.ObjectId,
      ref: "Ticket",
      required: true,
      index: true,
    },

    // Activity type
    activityType: {
      type: String,
      required: true,
      enum: [
        "comment",
        "status_change",
        "assignment",
        "escalation",
        "attachment",
        "priority_change",
        "tag_change",
        "watcher_change",
        "resolution",
        "reopened",
        "created",
        "consultant_context_updated", // 🆕 For tracking consultant context changes
      ],
      index: true,
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
        "viewer",
        "auditor",
        "system",
        "supportManager",
        "support",
      ],
      index: true,
    },

    // Timestamp (custom)
    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    // Edit tracking
    isEdited: {
      type: Boolean,
      default: false,
    },

    editedAt: {
      type: Date,
    },

    // Soft delete
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },

    deletedAt: {
      type: Date,
    },
  },
  {
    timestamps: false, // Using custom createdAt
  }
);

// ===== INDEXES =====
ticketActivitySchema.index({ ticket: 1, createdAt: -1 });
ticketActivitySchema.index({ createdBy: 1, createdAt: -1 });
ticketActivitySchema.index({ activityType: 1, createdAt: -1 });

// ===== VALIDATION (prevents garbage activity docs) =====
ticketActivitySchema.pre("validate", function (next) {
  // comment must have text
  if (this.activityType === "comment") {
    if (!this.comment || !this.comment.text) {
      return next(new Error("comment.text is required when activityType=comment"));
    }
  }

  // change-based activity should have at least one change
  const changeTypes = new Set([
    "status_change",
    "assignment",
    "escalation",
    "priority_change",
    "tag_change",
    "watcher_change",
    "resolution",
    "reopened",
    "consultant_context_updated",
  ]);
  if (changeTypes.has(this.activityType)) {
    if (!Array.isArray(this.changes) || this.changes.length === 0) {
      return next(new Error(`changes[] is required when activityType=${this.activityType}`));
    }
  }

  // attachment activity must have at least one attachment
  if (this.activityType === "attachment") {
    if (!Array.isArray(this.attachments) || this.attachments.length === 0) {
      return next(new Error("attachments[] is required when activityType=attachment"));
    }
  }

  next();
});

// Prevent OverwriteModelError in dev/hot-reload
const TicketActivity =
  mongoose.models.TicketActivity || mongoose.model("TicketActivity", ticketActivitySchema);

module.exports = TicketActivity;