// controllers/PendingApprovalController.js
const PendingApproval = require('../PendingApproval');
const DataEntry = require('../../organization/models/DataEntry');
const NetReductionEntry = require('../../reduction/models/NetReductionEntry');
const User = require('../../../common/models/User');
const Client = require('../../organization/models/Client');
const Notification = require('../../../common/models/Notification');

/**
 * Get consultant's assigned client IDs
 * @param {string} userId - User ID
 * @returns {Promise<Array>} Array of clientIds
 */

const getConsultantAssignedClients = async (userId) => {
  try {
    const user = await User.findById(userId)
      .select("_id userType assignedClients")
      .lean();

    if (!user) return [];

    const clientIds = new Set(
      (user.assignedClients || []).map((id) => String(id))
    );

    // super admin: allow all
    if (user.userType === "super_admin") {
      const allClientIds = await Client.distinct("clientId");
      allClientIds.forEach((id) => clientIds.add(String(id)));
      return [...clientIds];
    }

    // consultant_admin: same authority pattern as fetchConsultantClients
    if (user.userType === "consultant_admin") {
      const authorityIds = [String(user._id)];

      const consultants = await User.find({
        userType: "consultant",
        createdBy: user._id,
      })
        .select("_id")
        .lean();

      consultants.forEach((c) => authorityIds.push(String(c._id)));

      const dbClientIds = await Client.distinct("clientId", {
        $or: [
          { "leadInfo.consultantAdminId": { $in: authorityIds } },
          { "leadInfo.assignedConsultantId": { $in: authorityIds } },
          {
            "leadInfo.consultantHistory": {
              $elemMatch: {
                $or: [
                  { consultantAdminId: { $in: authorityIds } },
                  { assignedConsultantId: { $in: authorityIds } },
                ],
              },
            },
          },
          { "workflowTracking.assignedConsultantId": { $in: authorityIds } },
        ],
      });

      dbClientIds.forEach((id) => clientIds.add(String(id)));
      return [...clientIds];
    }

    // consultant: own assigned visibility
    if (user.userType === "consultant") {
      const consultantId = String(user._id);

      const dbClientIds = await Client.distinct("clientId", {
        $or: [
          { "leadInfo.assignedConsultantId": consultantId },
          {
            "leadInfo.consultantHistory": {
              $elemMatch: { assignedConsultantId: consultantId },
            },
          },
          { "workflowTracking.assignedConsultantId": consultantId },
        ],
      });

      dbClientIds.forEach((id) => clientIds.add(String(id)));
    }

    return [...clientIds];
  } catch (error) {
    console.error("Error getting consultant assigned clients:", error);
    return [];
  }
};
/**
 * List pending approvals for consultant's clients
 * GET /api/verification/pending-approvals
 *
 * Query params:
 * - status: "Pending_Approval" | "Approved" | "Rejected" (optional)
 * - flowType: "dataEntry" | "netReduction" (optional)
 * - clientId: filter by specific client (optional, must be assigned to consultant)
 */
exports.listPendingApprovals = async (req, res) => {
  try {
    console.log('📋 [listPendingApprovals] called by:', req.user.id, 'userType:', req.user.userType);

    // Verify user is consultant_admin
    if (req.user.userType !== 'consultant_admin') {
      return res.status(403).json({
        message: 'Only consultant_admin can view pending approvals'
      });
    }

    // Get consultant's assigned clients
    const assignedClientIds = await getConsultantAssignedClients(req.user.id);
    console.log('  ↳ Assigned clients:', assignedClientIds);

    if (assignedClientIds.length === 0) {
      return res.status(200).json({
        message: 'No clients assigned',
        data: []
      });
    }

    // Build query filter
    const query = {
      clientId: { $in: assignedClientIds }
    };

    // Apply optional filters
    if (req.query.status) {
      query.status = req.query.status;
    } else {
      // Default: show pending
      query.status = 'Pending_Approval';
    }

    if (req.query.flowType) {
      query.flowType = req.query.flowType;
    }

    // If specific clientId requested, verify it's assigned
    if (req.query.clientId) {
      if (!assignedClientIds.includes(req.query.clientId)) {
        return res.status(403).json({
          message: `Client ${req.query.clientId} is not assigned to you`
        });
      }
      query.clientId = req.query.clientId;
    }

    // Fetch pending approvals
    const pendingApprovals = await PendingApproval.find(query)
      .sort({ submittedAt: -1 })
      .populate('submittedBy', 'email name')
      .populate('reviewedBy', 'email name')
      .lean();

    console.log(`  ↳ Found ${pendingApprovals.length} pending approvals`);

    return res.status(200).json({
      success: true,
      count: pendingApprovals.length,
      data: pendingApprovals
    });

  } catch (err) {
    console.error('❌ [listPendingApprovals] error:', err);
    return res.status(500).json({
      message: 'Error fetching pending approvals',
      error: err.message
    });
  }
};

/**
 * Get single pending approval details
 * GET /api/verification/pending-approvals/:pendingApprovalId
 */
