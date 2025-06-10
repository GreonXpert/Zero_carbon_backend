const Notification = require("../models/Notification");
const User = require("../models/User");
const { sendMail } = require("../utils/mail");

// Create notification
const createNotification = async (req, res) => {
  try {
    const {
      title,
      message,
      priority,
      targetUserTypes,
      targetUsers,
      targetClients,
      autoDeleteAfterDays,
      expiryDate,
      attachments
    } = req.body;
    
    // Validate required fields
    if (!title || !message) {
      return res.status(400).json({
        message: "Title and message are required"
      });
    }
    
    // Check if user can create notifications
    const allowedCreators = ["super_admin", "consultant_admin", "consultant"];
    if (!allowedCreators.includes(req.user.userType)) {
      return res.status(403).json({
        message: "Only Super Admin, Consultant Admin, and Consultants can create notifications"
      });
    }
    
    // Validate targets
    if (!targetUserTypes?.length && !targetUsers?.length && !targetClients?.length) {
      return res.status(400).json({
        message: "Please specify at least one target audience"
      });
    }
    
    // FIXED: Enhanced permission validation
    let approvalRequired = false;
    let status = "draft";
    let scheduledPublishDate = null;
    
    if (req.user.userType === "consultant") {
      // Check if targeting client admins - requires approval
      if (targetUserTypes?.includes("client_admin")) {
        approvalRequired = true;
        status = "pending_approval";
      } else {
        // All other consultant notifications get 30-minute delay
        scheduledPublishDate = new Date(Date.now() + 30 * 60 * 1000);
        status = "scheduled";
      }
    } else if (req.user.userType === "consultant_admin") {
      // Consultant admin notifications get 30-minute delay
      scheduledPublishDate = new Date(Date.now() + 30 * 60 * 1000);
      status = "scheduled";
    } else if (req.user.userType === "super_admin") {
      // Super admin publishes immediately
      status = "published";
    }
    
    // FIXED: Validate auto-delete value
    if (autoDeleteAfterDays && (autoDeleteAfterDays < 1 || autoDeleteAfterDays > 365)) {
      return res.status(400).json({
        message: "Auto-delete days must be between 1 and 365"
      });
    }
    
    // FIXED: Validate expiry date
    if (expiryDate && new Date(expiryDate) <= new Date()) {
      return res.status(400).json({
        message: "Expiry date must be in the future"
      });
    }
    
    // Create notification
    const notification = new Notification({
      title: title.trim(),
      message: message.trim(),
      priority: priority || "medium",
      createdBy: req.user.id,
      creatorType: req.user.userType,
      targetUserTypes: targetUserTypes || [],
      targetUsers: targetUsers || [],
      targetClients: targetClients || [],
      status,
      approvalRequired,
      approvalRequestedAt: approvalRequired ? new Date() : null,
      scheduledPublishDate,
      publishedAt: status === "published" ? new Date() : null,
      expiryDate: expiryDate ? new Date(expiryDate) : null,
      autoDeleteAfterDays: autoDeleteAfterDays || null,
      attachments: attachments || []
    });
    
    await notification.save();
    
    // FIXED: Better email notifications
    if (approvalRequired) {
      const consultantAdmin = await User.findById(req.user.consultantAdminId);
      if (consultantAdmin) {
        await sendMail(
          consultantAdmin.email,
          "Notification Approval Required - ZeroCarbon",
          `A notification requires your approval:

Title: ${title}
From: ${req.user.userName}
Target: Client Admins
Created: ${new Date().toLocaleString()}

Message Preview: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}

Please log in to review and approve/reject this notification.

Best regards,
ZeroCarbon Team`
        );
      }
    }
    
    if (status === "scheduled") {
      const superAdmin = await User.findOne({ userType: "super_admin" });
      if (superAdmin) {
        await sendMail(
          superAdmin.email,
          "Scheduled Notification Alert - ZeroCarbon",
          `A notification has been scheduled:

Title: ${title}
Created by: ${req.user.userName} (${req.user.userType.replace(/_/g, ' ')})
Scheduled for: ${scheduledPublishDate.toLocaleString()}
Target: ${targetUserTypes?.join(', ') || 'Specific users/clients'}

You can cancel this notification within 30 minutes if needed.

Best regards,
ZeroCarbon Team`
        );
      }
    }
    
    res.status(201).json({
      message: "Notification created successfully",
      notification: {
        id: notification._id,
        title: notification.title,
        status: notification.status,
        scheduledPublishDate: notification.scheduledPublishDate,
        approvalRequired: notification.approvalRequired,
        autoDeleteAfterDays: notification.autoDeleteAfterDays
      }
    });
    
  } catch (error) {
    console.error("Create notification error:", error);
    res.status(500).json({
      message: "Failed to create notification",
      error: error.message
    });
  }
};

