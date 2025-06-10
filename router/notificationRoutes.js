const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");

const {
  createNotification,
  getNotifications,
  approveNotification,
  cancelNotification,
  markAsRead,
  deleteNotification
} = require("../controllers/notificationControllers");

// Apply auth middleware to all routes
router.use(auth);

// Notification management routes
router.post("/", createNotification); // Create new notification
router.get("/", getNotifications); // Get notifications for current user
router.patch("/:notificationId/approve", approveNotification); // Approve/Reject notification (Consultant Admin only)
router.patch("/:notificationId/cancel", cancelNotification); // Cancel scheduled notification (Super Admin only)
router.patch("/:notificationId/read", markAsRead); // Mark notification as read
router.delete("/:notificationId", deleteNotification); // Delete notification

// Additional routes for specific use cases
router.get("/unread-count", async (req, res) => {
  try {
    const Notification = require("../models/Notification");
    
    // FIXED: More accurate unread count query
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
      .sort('-createdAt')
      .limit(parseInt(limit))
      .skip(parseInt(skip));
    
    const total = await Notification.countDocuments(query);
    
    res.status(200).json({
      notifications,
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
    .sort('-createdAt');
    
    res.status(200).json({
      pendingApprovals: pendingNotifications
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to get pending approvals",
      error: error.message
    });
  }
});

// Get scheduled notifications (Super Admin only)
router.get("/scheduled", async (req, res) => {
  try {
    if (req.user.userType !== "super_admin") {
      return res.status(403).json({
        message: "Only Super Admin can view scheduled notifications"
      });
    }
    
    const Notification = require("../models/Notification");
    
    const scheduledNotifications = await Notification.find({
      status: "scheduled",
      isDeleted: false
    })
    .populate('createdBy', 'userName email userType')
    .populate('approvedBy', 'userName email')
    .sort('scheduledPublishDate');
    
    res.status(200).json({
      scheduledNotifications
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to get scheduled notifications",
      error: error.message
    });
  }
});

module.exports = router;