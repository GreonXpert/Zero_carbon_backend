// models/Ticket/TicketChat.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

/**
 * Attachment sub-schema for chat messages
 */
const chatAttachmentSchema = new Schema(
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
 * Sender information sub-schema
 */
const senderSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    userName: { type: String, required: true },
    userType: { 
      type: String, 
      required: true,
      enum: [
        'client',
        'client_admin', 
        'employee',
        'auditor',
        'consultant',
        'consultant_admin',
        'support',
        'supportManager',
        'super_admin'
      ]
    }
  },
  { _id: false }
);

/**
 * Main TicketChat Schema
 * This schema stores all chat messages (comments and replies) for tickets
 */
const ticketChatSchema = new Schema(
  {
    // Reference to parent ticket
    ticketId: {
      type: Schema.Types.ObjectId,
      ref: "Ticket",
      required: true,
      index: true,
    },

    // Message type: comment (from client/consultant) or reply (from support)
    messageType: {
      type: String,
      required: true,
      enum: ["comment", "reply"],
      index: true,
    },

    // For replies, reference to the parent comment
    // For comments, this will be null
    parentCommentId: {
      type: Schema.Types.ObjectId,
      ref: "TicketChat",
      default: null,
      index: true,
    },

    // The actual message content
    message: {
      type: String,
      required: true,
      maxlength: 5000,
    },

    // Sender information (embedded for performance)
    sender: {
      type: senderSchema,
      required: true,
    },

    // Attachments (optional)
    attachments: [chatAttachmentSchema],

    // Mentioned users (for notifications)
    mentions: [{
      type: Schema.Types.ObjectId,
      ref: "User",
    }],

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
    deletedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },

    // Read receipts (optional - for future enhancement)
    readBy: [{
      userId: { type: Schema.Types.ObjectId, ref: "User" },
      readAt: { type: Date, default: Date.now }
    }],

    // Client context (for multi-tenant filtering)
    clientId: {
      type: String,
      required: true,
      index: true,
    }
  },
  {
    timestamps: true, // Automatically adds createdAt and updatedAt
  }
);

// ===== INDEXES =====
ticketChatSchema.index({ ticketId: 1, messageType: 1, createdAt: -1 });
ticketChatSchema.index({ ticketId: 1, parentCommentId: 1, createdAt: 1 });
ticketChatSchema.index({ "sender.userId": 1, createdAt: -1 });
ticketChatSchema.index({ clientId: 1, ticketId: 1 });
ticketChatSchema.index({ isDeleted: 1, ticketId: 1 });

// ===== INSTANCE METHODS =====

/**
 * Check if message can be edited
 * Rules: Only owner can edit, within 24 hours, not deleted
 */
ticketChatSchema.methods.canEdit = function(userId) {
  if (this.isDeleted) return false;
  if (this.sender.userId.toString() !== userId.toString()) return false;
  
  const hoursSinceCreation = (Date.now() - this.createdAt) / (1000 * 60 * 60);
  return hoursSinceCreation < 24; // Can edit within 24 hours
};

/**
 * Check if message can be deleted
 * Rules: Owner within 5 minutes, or admin anytime
 */
ticketChatSchema.methods.canDelete = function(userId, userType) {
  if (this.isDeleted) return false;
  
  // Super admin can delete anytime
  if (userType === 'super_admin') return true;
  
  // Owner can delete within 5 minutes
  if (this.sender.userId.toString() === userId.toString()) {
    const minutesSinceCreation = (Date.now() - this.createdAt) / (1000 * 60);
    return minutesSinceCreation < 5;
  }
  
  return false;
};

/**
 * Mark as read by user
 */
ticketChatSchema.methods.markAsRead = function(userId) {
  const alreadyRead = this.readBy.some(r => r.userId.toString() === userId.toString());
  if (!alreadyRead) {
    this.readBy.push({ userId, readAt: new Date() });
  }
};

// ===== STATIC METHODS =====

/**
 * Get chat history for a ticket
 * Returns comments with their replies nested
 */
ticketChatSchema.statics.getChatHistory = async function(ticketId, options = {}) {
  const { 
    includeDeleted = false, 
    limit = 100,
    page = 1 
  } = options;

  const query = { 
    ticketId, 
    messageType: 'comment'
  };
  
  if (!includeDeleted) {
    query.isDeleted = false;
  }

  const skip = (page - 1) * limit;

  // Get all comments
  const comments = await this.find(query)
    .sort({ createdAt: 1 })
    .skip(skip)
    .limit(limit)
    .populate('mentions', 'userName email userType')
    .lean();

  // Get all replies for these comments
  const commentIds = comments.map(c => c._id);
  const replies = await this.find({
    parentCommentId: { $in: commentIds },
    ...(includeDeleted ? {} : { isDeleted: false })
  })
    .sort({ createdAt: 1 })
    .populate('mentions', 'userName email userType')
    .lean();

  // Nest replies under their parent comments
  const commentsWithReplies = comments.map(comment => ({
    ...comment,
    replies: replies.filter(reply => 
      reply.parentCommentId.toString() === comment._id.toString()
    )
  }));

  return commentsWithReplies;
};

/**
 * Get unread count for a user on a ticket
 */
ticketChatSchema.statics.getUnreadCount = async function(ticketId, userId) {
  return await this.countDocuments({
    ticketId,
    isDeleted: false,
    'readBy.userId': { $ne: userId }
  });
};

/**
 * Get reply count for a comment
 */
ticketChatSchema.statics.getReplyCount = async function(commentId) {
  return await this.countDocuments({
    parentCommentId: commentId,
    isDeleted: false
  });
};

// ===== PRE-SAVE HOOKS =====

/**
 * Before saving, validate message type constraints
 */
ticketChatSchema.pre('save', function(next) {
  // Comments should not have parentCommentId
  if (this.messageType === 'comment' && this.parentCommentId) {
    this.parentCommentId = null;
  }
  
  // Replies must have parentCommentId
  if (this.messageType === 'reply' && !this.parentCommentId) {
    return next(new Error('Replies must have a parentCommentId'));
  }
  
  next();
});

// ===== VIRTUAL PROPERTIES =====

/**
 * Virtual property to check if message is recent (within 1 hour)
 */
ticketChatSchema.virtual('isRecent').get(function() {
  const hoursSinceCreation = (Date.now() - this.createdAt) / (1000 * 60 * 60);
  return hoursSinceCreation < 1;
});

// ===== MODEL EXPORT =====
const TicketChat = mongoose.model("TicketChat", ticketChatSchema);

module.exports = TicketChat;