// ===========================================
// 5. ADD: Bulk notification creation for super admin
// ===========================================

const createBulkNotification = async (req, res) => {
  try {
    if (req.user.userType !== "super_admin") {
      return res.status(403).json({
        message: "Only Super Admin can create bulk notifications"
      });
    }
    
    const {
      title,
      message,
      priority = "medium",
      sendToAllUsers = false,
      targetUserTypes = [],
      excludeUserTypes = [],
      autoDeleteAfterDays
    } = req.body;
    
    let finalTargetTypes = [];
    
    if (sendToAllUsers) {
      finalTargetTypes = [
        "super_admin", "consultant_admin", "consultant", 
        "client_admin", "client_employee_head", "employee", 
        "viewer", "auditor"
      ];
      
      // Remove excluded types
      finalTargetTypes = finalTargetTypes.filter(type => 
        !excludeUserTypes.includes(type)
      );
    } else {
      finalTargetTypes = targetUserTypes;
    }
    
    const notification = new Notification({
      title,
      message,
      priority,
      createdBy: req.user.id,
      creatorType: req.user.userType,
      targetUserTypes: finalTargetTypes,
      status: "published",
      publishedAt: new Date(),
      autoDeleteAfterDays: autoDeleteAfterDays || null
    });
    
    await notification.save();
    
    res.status(201).json({
      message: "Bulk notification created successfully",
      notification: {
        id: notification._id,
        title: notification.title,
        targetCount: finalTargetTypes.length
      }
    });
    
  } catch (error) {
    console.error("Create bulk notification error:", error);
    res.status(500).json({
      message: "Failed to create bulk notification",
      error: error.message
    });
  }
};

const validateNotificationPermissions = (userType, targetUserTypes, targetClients) => {
  const permissions = {
    super_admin: {
      canTarget: ["super_admin", "consultant_admin", "consultant", "client_admin", "client_employee_head", "employee", "viewer", "auditor"],
      canTargetAllClients: true
    },
    consultant_admin: {
      canTarget: ["consultant", "client_admin", "client_employee_head", "employee"],
      canTargetAllClients: false
    },
    consultant: {
      canTarget: ["client_admin", "client_employee_head", "employee"], // client_admin needs approval
      canTargetAllClients: false
    }
  };
  
  const userPermissions = permissions[userType];
  if (!userPermissions) return false;
  
  // Check if all target user types are allowed
  const invalidTargets = targetUserTypes.filter(type => 
    !userPermissions.canTarget.includes(type)
  );
  
  return {
    isValid: invalidTargets.length === 0,
    invalidTargets,
    needsApproval: userType === "consultant" && targetUserTypes.includes("client_admin")
  };
};

const createLeadNotification = async (superAdmin, clientData, reqUser, newClientId, newClientMongoId) => {
  try {
    // a) Create Notification
    const notif = new Notification({
      title: `Lead Created: ${newClientId}`,
      message: `
A new lead has been created by ${reqUser.userName} (${reqUser.userType}):
• Lead ID: ${newClientId}
• Company: ${clientData.companyName}
• Contact Person: ${clientData.contactPersonName}
• Email: ${clientData.email}
• Mobile: ${clientData.mobileNumber}
      `.trim(),
      priority: "high",
      createdBy: reqUser.id,
      creatorType: reqUser.userType,
      targetUsers: [superAdmin._id],
      status: "published",
      publishedAt: new Date(),
      isSystemNotification: true,
      systemAction: "lead_created",
      relatedEntity: {
        type: "client",
        id: newClientMongoId
      }
    });
    
    await notif.save();

    // b) Enqueue email to super_admin
    await notifySuperAdmin(superAdmin.email, {
      clientId: newClientId,
      companyName: clientData.companyName,
      contactPersonName: clientData.contactPersonName,
      email: clientData.email,
      mobileNumber: clientData.mobileNumber,
      leadSource: clientData.leadSource || "N/A",
      notes: clientData.notes || "N/A",
      createdBy: reqUser.userName
    });

    // (Optional future) Trigger notifyRealTime() here if you want real-time popup
  } catch (err) {
    console.error("Failed to create lead notification:", err);
    // Do not throw — log and continue
  }
};