exports.getPendingApprovalDetail = async (req, res) => {
  try {
    const { pendingApprovalId } = req.params;

    console.log('🔍 [getPendingApprovalDetail] called for:', pendingApprovalId);

    // Verify user is consultant_admin
    if (req.user.userType !== 'consultant_admin') {
      return res.status(403).json({
        message: 'Only consultant_admin can view pending approvals'
      });
    }

    const pending = await PendingApproval.findById(pendingApprovalId)
      .populate('submittedBy', 'email name')
      .populate('reviewedBy', 'email name')
      .populate('notificationId')
      .lean();

    if (!pending) {
      return res.status(404).json({ message: 'Pending approval not found' });
    }

    // Verify consultant has access to this client
    const assignedClientIds = await getConsultantAssignedClients(req.user.id);
    if (!assignedClientIds.includes(pending.clientId)) {
      return res.status(403).json({
        message: 'You do not have access to this pending approval'
      });
    }

    return res.status(200).json({
      success: true,
      data: pending
    });

  } catch (err) {
    console.error('❌ [getPendingApprovalDetail] error:', err);
    return res.status(500).json({
      message: 'Error fetching pending approval',
      error: err.message
    });
  }
};

/**
 * Approve pending entry
 * POST /api/verification/pending-approvals/:pendingApprovalId/approve
 *
 * Body: (optional)
 * {
 *   approvalComment: "string"
 * }
 */
exports.approvePendingApproval = async (req, res) => {
  try {
    const { pendingApprovalId } = req.params;
    const { approvalComment } = req.body || {};

    console.log('✅ [approvePendingApproval] called for:', pendingApprovalId, 'by:', req.user.id);

    // Verify user is consultant_admin
    if (req.user.userType !== 'consultant_admin') {
      return res.status(403).json({
        message: 'Only consultant_admin can approve pending entries'
      });
    }

    // Fetch pending approval
    const pending = await PendingApproval.findById(pendingApprovalId);
    if (!pending) {
      return res.status(404).json({ message: 'Pending approval not found' });
    }

    // Verify consultant has access to this client
    const assignedClientIds = await getConsultantAssignedClients(req.user.id);
    if (!assignedClientIds.includes(pending.clientId)) {
      return res.status(403).json({
        message: 'You do not have access to approve this entry'
      });
    }

    // Check if already reviewed
    if (pending.status !== 'Pending_Approval') {
      return res.status(400).json({
        message: `Entry is already ${pending.status}`,
        currentStatus: pending.status
      });
    }

    // Update pending approval with approval
    pending.status = 'Approved';
    pending.reviewedBy = req.user.id;
    pending.reviewedAt = new Date();
    await pending.save();

    // Replay the original entry to the appropriate collection
    let finalizedEntry;
    let finalizedCollection;

    try {
      if (pending.flowType === 'dataEntry') {
        const entryData = {
          ...pending.originalPayload,
          approvalStatus: 'approved',
          approvedBy: req.user.id,
          approvedAt: new Date()
        };

        finalizedEntry = await DataEntry.create(entryData);
        finalizedCollection = 'DataEntry';
        console.log(`  ↳ Created DataEntry: ${finalizedEntry._id}`);

      } else if (pending.flowType === 'netReduction') {
        const entryData = {
          ...pending.originalPayload,
          approvalStatus: 'approved',
          approvedBy: req.user.id,
          approvedAt: new Date()
        };

        finalizedEntry = await NetReductionEntry.create(entryData);
        finalizedCollection = 'NetReductionEntry';
        console.log(`  ↳ Created NetReductionEntry: ${finalizedEntry._id}`);
      }

      // Update pending approval with finalized entry info
      pending.finalizedEntryId = finalizedEntry._id;
      pending.finalizedCollection = finalizedCollection;
      await pending.save();

      // Update notification status if exists
      if (pending.notificationId) {
        await Notification.updateOne(
          { _id: pending.notificationId },
          {
            status: 'resolved',
            resolution: 'approved',
            resolvedAt: new Date()
          }
        );
      }

      console.log(`✅ [approvePendingApproval] Approved and finalized: ${finalizedEntry._id}`);

      return res.status(200).json({
        success: true,
        message: `Entry approved and saved to ${finalizedCollection}`,
        pendingApprovalId: pending._id,
        finalizedEntryId: finalizedEntry._id,
        finalizedCollection
      });

    } catch (replayErr) {
      console.error(`❌ [approvePendingApproval] Failed to replay entry:`, replayErr.message);

      // Rollback pending approval status
      pending.status = 'Pending_Approval';
      pending.reviewedBy = undefined;
      pending.reviewedAt = undefined;
      await pending.save();

      return res.status(500).json({
        message: 'Failed to finalize entry',
        error: replayErr.message
      });
    }

  } catch (err) {
    console.error('❌ [approvePendingApproval] error:', err);
    return res.status(500).json({
      message: 'Error approving pending entry',
      error: err.message
    });
  }
};

/**
 * Reject pending entry
 * POST /api/verification/pending-approvals/:pendingApprovalId/reject
 *
 * Body (required):
 * {
 *   rejectionReason: "string - reason for rejection"
 * }
 */
