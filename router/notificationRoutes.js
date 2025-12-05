const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");

const {
  createNotification,
  getNotifications,
  approveNotification,
  cancelNotification,
  markAsRead,
  deleteNotification,
  getNotificationStats,
  markAllReadHandler,
   markAllRead
} = require("../controllers/notificationControllers");

// Apply auth middleware to all routes
router.use(auth);

// Core notification management routes
router.post("/", createNotification); // Create new notification
router.get("/", getNotifications); // Get notifications for current user
router.patch("/:notificationId/approve", approveNotification); // Approve/Reject/Waitlist notification (Consultant Admin only)
router.patch("/:notificationId/cancel", cancelNotification); // Cancel scheduled notification (Super Admin only)
router.patch("/:notificationId/read", markAsRead); // Mark notification as read
router.delete("/:notificationId", deleteNotification); // Delete notification

// PATCH works as before
router.patch("/mark-all-read",  markAllRead);
// …and now GET works too
router.get(  "/mark-all-read", markAllRead); // Mark all notifications as read

// Statistics and analytics
router.get("/stats", getNotificationStats); // Get notification statistics (Admin only)

// Unread count endpoint
router.get("/unread-count", async (req, res) => {
  try {
    const Notification = require("../models/Notification");
    
    // Build targeting conditions for accurate unread count
    const targetingConditions = [
      { targetUsers: req.user.id },
      {
        targetUserTypes: req.user.userType,
        $or: [
          { targetUsers: { $exists: false } },
          { targetUsers: { $size: 0 } }
        ]
      }
    ];
    
    if (req.user.clientId) {
      targetingConditions.push({
        targetClients: req.user.clientId,
        $and: [
          { $or: [{ targetUsers: { $exists: false } }, { targetUsers: { $size: 0 } }] },
          { $or: [{ targetUserTypes: { $exists: false } }, { targetUserTypes: { $size: 0 } }] }
        ]
      });
    }
    
    const unreadCount = await Notification.countDocuments({
      status: 'published',
      isDeleted: false,
      'readBy.user': { $ne: req.user.id },
      $or: [
        { expiryDate: null },
        { expiryDate: { $gt: new Date() } }
      ],
      $or: targetingConditions
    });
    
    res.status(200).json({
      unreadCount
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to get unread count",
      error: error.message
    });
  }
});

// Get notifications created by current user
router.get("/my-notifications", async (req, res) => {
  try {
    const Notification = require("../models/Notification");
    
    const { limit = 50, skip = 0, status } = req.query;
    
    const query = {
      createdBy: req.user.id,
      isDeleted: false
    };
    
    if (status) {
      query.status = status;
    }
    
    const notifications = await Notification.find(query)
      .populate('approvedBy', 'userName email')
      .populate('targetUsers', 'userName email')
      .sort('-createdAt')
      .limit(parseInt(limit))
      .skip(parseInt(skip));
    
    const total = await Notification.countDocuments(query);
    
    res.status(200).json({
      notifications: notifications.map(notif => ({
        id: notif._id,
        title: notif.title,
        message: notif.message,
        priority: notif.priority,
        status: notif.status,
        createdAt: notif.createdAt,
        approvedBy: notif.approvedBy,
        approvalDate: notif.approvalDate,
        scheduledPublishDate: notif.scheduledPublishDate,
        targetSummary: {
          users: notif.targetUsers.length,
          clients: notif.targetClients.length,
          userTypes: notif.targetUserTypes.length
        }
      })),
      pagination: {
        total,
        limit: parseInt(limit),
        skip: parseInt(skip)
      }
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to get created notifications",
      error: error.message
    });
  }
});