// Get notifications for user
const getNotifications = async (req, res) => {
  try {
    const { includeRead, limit, skip, unreadOnly } = req.query;
    
    const options = {
      includeRead: includeRead !== 'false',
      limit: parseInt(limit) || 50,
      skip: parseInt(skip) || 0,
      sortBy: '-createdAt'
    };
    
    // Get notifications based on user hierarchy
    let notifications = await Notification.getNotificationsForUser(req.user, options);
    
    // If unreadOnly, filter out read notifications
    if (unreadOnly === 'true') {
      notifications = notifications.filter(notif => 
        !notif.readBy.some(read => read.user.toString() === req.user.id)
      );
    }
    
    // Get unread count
    const unreadCount = await Notification.countDocuments({
      status: 'published',
      isDeleted: false,
      'readBy.user': { $ne: req.user.id },
      $or: [
        { targetUsers: req.user.id },
        { targetUserTypes: req.user.userType },
        { targetClients: req.user.clientId }
      ]
    });
    
    res.status(200).json({
      message: "Notifications fetched successfully",
      notifications: notifications.map(notif => ({
        id: notif._id,
        title: notif.title,
        message: notif.message,
        priority: notif.priority,
        createdBy: notif.createdBy,
        createdAt: notif.createdAt,
        isRead: notif.readBy.some(read => read.user.toString() === req.user.id),
        readAt: notif.readBy.find(read => read.user.toString() === req.user.id)?.readAt,
        expiryDate: notif.expiryDate,
        attachments: notif.attachments
      })),
      unreadCount,
      pagination: {
        limit: options.limit,
        skip: options.skip,
        total: notifications.length
      }
    });
    
  } catch (error) {
    console.error("Get notifications error:", error);
    res.status(500).json({
      message: "Failed to fetch notifications",
      error: error.message
    });
  }
};

// Approve/Reject notification (Consultant Admin only)
const approveNotification = async (req, res) => {
  try {
    const { notificationId } = req.params;
    const { action, rejectionReason } = req.body;
    
    if (req.user.userType !== "consultant_admin") {
      return res.status(403).json({
        message: "Only Consultant Admins can approve notifications"
      });
    }
    
    const notification = await Notification.findById(notificationId)
      .populate('createdBy', 'userName email consultantAdminId');
    
    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }
    
    // Check if this consultant admin manages the consultant who created it
    if (notification.createdBy.consultantAdminId?.toString() !== req.user.id) {
      return res.status(403).json({
        message: "You can only approve notifications from your team members"
      });
    }
    
    if (notification.status !== "pending_approval") {
      return res.status(400).json({
        message: "This notification is not pending approval"
      });
    }
    
    if (action === "approve") {
      // Schedule for 30-minute delay
      notification.status = "scheduled";
      notification.approvedBy = req.user.id;
      notification.approvalDate = new Date();
      notification.scheduledPublishDate = new Date(Date.now() + 30 * 60 * 1000);
      
      await notification.save();
      
      // Notify creator
      await sendMail(
        notification.createdBy.email,
        "Notification Approved",
        `Your notification "${notification.title}" has been approved and will be published in 30 minutes.`
      );
      
      // Notify super admin
      const superAdmin = await User.findOne({ userType: "super_admin" });
      if (superAdmin) {
        await sendMail(
          superAdmin.email,
          "Notification Approved and Scheduled",
          `A notification has been approved:\n\nTitle: ${notification.title}\nApproved by: ${req.user.userName}\nScheduled for: ${notification.scheduledPublishDate}`
        );
      }
      
      res.status(200).json({
        message: "Notification approved and scheduled",
        scheduledPublishDate: notification.scheduledPublishDate
      });
      
    } else if (action === "reject") {
      notification.status = "cancelled";
      notification.rejectionReason = rejectionReason;
      
      await notification.save();
      
      // Notify creator
      await sendMail(
        notification.createdBy.email,
        "Notification Rejected",
        `Your notification "${notification.title}" has been rejected.\n\nReason: ${rejectionReason}`
      );
      
      res.status(200).json({
        message: "Notification rejected"
      });
      
    } else {
      return res.status(400).json({
        message: "Invalid action. Use 'approve' or 'reject'"
      });
    }
    
  } catch (error) {
    console.error("Approve notification error:", error);
    res.status(500).json({
      message: "Failed to process notification approval",
      error: error.message
    });
  }
};

