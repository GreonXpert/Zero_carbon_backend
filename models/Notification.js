const mongoose = require("mongoose");


// 3. ADD: Notification preferences for users
const userNotificationPreferences = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  emailNotifications: { type: Boolean, default: true },
  pushNotifications: { type: Boolean, default: true },
  priorityFilter: {
    type: String,
    enum: ["all", "medium_and_above", "high_and_above", "urgent_only"],
    default: "all"
  },
  categories: {
    system: { type: Boolean, default: true },
    reminders: { type: Boolean, default: true },
    achievements: { type: Boolean, default: true },
    policy: { type: Boolean, default: true }
  },
  quietHours: {
    enabled: { type: Boolean, default: false },
    startTime: { type: String, default: "22:00" },
    endTime: { type: String, default: "08:00" }
  }
});

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
    }], // Specific users if needed
    targetClients: [{ type: String }], // Specific client IDs
    
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
    
    // Publishing Schedule
    publishDate: { type: Date },
    scheduledPublishDate: { type: Date }, // For 30-minute delay
    publishedAt: { type: Date },
    
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
    
    // For system notifications (like user status changes)
    isSystemNotification: { type: Boolean, default: false },
    systemAction: { type: String }, // e.g., "user_status_changed"
    relatedEntity: {
      type: { type: String }, // e.g., "user", "client"
      id: { type: mongoose.Schema.Types.ObjectId }
    }
  },
  { timestamps: true }
);

// Indexes for performance
notificationSchema.index({ createdBy: 1, status: 1 });
notificationSchema.index({ targetUserTypes: 1, status: 1 });
notificationSchema.index({ targetUsers: 1, status: 1 });
notificationSchema.index({ publishDate: 1, status: 1 });
notificationSchema.index({ expiryDate: 1, status: 1 });
notificationSchema.index({ "readBy.user": 1 });

// Virtual for checking if notification is active
notificationSchema.virtual('isActive').get(function() {
  return this.status === 'published' && 
         (!this.expiryDate || this.expiryDate > new Date()) &&
         !this.isDeleted;
});

// Method to check if user can view this notification
notificationSchema.methods.canBeViewedBy = async function(user) {
  // If deleted, no one can view
  if (this.isDeleted) return false;
  
  // If not published yet, only creator and approvers can view
  if (this.status !== 'published') {
    return this.createdBy.toString() === user._id.toString() ||
           (user.userType === 'super_admin') ||
           (user.userType === 'consultant_admin' && this.approvalRequired);
  }
  
  // Check if user is in targetUsers
  if (this.targetUsers.length > 0) {
    return this.targetUsers.some(targetId => targetId.toString() === user._id.toString());
  }
  
  // Check if user's type is in targetUserTypes
  if (this.targetUserTypes.length > 0) {
    if (!this.targetUserTypes.includes(user.userType)) {
      return false;
    }
  }
  
  // Check if user's client is in targetClients
  if (this.targetClients.length > 0 && user.clientId) {
    return this.targetClients.includes(user.clientId);
  }
  
  return true;
};

// Method to mark as read by user
notificationSchema.methods.markAsReadBy = async function(userId) {
  const alreadyRead = this.readBy.some(
    read => read.user.toString() === userId.toString()
  );
  
  if (!alreadyRead) {
    this.readBy.push({ user: userId, readAt: new Date() });
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
  
  // 2. User type is targeted (only if no specific users)
  targetingConditions.push({
    targetUserTypes: user.userType,
    $or: [
      { targetUsers: { $exists: false } },
      { targetUsers: { $size: 0 } }
    ]
  });
  
  // 3. Client is targeted (only if no specific users/types)
  if (user.clientId) {
    targetingConditions.push({
      targetClients: user.clientId,
      $or: [
        { targetUsers: { $exists: false } },
        { targetUsers: { $size: 0 } }
      ],
      $or: [
        { targetUserTypes: { $exists: false } },
        { targetUserTypes: { $size: 0 } }
      ]
    });
  }
  
  // 4. Global notifications (no targeting specified)
  targetingConditions.push({
    $and: [
      { $or: [{ targetUsers: { $exists: false } }, { targetUsers: { $size: 0 } }] },
      { $or: [{ targetUserTypes: { $exists: false } }, { targetUserTypes: { $size: 0 } }] },
      { $or: [{ targetClients: { $exists: false } }, { targetClients: { $size: 0 } }] }
    ]
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
    }
  }
};

module.exports = mongoose.model("Notification", notificationSchema);