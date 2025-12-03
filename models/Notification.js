const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    // Basic Information
    title: { type: String, required: true },
    message: { type: String, required: true },
    priority: { 
      type: String, 
      enum: ["low", "medium", "high", "urgent"],
      default: "medium"
    },
    
    // Creator Information
    createdBy: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "User", 
      required: true 
    },
    creatorType: { type: String, required: true }, // Store creator's userType
    
    // Target Audience
    targetUserTypes: [{ 
      type: String,
      enum: ["super_admin", "consultant_admin", "consultant", "client_admin", "client_employee_head", "employee", "viewer", "auditor"]
    }],
    targetUsers: [{ 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "User" 
    }], // Specific users
    targetClients: [{ type: String }], // Specific client IDs (e.g., "Greon001")
    
    // Status Management
    status: {
      type: String,
      enum: ["draft", "pending_approval", "scheduled", "published", "cancelled", "expired"],
      default: "draft"
    },
    
    // Approval Workflow
    approvalRequired: { type: Boolean, default: false },
    approvalRequestedAt: { type: Date },
    approvedBy: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "User" 
    },
    approvalDate: { type: Date },
    rejectionReason: { type: String },
    waitlistNotes: { type: String }, // For waitlist status
    
    // Publishing Schedule
    publishDate: { type: Date },
    scheduledPublishDate: { type: Date }, // For 30-minute delay
    publishedAt: { type: Date },
    
    // Cancellation tracking
    cancelledBy: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "User" 
    },
    cancelledAt: { type: Date },
    
    // Expiry Settings
    expiryDate: { type: Date },
    autoDeleteAfterDays: { type: Number },
    
    // Tracking
    readBy: [{
      user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      readAt: { type: Date, default: Date.now }
    }],
    
    // Deletion
    isDeleted: { type: Boolean, default: false },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    deletedAt: { type: Date },
    
    // Additional metadata
    attachments: [{
      name: { type: String },
      url: { type: String },
      type: { type: String }
    }],
    
    // For system notifications (like user status changes, lead creation, etc.)
    isSystemNotification: { type: Boolean, default: false },
    systemAction: { type: String }, // e.g., "user_status_changed", "lead_created"
    relatedEntity: {
      type: { type: String }, // e.g., "user", "client", "lead"
      id: { type: mongoose.Schema.Types.ObjectId }
    }
  },
  { timestamps: true }
);

// Indexes for performance
notificationSchema.index({ createdBy: 1, status: 1 });
notificationSchema.index({ targetUserTypes: 1, status: 1 });
notificationSchema.index({ targetUsers: 1, status: 1 });
notificationSchema.index({ targetClients: 1, status: 1 });
notificationSchema.index({ publishDate: 1, status: 1 });
notificationSchema.index({ scheduledPublishDate: 1, status: 1 });
notificationSchema.index({ expiryDate: 1, status: 1 });
notificationSchema.index({ "readBy.user": 1 });
notificationSchema.index({ isDeleted: 1, status: 1 });
notificationSchema.index({ targetClients: 1, status: 1, createdAt: -1 });
notificationSchema.index({ 'readBy.user': 1 });

// Virtual for checking if notification is active
notificationSchema.virtual('isActive').get(function() {
  return this.status === 'published' && 
         (!this.expiryDate || this.expiryDate > new Date()) &&
         !this.isDeleted;
});

// Method to check if user can view this notification
// In models/Notification.js, replace your existing canBeViewedBy with:
notificationSchema.methods.canBeViewedBy = async function(user) {
  // 1. Normalize caller’s ID to a string (handles both user._id and user.id)
  const userId = (user._id || user.id).toString();

  // 2. Deleted? no one can view
  if (this.isDeleted) return false;

  // 3. Creator can always view
  if (this.createdBy && this.createdBy.toString() === userId) {
    return true;
  }

  // 4. Not yet published? only certain roles…
  if (this.status !== 'published') {
    if (user.userType === 'super_admin') {
      return true;
    }
    if (user.userType === 'consultant_admin' && this.approvalRequired) {
      const User = mongoose.model('User');
      const creator = await User.findById(this.createdBy);
      if (
        creator &&
        creator.consultantAdminId &&
        creator.consultantAdminId.toString() === userId
      ) {
        return true;
      }
    }
    return false;
  }

  // 5. Published → check targeting:

  // 5.a specifically targeted users?
  if (Array.isArray(this.targetUsers) && this.targetUsers.length > 0) {
    const isTargeted = this.targetUsers.some(
      targetId => targetId && targetId.toString() === userId
    );
    return isTargeted;
  }

  // 5.b specific user-types?
  if (Array.isArray(this.targetUserTypes) && this.targetUserTypes.length > 0) {
    if (this.targetUserTypes.includes(user.userType)) {
      return true;
    }
    // types were specified but user isn’t one of them, and no client fallback → deny
    if (!Array.isArray(this.targetClients) || this.targetClients.length === 0) {
      return false;
    }
  }

  // 5.c specific clients?
  if (
    Array.isArray(this.targetClients) &&
    this.targetClients.length > 0 &&
    user.clientId
  ) {
    return this.targetClients.includes(user.clientId);
  }

  // 5.d no targeting at all → global notification
  return true;
};


