const Notification = require("../models/Notification");
const User = require("../models/User");
const Client = require("../models/Client");
const { sendMail } = require("../utils/mail");

// Create notification with proper business logic
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
      attachments,
      sendToAll // New field for sending to all applicable users
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
    
    // Initialize notification parameters
    let approvalRequired = false;
    let status = "draft";
    let scheduledPublishDate = null;
    let finalTargetUsers = targetUsers || [];
    let finalTargetClients = targetClients || [];
    let finalTargetUserTypes = targetUserTypes || [];
    
    // Handle different user types with specific business logic
    switch (req.user.userType) {
      case "super_admin":
        // Super Admin can send to anyone immediately
        status = "published";
        
        // If sendToAll is true, target all user types
        if (sendToAll) {
          finalTargetUserTypes = [
            "super_admin", "consultant_admin", "consultant", 
            "client_admin", "client_employee_head", "employee", 
            "viewer", "auditor"
          ];
        }
        break;
        
      case "consultant_admin":
        // Get all clients managed by this consultant admin
        const managedClients = await Client.find({
          $or: [
            { "leadInfo.consultantAdminId": req.user.id },
            { "leadInfo.assignedConsultantId": { $in: await getConsultantIds(req.user.id) } }
          ],
          stage: "active"
        }).select("clientId");
        
        const managedClientIds = managedClients.map(c => c.clientId);
        
        // Get all consultants under this consultant admin
        const managedConsultants = await User.find({
          consultantAdminId: req.user.id,
          userType: "consultant",
          isActive: true
        }).select("_id");
        
        const managedConsultantIds = managedConsultants.map(c => c._id);
        
        // Validate targets
        if (targetClients && targetClients.length > 0) {
          // Check if all target clients are managed by this consultant admin
          const invalidClients = targetClients.filter(clientId => 
            !managedClientIds.includes(clientId)
          );
          
          if (invalidClients.length > 0) {
            return res.status(403).json({
              message: "You can only send notifications to clients you manage"
            });
          }
          
          // When consultant admin sends to clients, notify super admin and delay 30 mins
          scheduledPublishDate = new Date(Date.now() + 30 * 60 * 1000);
          status = "scheduled";
          
          // Send email to super admin
          await notifySuperAdminAboutClientNotification(req.user, targetClients, title, message);
        }
        
        // If targeting consultants, publish immediately
        if (targetUsers && targetUsers.length > 0) {
          const targetingConsultants = targetUsers.some(userId => 
            managedConsultantIds.some(consultantId => 
              consultantId.toString() === userId.toString()
            )
          );
          
          if (targetingConsultants) {
            status = status === "scheduled" ? status : "published"; // Keep scheduled if already set
          }
        }
        
        // If sendToAll for consultant admin
        if (sendToAll) {
          finalTargetClients = managedClientIds;
          finalTargetUsers = managedConsultantIds.map(id => id.toString());
          scheduledPublishDate = new Date(Date.now() + 30 * 60 * 1000);
          status = "scheduled";
          await notifySuperAdminAboutClientNotification(req.user, managedClientIds, title, message);
        }
        break;
        
      case "consultant":
        // Consultants need approval for all notifications
        approvalRequired = true;
        status = "pending_approval";
        
        // Get clients assigned to this consultant
        const assignedClients = await Client.find({
          "leadInfo.assignedConsultantId": req.user.id,
          stage: "active"
        }).select("clientId");
        
        const assignedClientIds = assignedClients.map(c => c.clientId);
        
        // Validate that consultant only targets their assigned clients
        if (targetClients && targetClients.length > 0) {
          const invalidClients = targetClients.filter(clientId => 
            !assignedClientIds.includes(clientId)
          );
          
          if (invalidClients.length > 0) {
            return res.status(403).json({
              message: "You can only send notifications to clients assigned to you"
            });
          }
        }
        
        // If sendToAll for consultant
        if (sendToAll) {
          finalTargetClients = assignedClientIds;
        }
        break;
    }
    
    // Validate auto-delete value
    if (autoDeleteAfterDays && (autoDeleteAfterDays < 1 || autoDeleteAfterDays > 365)) {
      return res.status(400).json({
        message: "Auto-delete days must be between 1 and 365"
      });
    }
    
    // Validate expiry date
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
      targetUserTypes: finalTargetUserTypes,
      targetUsers: finalTargetUsers,
      targetClients: finalTargetClients,
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
    
    // Send approval email if needed
    if (approvalRequired) {
      const consultantAdmin = await User.findById(req.user.consultantAdminId);
      if (consultantAdmin) {
        await sendMail(
          consultantAdmin.email,
          "Notification Approval Required - ZeroCarbon",
          `A notification requires your approval:

Title: ${title}
From: ${req.user.userName} (Consultant)
Target Clients: ${finalTargetClients.length > 0 ? finalTargetClients.join(', ') : 'None specified'}
Created: ${new Date().toLocaleString()}

Message Preview: ${message.substring(0, 200)}${message.length > 200 ? '...' : ''}

Please log in to review and approve/reject this notification.

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
        autoDeleteAfterDays: notification.autoDeleteAfterDays,
        targetSummary: {
          users: finalTargetUsers.length,
          clients: finalTargetClients.length,
          userTypes: finalTargetUserTypes.length
        }
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

// Helper function to get consultant IDs under a consultant admin
async function getConsultantIds(consultantAdminId) {
  const consultants = await User.find({ 
    consultantAdminId: consultantAdminId,
    userType: "consultant"
  }).select("_id");
  return consultants.map(c => c._id);
}

// Helper function to notify super admin about client notifications
async function notifySuperAdminAboutClientNotification(consultantAdmin, targetClients, title, message) {
  try {
    const superAdmin = await User.findOne({ userType: "super_admin" });
    if (!superAdmin) return;
    
    const clientList = Array.isArray(targetClients) ? targetClients.join(', ') : targetClients;
    
    const emailSubject = "Consultant Admin Created Client Notification - ZeroCarbon";
    const emailMessage = `
Dear Super Admin,

A Consultant Admin has created a notification for clients:

Created by: ${consultantAdmin.userName} (${consultantAdmin.email})
Target Clients: ${clientList}
Notification Title: ${title}
Created at: ${new Date().toLocaleString()}

Message Content:
${message}

This notification will be published automatically in 30 minutes.
You can cancel it from the system if needed.

Best regards,
ZeroCarbon System
    `;
    
    await sendMail(superAdmin.email, emailSubject, emailMessage);
  } catch (error) {
    console.error("Error notifying super admin:", error);
    // Don't throw - continue with notification creation
  }
}

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
    const unreadCount = await getUnreadCountForUser(req.user);
    
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

// Helper function to get unread count
async function getUnreadCountForUser(user) {
  const baseQuery = {
    status: 'published',
    isDeleted: false,
    'readBy.user': { $ne: user._id },
    $or: [
      { expiryDate: null },
      { expiryDate: { $gt: new Date() } }
    ]
  };
  
  // Build targeting conditions
  const targetingConditions = [];
  
  // Specifically targeted user
  targetingConditions.push({ targetUsers: user._id });
  
  // User type targeted
  targetingConditions.push({
    targetUserTypes: user.userType,
    $or: [
      { targetUsers: { $exists: false } },
      { targetUsers: { $size: 0 } }
    ]
  });
  
  // Client targeted
  if (user.clientId) {
    targetingConditions.push({
      targetClients: user.clientId,
      $and: [
        { $or: [{ targetUsers: { $exists: false } }, { targetUsers: { $size: 0 } }] },
        { $or: [{ targetUserTypes: { $exists: false } }, { targetUserTypes: { $size: 0 } }] }
      ]
    });
  }
  
  const query = {
    ...baseQuery,
    $or: targetingConditions
  };
  
  return await Notification.countDocuments(query);
}

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
      // Schedule for 30-minute delay after approval
      notification.status = "scheduled";
      notification.approvedBy = req.user.id;
      notification.approvalDate = new Date();
      notification.scheduledPublishDate = new Date(Date.now() + 30 * 60 * 1000);
      
      await notification.save();
      
      // Notify creator about approval
      await sendMail(
        notification.createdBy.email,
        "Notification Approved - ZeroCarbon",
        `Your notification "${notification.title}" has been approved by ${req.user.userName} and will be published in 30 minutes.`
      );
      
      res.status(200).json({
        message: "Notification approved and scheduled",
        scheduledPublishDate: notification.scheduledPublishDate
      });
      
    } else if (action === "reject") {
      notification.status = "cancelled";
      notification.rejectionReason = rejectionReason;
      notification.approvedBy = req.user.id;
      notification.approvalDate = new Date();
      
      await notification.save();
      
      // Notify creator about rejection
      await sendMail(
        notification.createdBy.email,
        "Notification Rejected - ZeroCarbon",
        `Your notification "${notification.title}" has been rejected by ${req.user.userName}.\n\nReason: ${rejectionReason || 'No reason provided'}`
      );
      
      res.status(200).json({
        message: "Notification rejected"
      });
      
    } else if (action === "waitlist") {
      // Keep in pending_approval but add a note
      notification.waitlistNotes = rejectionReason || "Placed on waitlist for further review";
      await notification.save();
      
      res.status(200).json({
        message: "Notification placed on waitlist"
      });
      
    } else {
      return res.status(400).json({
        message: "Invalid action. Use 'approve', 'reject', or 'waitlist'"
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
    
    const notification = await Notification.findById(notificationId)
      .populate('createdBy', 'userName email');
    
    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }
    
    if (notification.status !== "scheduled") {
      return res.status(400).json({
        message: "Only scheduled notifications can be cancelled"
      });
    }
    
    notification.status = "cancelled";
    notification.cancelledBy = req.user.id;
    notification.cancelledAt = new Date();
    await notification.save();
    
    // Notify creator
    if (notification.createdBy) {
      await sendMail(
        notification.createdBy.email,
        "Notification Cancelled - ZeroCarbon",
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
        // Can delete notifications created by their team or themselves
        if (notification.createdBy.toString() === req.user.id) {
          canDelete = true;
        } else {
          const creator = await User.findById(notification.createdBy);
          canDelete = creator?.consultantAdminId?.toString() === req.user.id;
        }
        break;
        
      case "consultant":
        // Can only delete their own notifications that are not yet approved
        canDelete = notification.createdBy.toString() === req.user.id && 
                   notification.status === "pending_approval";
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

// Get notification statistics (Admin features)
const getNotificationStats = async (req, res) => {
  try {
    // Only admins can view stats
    if (!["super_admin", "consultant_admin"].includes(req.user.userType)) {
      return res.status(403).json({
        message: "Access denied"
      });
    }
    
    let query = {};
    
    // Consultant admin can only see stats for their team
    if (req.user.userType === "consultant_admin") {
      const teamMembers = await User.find({
        $or: [
          { _id: req.user.id },
          { consultantAdminId: req.user.id }
        ]
      }).select("_id");
      
      query.createdBy = { $in: teamMembers.map(m => m._id) };
    }
    
    const stats = await Notification.aggregate([
      { $match: { ...query, isDeleted: false } },
      {
        $group: {
          _id: {
            status: "$status",
            priority: "$priority"
          },
          count: { $sum: 1 }
        }
      }
    ]);
    
    const readStats = await Notification.aggregate([
      { 
        $match: { 
          ...query, 
          status: "published",
          isDeleted: false 
        } 
      },
      {
        $project: {
          totalTargets: { 
            $add: [
              { $size: "$targetUsers" },
              { $size: "$readBy" }
            ]
          },
          readCount: { $size: "$readBy" }
        }
      },
      {
        $group: {
          _id: null,
          avgReadRate: { 
            $avg: { 
              $cond: [
                { $eq: ["$totalTargets", 0] },
                0,
                { $divide: ["$readCount", "$totalTargets"] }
              ]
            }
          }
        }
      }
    ]);
    
    res.status(200).json({
      stats,
      readStats: readStats[0] || { avgReadRate: 0 }
    });
    
  } catch (error) {
    console.error("Get notification stats error:", error);
    res.status(500).json({
      message: "Failed to get notification statistics",
      error: error.message
    });
  }
};
const markAllReadHandler = async (req, res) => {
  try {

    // find all unread for this user
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

    // mark each read
    await Promise.all(
      notifications.map(n => n.markAsReadBy(req.user.id))
    );

    res.status(200).json({
      message: `Marked ${notifications.length} notifications as read`
    });

  } catch (error) {
    res.status(500).json({
      message: "Failed to mark all as read",
      error: error.message
    });
  }
};
module.exports = {
  createNotification,
  getNotifications,
  approveNotification,
  cancelNotification,
  markAsRead,
  deleteNotification,
  publishScheduledNotifications,
  createUserStatusNotification,
  getNotificationStats,
  markAllReadHandler
};