// Cancel scheduled notification (Super Admin only)
const cancelNotification = async (req, res) => {
  try {
    const { notificationId } = req.params;
    
    if (req.user.userType !== "super_admin") {
      return res.status(403).json({
        message: "Only Super Admin can cancel scheduled notifications"
      });
    }
    
    const notification = await Notification.findById(notificationId);
    
    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }
    
    if (notification.status !== "scheduled") {
      return res.status(400).json({
        message: "Only scheduled notifications can be cancelled"
      });
    }
    
    notification.status = "cancelled";
    await notification.save();
    
    // Notify creator
    const creator = await User.findById(notification.createdBy);
    if (creator) {
      await sendMail(
        creator.email,
        "Notification Cancelled",
        `Your scheduled notification "${notification.title}" has been cancelled by the Super Admin.`
      );
    }
    
    res.status(200).json({
      message: "Notification cancelled successfully"
    });
    
  } catch (error) {
    console.error("Cancel notification error:", error);
    res.status(500).json({
      message: "Failed to cancel notification",
      error: error.message
    });
  }
};

// Mark notification as read
const markAsRead = async (req, res) => {
  try {
    const { notificationId } = req.params;
    
    const notification = await Notification.findById(notificationId);
    
    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }
    
    // Check if user can view this notification
    const canView = await notification.canBeViewedBy(req.user);
    if (!canView) {
      return res.status(403).json({
        message: "You don't have permission to view this notification"
      });
    }
    
    await notification.markAsReadBy(req.user.id);
    
    res.status(200).json({
      message: "Notification marked as read"
    });
    
  } catch (error) {
    console.error("Mark as read error:", error);
    res.status(500).json({
      message: "Failed to mark notification as read",
      error: error.message
    });
  }
};

// Delete notification
const deleteNotification = async (req, res) => {
  try {
    const { notificationId } = req.params;
    
    const notification = await Notification.findById(notificationId);
    
    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }
    
    // Check deletion permissions
    let canDelete = false;
    
    switch (req.user.userType) {
      case "super_admin":
        canDelete = true;
        break;
        
      case "consultant_admin":
        // Can delete notifications created by their team
        if (notification.createdBy.toString() === req.user.id) {
          canDelete = true;
        } else {
          const creator = await User.findById(notification.createdBy);
          canDelete = creator?.consultantAdminId?.toString() === req.user.id;
        }
        break;
        
      case "consultant":
        // Can only delete their own notifications
        canDelete = notification.createdBy.toString() === req.user.id;
        break;
        
      default:
        canDelete = false;
    }
    
    if (!canDelete) {
      return res.status(403).json({
        message: "You don't have permission to delete this notification"
      });
    }
    
    notification.isDeleted = true;
    notification.deletedBy = req.user.id;
    notification.deletedAt = new Date();
    notification.status = "cancelled";
    
    await notification.save();
    
    res.status(200).json({
      message: "Notification deleted successfully"
    });
    
  } catch (error) {
    console.error("Delete notification error:", error);
    res.status(500).json({
      message: "Failed to delete notification",
      error: error.message
    });
  }
};

// Publish scheduled notifications (to be called by cron job)
const publishScheduledNotifications = async () => {
  try {
    const now = new Date();
    
    const notifications = await Notification.find({
      status: "scheduled",
      scheduledPublishDate: { $lte: now },
      isDeleted: false
    });
    
    for (const notification of notifications) {
      notification.status = "published";
      notification.publishedAt = now;
      notification.publishDate = now;
      await notification.save();
      
      console.log(`Published notification: ${notification.title}`);
    }
    
    // Also handle auto-deletion
    await Notification.scheduleAutoDeletion();
    
  } catch (error) {
    console.error("Publish scheduled notifications error:", error);
  }
};