// Method to mark as read by user
notificationSchema.methods.markAsReadBy = async function(userId) {
  // Ensure readBy is always an array
  if (!Array.isArray(this.readBy)) {
    this.readBy = [];
  }

  // Check if this user has already read it, guarding against undefined read.user
  const alreadyRead = this.readBy.some(read =>
    read.user && read.user.toString() === userId.toString()
  );

  if (!alreadyRead) {
    this.readBy.push({
      user: userId,
      readAt: new Date()
    });
    await this.save();
  }
};


// Static method to get notifications for a user
notificationSchema.statics.getNotificationsForUser = async function(user, options = {}) {
  const {
    includeRead = true,
    limit = 50,
    skip = 0,
    sortBy = '-createdAt'
  } = options;
  
  const baseQuery = {
    status: 'published',
    isDeleted: false,
    $or: [
      { expiryDate: null },
      { expiryDate: { $gt: new Date() } }
    ]
  };
  
  // Build targeting conditions
  const targetingConditions = [];
  
  // 1. Specifically targeted user
  targetingConditions.push({ targetUsers: user._id });
  
  // 2. User type is targeted (only if no specific users are targeted)
  targetingConditions.push({
    targetUserTypes: user.userType,
    targetUsers: { $size: 0 } // Only apply if no specific users are targeted
  });
  
  // 3. Client is targeted (only if no specific users/types are targeted)
  if (user.clientId) {
    targetingConditions.push({
      targetClients: user.clientId,
      targetUsers: { $size: 0 }, // Only apply if no specific users are targeted
      targetUserTypes: { $size: 0 } // Only apply if no user types are targeted
    });
  }
  
  // 4. Global notifications (no targeting specified)
  targetingConditions.push({
    targetUsers: { $size: 0 },
    targetUserTypes: { $size: 0 },
    targetClients: { $size: 0 }
  });
  
  const query = {
    ...baseQuery,
    $or: targetingConditions
  };
  
  // Exclude read notifications if requested
  if (!includeRead) {
    query['readBy.user'] = { $ne: user._id };
  }
  
  const notifications = await this.find(query)
    .populate('createdBy', 'userName email userType')
    .populate('approvedBy', 'userName email')
    .sort(sortBy)
    .limit(limit)
    .skip(skip);
  
  return notifications;
};

// Static method to schedule auto-deletion
notificationSchema.statics.scheduleAutoDeletion = async function() {
  const notifications = await this.find({
    status: 'published',
    autoDeleteAfterDays: { $gt: 0 },
    isDeleted: false
  });
  
  const now = new Date();
  
  for (const notification of notifications) {
    const deleteDate = new Date(notification.publishedAt);
    deleteDate.setDate(deleteDate.getDate() + notification.autoDeleteAfterDays);
    
    if (now >= deleteDate) {
      notification.status = 'expired';
      notification.isDeleted = true;
      notification.deletedAt = now;
      await notification.save();
      
      console.log(`Auto-deleted notification: ${notification.title}`);
    }
  }
};

// Static method to get pending notifications count for a consultant admin
notificationSchema.statics.getPendingApprovalsCount = async function(consultantAdminId) {
  const User = mongoose.model('User');
  
  // Get all consultants under this consultant admin
  const consultants = await User.find({
    consultantAdminId: consultantAdminId,
    userType: "consultant"
  }).select("_id");
  
  const consultantIds = consultants.map(c => c._id);
  
  return await this.countDocuments({
    createdBy: { $in: consultantIds },
    status: "pending_approval",
    isDeleted: false
  });
};

module.exports = mongoose.model("Notification", notificationSchema);