// Get pending approvals (Consultant Admin only)
router.get("/pending-approvals", async (req, res) => {
  try {
    if (req.user.userType !== "consultant_admin") {
      return res.status(403).json({
        message: "Only Consultant Admins can view pending approvals"
      });
    }
    
    const Notification = require("../models/Notification");
    const User = require("../models/User");
    
    // Get all consultants under this consultant admin
    const consultants = await User.find({
      consultantAdminId: req.user.id,
      userType: "consultant"
    }).select("_id");
    
    const consultantIds = consultants.map(c => c._id);
    
    const pendingNotifications = await Notification.find({
      createdBy: { $in: consultantIds },
      status: "pending_approval",
      isDeleted: false
    })
    .populate('createdBy', 'userName email')
    .populate('targetUsers', 'userName email')
    .sort('-createdAt');
    
    res.status(200).json({
      pendingApprovals: pendingNotifications.map(notif => ({
        id: notif._id,
        title: notif.title,
        message: notif.message,
        priority: notif.priority,
        createdBy: notif.createdBy,
        createdAt: notif.createdAt,
        targetClients: notif.targetClients,
        targetUsers: notif.targetUsers,
        waitlistNotes: notif.waitlistNotes
      }))
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to get pending approvals",
      error: error.message
    });
  }
});

// Get scheduled notifications (Super Admin and Consultant Admin)
router.get("/scheduled", async (req, res) => {
  try {
    if (!["super_admin", "consultant_admin"].includes(req.user.userType)) {
      return res.status(403).json({
        message: "Only Super Admin and Consultant Admin can view scheduled notifications"
      });
    }
    
    const Notification = require("../models/Notification");
    
    let query = {
      status: "scheduled",
      isDeleted: false
    };
    
    // Consultant admin can only see their team's scheduled notifications
    if (req.user.userType === "consultant_admin") {
      const User = require("../models/User");
      const teamMembers = await User.find({
        $or: [
          { _id: req.user.id },
          { consultantAdminId: req.user.id }
        ]
      }).select("_id");
      
      query.createdBy = { $in: teamMembers.map(m => m._id) };
    }
    
    const scheduledNotifications = await Notification.find(query)
      .populate('createdBy', 'userName email userType')
      .populate('approvedBy', 'userName email')
      .populate('targetUsers', 'userName email')
      .sort('scheduledPublishDate');
    
    res.status(200).json({
      scheduledNotifications: scheduledNotifications.map(notif => ({
        id: notif._id,
        title: notif.title,
        message: notif.message,
        priority: notif.priority,
        createdBy: notif.createdBy,
        approvedBy: notif.approvedBy,
        scheduledPublishDate: notif.scheduledPublishDate,
        targetSummary: {
          users: notif.targetUsers.length,
          clients: notif.targetClients.length,
          userTypes: notif.targetUserTypes.length
        }
      }))
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to get scheduled notifications",
      error: error.message
    });
  }
});


// Get notification details by ID
router.get("/:notificationId", async (req, res) => {
  try {
    const { notificationId } = req.params;
    const Notification = require("../models/Notification");
    
    const notification = await Notification.findById(notificationId)
      .populate('createdBy', 'userName email userType')
      .populate('approvedBy', 'userName email')
      .populate('targetUsers', 'userName email');
    
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
    
    res.status(200).json({
      notification: {
        id: notification._id,
        title: notification.title,
        message: notification.message,
        priority: notification.priority,
        status: notification.status,
        createdBy: notification.createdBy,
        createdAt: notification.createdAt,
        approvedBy: notification.approvedBy,
        approvalDate: notification.approvalDate,
        rejectionReason: notification.rejectionReason,
        scheduledPublishDate: notification.scheduledPublishDate,
        publishedAt: notification.publishedAt,
        expiryDate: notification.expiryDate,
        autoDeleteAfterDays: notification.autoDeleteAfterDays,
        attachments: notification.attachments,
        targetUsers: notification.targetUsers,
        targetClients: notification.targetClients,
        targetUserTypes: notification.targetUserTypes,
        isRead: notification.readBy.some(read => read.user.toString() === req.user.id),
        readBy: notification.readBy,
        isSystemNotification: notification.isSystemNotification,
        systemAction: notification.systemAction
      }
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to get notification details",
      error: error.message
    });
  }
});

module.exports = router;