// Create system notification for user status change
const createUserStatusNotification = async (user, changedBy, newStatus) => {
  try {
    const notification = new Notification({
      title: `Your account has been ${newStatus ? 'activated' : 'deactivated'}`,
      message: `Your account status has been changed by ${changedBy.userName} (${changedBy.userType.replace(/_/g, ' ')}). Your account is now ${newStatus ? 'active' : 'inactive'}.`,
      priority: "high",
      createdBy: changedBy.id,
      creatorType: changedBy.userType,
      targetUsers: [user._id],
      status: "published",
      publishedAt: new Date(),
      isSystemNotification: true,
      systemAction: "user_status_changed",
      relatedEntity: {
        type: "user",
        id: user._id
      }
    });
    
    await notification.save();
    
    // Also send email
    const emailSubject = `Account ${newStatus ? 'Activated' : 'Deactivated'}`;
    const emailMessage = `
      Dear ${user.userName},
      
      Your ZeroCarbon account has been ${newStatus ? 'activated' : 'deactivated'} by ${changedBy.userName}.
      
      Status: ${newStatus ? 'Active' : 'Inactive'}
      Changed by: ${changedBy.userName} (${changedBy.userType.replace(/_/g, ' ')})
      Date: ${new Date().toLocaleString()}
      
      ${newStatus 
        ? 'You can now log in to your account.' 
        : 'You will not be able to access your account until it is reactivated.'}
      
      If you have any questions, please contact your administrator.
      
      Best regards,
      ZeroCarbon Team
    `;
    
    await sendMail(user.email, emailSubject, emailMessage);
    
  } catch (error) {
    console.error("Create user status notification error:", error);
  }
};
// 1. ADD: Notification analytics and reporting
const getNotificationAnalytics = async (req, res) => {
  try {
    if (!["super_admin", "consultant_admin"].includes(req.user.userType)) {
      return res.status(403).json({
        message: "Access denied"
      });
    }
    
    const Notification = require("../models/Notification");
    
    // Get analytics for last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const analytics = await Notification.aggregate([
      {
        $match: {
          createdAt: { $gte: thirtyDaysAgo },
          isDeleted: false
        }
      },
      {
        $group: {
          _id: {
            status: "$status",
            priority: "$priority",
            creatorType: "$creatorType"
          },
          count: { $sum: 1 },
          avgReadTime: {
            $avg: {
              $subtract: [
                { $arrayElemAt: ["$readBy.readAt", 0] },
                "$publishedAt"
              ]
            }
          }
        }
      }
    ]);
    
    res.status(200).json({
      analytics,
      period: "Last 30 days"
    });
    
  } catch (error) {
    res.status(500).json({
      message: "Failed to get analytics",
      error: error.message
    });
  }
};

// 2. ADD: Notification templates for common use cases
const notificationTemplates = {
  system_maintenance: {
    title: "Scheduled System Maintenance",
    message: "The ZeroCarbon platform will undergo scheduled maintenance on {date} from {start_time} to {end_time}. During this time, the system may be temporarily unavailable.",
    priority: "high",
    autoDeleteAfterDays: 1
  },
  data_submission_reminder: {
    title: "Data Submission Reminder",
    message: "Reminder: Please submit your monthly carbon footprint data by {due_date}. Late submissions may affect your sustainability reporting.",
    priority: "medium",
    autoDeleteAfterDays: 7
  },
  policy_update: {
    title: "Policy Update Notice",
    message: "Important: Our {policy_name} has been updated. Please review the changes at your earliest convenience.",
    priority: "high",
    autoDeleteAfterDays: 30
  },
  achievement_milestone: {
    title: "Sustainability Milestone Achieved!",
    message: "Congratulations! {client_name} has achieved {milestone}. Keep up the excellent work towards carbon neutrality!",
    priority: "low",
    autoDeleteAfterDays: 14
  }
};