exports.rejectPendingApproval = async (req, res) => {
  try {
    const { pendingApprovalId } = req.params;
    const { rejectionReason } = req.body || {};

    console.log('❌ [rejectPendingApproval] called for:', pendingApprovalId, 'by:', req.user.id);

    // Verify user is consultant_admin
    if (req.user.userType !== 'consultant_admin') {
      return res.status(403).json({
        message: 'Only consultant_admin can reject pending entries'
      });
    }

    // Validate rejection reason
    if (!rejectionReason || rejectionReason.trim().length === 0) {
      return res.status(400).json({
        message: 'Rejection reason is required'
      });
    }

    // Fetch pending approval
    const pending = await PendingApproval.findById(pendingApprovalId);
    if (!pending) {
      return res.status(404).json({ message: 'Pending approval not found' });
    }

    // Verify consultant has access to this client
    const assignedClientIds = await getConsultantAssignedClients(req.user.id);
    if (!assignedClientIds.includes(pending.clientId)) {
      return res.status(403).json({
        message: 'You do not have access to reject this entry'
      });
    }

    // Check if already reviewed
    if (pending.status !== 'Pending_Approval') {
      return res.status(400).json({
        message: `Entry is already ${pending.status}`,
        currentStatus: pending.status
      });
    }

    // Update pending approval with rejection
    pending.status = 'Rejected';
    pending.reviewedBy = req.user.id;
    pending.reviewedAt = new Date();
    pending.rejectionReason = rejectionReason;
    await pending.save();

    // Update notification status if exists
    if (pending.notificationId) {
      await Notification.updateOne(
        { _id: pending.notificationId },
        {
          status: 'resolved',
          resolution: 'rejected',
          resolvedAt: new Date()
        }
      );
    }

    console.log(`✅ [rejectPendingApproval] Rejected: ${pending._id}`);

    return res.status(200).json({
      success: true,
      message: 'Entry rejected and discarded',
      pendingApprovalId: pending._id,
      rejectionReason: rejectionReason
    });

  } catch (err) {
    console.error('❌ [rejectPendingApproval] error:', err);
    return res.status(500).json({
      message: 'Error rejecting pending entry',
      error: err.message
    });
  }
};

/**
 * Get statistics for consultant's pending entries
 * GET /api/verification/pending-approvals/stats/overview
 */
exports.getPendingApprovalStats = async (req, res) => {
  try {
    console.log('📊 [getPendingApprovalStats] called by:', req.user.id);

    // Verify user is consultant_admin
    if (req.user.userType !== 'consultant_admin') {
      return res.status(403).json({
        message: 'Only consultant_admin can view stats'
      });
    }

    // Get consultant's assigned clients
    const assignedClientIds = await getConsultantAssignedClients(req.user.id);
    if (assignedClientIds.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          totalPending: 0,
          totalApproved: 0,
          totalRejected: 0,
          byFlowType: { dataEntry: 0, netReduction: 0 },
          oldestPending: null
        }
      });
    }

    const query = {
      clientId: { $in: assignedClientIds }
    };

    // Get counts by status
    const stats = await PendingApproval.aggregate([
      { $match: query },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);

    // Get counts by flow type (pending only)
    const flowStats = await PendingApproval.aggregate([
      { $match: { ...query, status: 'Pending_Approval' } },
      {
        $group: {
          _id: '$flowType',
          count: { $sum: 1 }
        }
      }
    ]);

    // Get oldest pending
    const oldest = await PendingApproval.findOne({
      ...query,
      status: 'Pending_Approval'
    })
      .sort({ submittedAt: 1 })
      .select('submittedAt')
      .lean();

    // Format response
    const statsObj = {
      totalPending: 0,
      totalApproved: 0,
      totalRejected: 0
    };

    stats.forEach(stat => {
      if (stat._id === 'Pending_Approval') statsObj.totalPending = stat.count;
      if (stat._id === 'Approved') statsObj.totalApproved = stat.count;
      if (stat._id === 'Rejected') statsObj.totalRejected = stat.count;
    });

    const byFlowType = { dataEntry: 0, netReduction: 0 };
    flowStats.forEach(fs => {
      if (fs._id === 'dataEntry') byFlowType.dataEntry = fs.count;
      if (fs._id === 'netReduction') byFlowType.netReduction = fs.count;
    });

    return res.status(200).json({
      success: true,
      data: {
        totalPending: statsObj.totalPending,
        totalApproved: statsObj.totalApproved,
        totalRejected: statsObj.totalRejected,
        byFlowType,
        oldestPending: oldest?.submittedAt || null
      }
    });

  } catch (err) {
    console.error('❌ [getPendingApprovalStats] error:', err);
    return res.status(500).json({
      message: 'Error fetching stats',
      error: err.message
    });
  }
};

module.exports = {
  listPendingApprovals,
  getPendingApprovalDetail,
  approvePendingApproval,
  rejectPendingApproval,
  getPendingApprovalStats
};