const createNotificationFromTemplate = async (req, res) => {
  try {
    const { templateName, variables, ...notificationData } = req.body;
    
    const template = notificationTemplates[templateName];
    if (!template) {
      return res.status(400).json({
        message: "Template not found"
      });
    }
    
    // Replace variables in template
    let title = template.title;
    let message = template.message;
    
    if (variables) {
      Object.keys(variables).forEach(key => {
        const regex = new RegExp(`{${key}}`, 'g');
        title = title.replace(regex, variables[key]);
        message = message.replace(regex, variables[key]);
      });
    }
    
    // Create notification with template data
    const notificationRequest = {
      ...notificationData,
      title,
      message,
      priority: template.priority,
      autoDeleteAfterDays: template.autoDeleteAfterDays
    };
    
    req.body = notificationRequest;
    return createNotification(req, res);
    
  } catch (error) {
    res.status(500).json({
      message: "Failed to create notification from template",
      error: error.message
    });
  }
};



// 4. ADD: Notification batch operations
const batchOperations = {
  markAllAsRead: async (req, res) => {
    try {
      const notifications = await Notification.find({
        status: 'published',
        isDeleted: false,
        'readBy.user': { $ne: req.user.id },
        $or: [
          { targetUsers: req.user.id },
          { targetUserTypes: req.user.userType },
          { targetClients: req.user.clientId }
        ]
      });
      
      const updatePromises = notifications.map(notification => 
        notification.markAsReadBy(req.user.id)
      );
      
      await Promise.all(updatePromises);
      
      res.status(200).json({
        message: `Marked ${notifications.length} notifications as read`
      });
      
    } catch (error) {
      res.status(500).json({
        message: "Failed to mark all as read",
        error: error.message
      });
    }
  },
  
  deleteExpired: async (req, res) => {
    try {
      if (req.user.userType !== "super_admin") {
        return res.status(403).json({
          message: "Only Super Admin can delete expired notifications"
        });
      }
      
      const result = await Notification.updateMany(
        {
          expiryDate: { $lt: new Date() },
          isDeleted: false
        },
        {
          $set: {
            isDeleted: true,
            deletedBy: req.user.id,
            deletedAt: new Date(),
            status: "expired"
          }
        }
      );
      
      res.status(200).json({
        message: `Deleted ${result.modifiedCount} expired notifications`
      });
      
    } catch (error) {
      res.status(500).json({
        message: "Failed to delete expired notifications",
        error: error.message
      });
    }
  }
};

// 5. ADD: Real-time notification delivery (WebSocket)
const WebSocket = require('ws');

const notifyRealTime = async (notification) => {
  // This would integrate with your WebSocket server
  // to send real-time notifications to connected users
  
  const targetUsers = await User.find({
    $or: [
      { _id: { $in: notification.targetUsers } },
      { userType: { $in: notification.targetUserTypes } },
      { clientId: { $in: notification.targetClients } }
    ],
    isActive: true
  });
  
  targetUsers.forEach(user => {
    // Send WebSocket notification to user if they're online
    // wss.clients.forEach(client => {
    //   if (client.userId === user._id.toString()) {
    //     client.send(JSON.stringify({
    //       type: 'notification',
    //       data: notification
    //     }));
    //   }
    // });
  });
};

// 6. ADD: Enhanced notification validation
const validateNotificationContent = (title, message) => {
  const errors = [];
  
  if (!title || title.trim().length < 3) {
    errors.push("Title must be at least 3 characters long");
  }
  
  if (title && title.length > 100) {
    errors.push("Title must be less than 100 characters");
  }
  
  if (!message || message.trim().length < 10) {
    errors.push("Message must be at least 10 characters long");
  }
  
  if (message && message.length > 1000) {
    errors.push("Message must be less than 1000 characters");
  }
  
  // Check for potentially harmful content
  const forbiddenPatterns = [
    /script\s*>/i,
    /javascript:/i,
    /on\w+\s*=/i
  ];
  
  const contentToCheck = title + " " + message;
  forbiddenPatterns.forEach(pattern => {
    if (pattern.test(contentToCheck)) {
      errors.push("Content contains potentially harmful elements");
    }
  });
  
  return {
    isValid: errors.length === 0,
    errors
  };
};

// 7. ADD: Notification performance monitoring
const logNotificationPerformance = async (notificationId, action, duration) => {
  const NotificationLog = require("../models/NotificationLog");
  
  await NotificationLog.create({
    notificationId,
    action, // 'created', 'published', 'read', 'deleted'
    duration,
    timestamp: new Date()
  });
};
const createDataSubmissionNotification = async (client, consultantAdmin) => {
  try {

    // Find super admin
    const superAdmin = await User.findOne({ userType: "super_admin" });
    
    // Create notification for Super Admin
    const notification = new Notification({
      title: `Lead Moved to Data Submission: ${client.clientId}`,
      message: `
Lead has been moved to data submission stage by ${consultantAdmin.userName}:

• Client ID: ${client.clientId}
• Company: ${client.leadInfo.companyName}
• Contact Person: ${client.leadInfo.contactPersonName}
• Email: ${client.leadInfo.email}
• Mobile: ${client.leadInfo.mobileNumber}
• Previous Stage: Lead
• Current Stage: Data Submission (Registered)
• Status: Pending

The client has been notified and is ready for data collection process.
      `.trim(),
      priority: "medium",
      createdBy: consultantAdmin.id,
      creatorType: consultantAdmin.userType,
      targetUsers: superAdmin ? [superAdmin._id] : [],
      targetUserTypes: ["super_admin"], // Fallback in case superAdmin not found
      status: "published",
      publishedAt: new Date(),
      isSystemNotification: true,
      systemAction: "stage_changed",
      relatedEntity: {
        type: "client",
        id: client._id
      },
      autoDeleteAfterDays: 30 // Auto-delete after 30 days
    });

    await notification.save();

    // Also notify the consultant admin's team (consultants under them)
    const teamConsultants = await User.find({ 
      consultantAdminId: consultantAdmin.id,
      userType: "consultant",
      isActive: true 
    });

    if (teamConsultants.length > 0) {
      const teamNotification = new Notification({
        title: `Team Update: Lead Moved to Data Submission`,
        message: `
${consultantAdmin.userName} has moved a lead to data submission stage:

• Client ID: ${client.clientId}
• Company: ${client.leadInfo.companyName}
• Contact Person: ${client.leadInfo.contactPersonName}

The client is now ready for the data collection process. Please coordinate with your admin for next steps.
        `.trim(),
        priority: "low",
        createdBy: consultantAdmin.id,
        creatorType: consultantAdmin.userType,
        targetUsers: teamConsultants.map(consultant => consultant._id),
        status: "published",
        publishedAt: new Date(),
        isSystemNotification: true,
        systemAction: "stage_changed",
        relatedEntity: {
          type: "client",
          id: client._id
        },
        autoDeleteAfterDays: 14 // Auto-delete after 14 days
      });

      await teamNotification.save();
    }

    // Optional: Send email notification to Super Admin
    if (superAdmin) {
      await sendMail(
        superAdmin.email,
        "Lead Moved to Data Submission - ZeroCarbon",
        `
Dear Super Admin,

A lead has been moved to data submission stage:

Client Details:
• Client ID: ${client.clientId}
• Company: ${client.leadInfo.companyName}
• Contact Person: ${client.leadInfo.contactPersonName}
• Email: ${client.leadInfo.email}
• Mobile: ${client.leadInfo.mobileNumber}

Action Details:
• Moved by: ${consultantAdmin.userName} (Consultant Admin)
• From Stage: Lead
• To Stage: Data Submission (Registered)
• Status: Pending
• Date: ${new Date().toLocaleString()}

The client has been notified and is ready for the data collection process.

Best regards,
ZeroCarbon System
        `
      );
    }

    console.log(`Data submission notification created for client: ${client.clientId}`);
    
  } catch (error) {
    console.error("Failed to create data submission notification:", error);
    // Don't throw error - log and continue so the main operation isn't affected
  }
};
module.exports = {
  createNotification,
  createBulkNotification,
  createLeadNotification,
  createDataSubmissionNotification,
  validateNotificationPermissions,
  getNotifications,
  approveNotification,
  cancelNotification,
  markAsRead,
  deleteNotification,
  publishScheduledNotifications,
  createUserStatusNotification,
  getNotificationAnalytics,
  createNotificationFromTemplate,
  batchOperations,
  notifyRealTime,
  validateNotificationContent,
  logNotificationPerformance
};