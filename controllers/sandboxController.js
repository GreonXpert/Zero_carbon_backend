const Client = require('../models/Client');
const User = require('../models/User');
const mongoose = require('mongoose');

/**
 * Approve a sandbox client and transition to production
 * POST /api/sandbox/approve/:clientId
 */
const approveSandboxClient = async (req, res) => {
  const session = await mongoose.startSession();
  
  try {
    const { clientId } = req.params;
    const { approvedBy, notes } = req.body;
    
    // Verify user has permission to approve (super_admin or consultant_admin)
    if (!['super_admin', 'consultant_admin'].includes(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message: 'Only super admins and consultant admins can approve sandbox clients'
      });
    }
    
    await session.startTransaction();
    
    // Find the sandbox client
    const sandboxClient = await Client.findOne({ 
      clientId, 
      sandbox: true 
    }).session(session);
    
    if (!sandboxClient) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: 'Sandbox client not found'
      });
    }
    
    // Check if client is already active
    if (sandboxClient.isActive) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Client is already active'
      });
    }
    
    // Generate new production client ID
    const newClientId = await Client.generateClientId();
    
    // Store old sandbox ID for reference
    const oldSandboxId = sandboxClient.clientId;
    
    // Update client to production status
    sandboxClient.clientId = newClientId;
    sandboxClient.sandbox = false;
    sandboxClient.isActive = true;
    sandboxClient.stage = 'active';
    sandboxClient.status = 'active';
    
    // Add approval to timeline
    if (!sandboxClient.timeline) sandboxClient.timeline = [];
    sandboxClient.timeline.push({
      stage: 'active',
      status: 'active',
      action: 'sandbox_approved',
      performedBy: req.user.id,
      timestamp: new Date(),
      notes: `Sandbox client ${oldSandboxId} approved and transitioned to production as ${newClientId}. ${notes || ''}`
    });
    
    // Save updated client
    await sandboxClient.save({ session });
    
    // Update all associated sandbox users
    const sandboxUsers = await User.find({ 
      clientId: oldSandboxId,
      sandbox: true 
    }).session(session);
    
    const userUpdateResults = [];
    
    for (const user of sandboxUsers) {
      // Update user to production status
      user.clientId = newClientId;
      user.sandbox = false;
      user.isActive = true;
      
      await user.save({ session });
      
      userUpdateResults.push({
        userId: user._id,
        email: user.email,
        userType: user.userType,
        transitioned: true
      });
    }
    
    // Update any references in other collections (if needed)
    // For example, update Flowcharts, DataEntries, etc.
    const collectionsToUpdate = [
      'flowcharts',
      'processflowcharts',
      'dataentries',
      'reductions',
      'decarbonizations'
    ];
    
    for (const collectionName of collectionsToUpdate) {
      try {
        await mongoose.connection.collection(collectionName).updateMany(
          { clientId: oldSandboxId },
          { $set: { clientId: newClientId } },
          { session }
        );
      } catch (err) {
        // Collection might not exist, skip
        console.log(`Skipping update for collection ${collectionName}: ${err.message}`);
      }
    }
    
    await session.commitTransaction();
    
    // Send success response
    res.status(200).json({
      success: true,
      message: 'Sandbox client successfully transitioned to production',
      data: {
        oldClientId: oldSandboxId,
        newClientId: newClientId,
        clientName: sandboxClient.submissionData?.companyInfo?.companyName || sandboxClient.leadInfo?.companyName,
        transitionedUsers: userUpdateResults.length,
        userDetails: userUpdateResults,
        approvedBy: req.user.email,
        approvedAt: new Date()
      }
    });
    
  } catch (error) {
    await session.abortTransaction();
    console.error('Sandbox approval error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to approve sandbox client',
      error: error.message
    });
  } finally {
    session.endSession();
  }
};

/**
 * Reject a sandbox client
 * POST /api/sandbox/reject/:clientId
 */
const rejectSandboxClient = async (req, res) => {
  const session = await mongoose.startSession();
  
  try {
    const { clientId } = req.params;
    const { reason, deleteData = false } = req.body;
    
    // Verify user has permission
    if (!['super_admin', 'consultant_admin'].includes(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message: 'Only super admins and consultant admins can reject sandbox clients'
      });
    }
    
    await session.startTransaction();
    
    // Find the sandbox client
    const sandboxClient = await Client.findOne({ 
      clientId, 
      sandbox: true 
    }).session(session);
    
    if (!sandboxClient) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: 'Sandbox client not found'
      });
    }
    
    if (deleteData) {
      // Hard delete the sandbox client and associated users
      await Client.deleteOne({ _id: sandboxClient._id }).session(session);
      await User.deleteMany({ clientId }).session(session);
      
      // Delete associated data
      const collectionsToClean = [
        'flowcharts',
        'processflowcharts',
        'dataentries'
      ];
      
      for (const collectionName of collectionsToClean) {
        try {
          await mongoose.connection.collection(collectionName).deleteMany(
            { clientId },
            { session }
          );
        } catch (err) {
          console.log(`Skipping deletion for collection ${collectionName}: ${err.message}`);
        }
      }
      
      await session.commitTransaction();
      
      res.status(200).json({
        success: true,
        message: 'Sandbox client rejected and data deleted',
        data: {
          clientId,
          action: 'deleted',
          reason
        }
      });
    } else {
      // Soft rejection - mark as rejected but keep data
      sandboxClient.status = 'rejected';
      
      // Add rejection to timeline
      if (!sandboxClient.timeline) sandboxClient.timeline = [];
      sandboxClient.timeline.push({
        stage: sandboxClient.stage,
        status: 'rejected',
        action: 'sandbox_rejected',
        performedBy: req.user.id,
        timestamp: new Date(),
        notes: reason || 'Sandbox client rejected'
      });
      
      await sandboxClient.save({ session });
      
      // Deactivate associated users
      await User.updateMany(
        { clientId, sandbox: true },
        { 
          $set: { 
            isActive: false,
            suspensionReason: 'Sandbox client rejected' 
          } 
        },
        { session }
      );
      
      await session.commitTransaction();
      
      res.status(200).json({
        success: true,
        message: 'Sandbox client rejected',
        data: {
          clientId,
          action: 'rejected',
          reason
        }
      });
    }
    
  } catch (error) {
    await session.abortTransaction();
    console.error('Sandbox rejection error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reject sandbox client',
      error: error.message
    });
  } finally {
    session.endSession();
  }
};

/**
 * Get all sandbox clients
 * GET /api/sandbox/clients
 */
const getSandboxClients = async (req, res) => {
  try {
    const { page = 1, limit = 10, search = '' } = req.query;
    
    // Build query based on user permissions
    let query = { sandbox: true, isDeleted: false };
    
    if (req.user.userType === 'consultant_admin') {
      // Consultant admin sees only their sandbox clients
      const User = require('../models/User');
      const consultants = await User.find({ 
        consultantAdminId: req.user.id 
      }).select('_id');
      
      const consultantIds = consultants.map(c => c._id);
      consultantIds.push(req.user.id);
      
      query.$or = [
        { 'leadInfo.consultantAdminId': req.user.id },
        { 'leadInfo.assignedConsultantId': { $in: consultantIds } },
        { 'workflowTracking.assignedConsultantId': { $in: consultantIds } }
      ];
    } else if (req.user.userType !== 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to view sandbox clients'
      });
    }
    
    // Add search filter
    if (search) {
      query.$and = [
        ...(query.$and || []),
        {
          $or: [
            { clientId: { $regex: search, $options: 'i' } },
            { 'leadInfo.companyName': { $regex: search, $options: 'i' } },
            { 'submissionData.companyInfo.companyName': { $regex: search, $options: 'i' } }
          ]
        }
      ];
    }
    
    // Pagination
    const skip = (page - 1) * limit;
    const total = await Client.countDocuments(query);
    
    const sandboxClients = await Client.find(query)
      .populate('leadInfo.consultantAdminId', 'email userName')
      .populate('leadInfo.assignedConsultantId', 'email userName')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip(skip);
    
    res.status(200).json({
      success: true,
      data: {
        clients: sandboxClients,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / limit)
        }
      }
    });
    
  } catch (error) {
    console.error('Get sandbox clients error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch sandbox clients',
      error: error.message
    });
  }
};

/**
 * Get sandbox client details
 * GET /api/sandbox/clients/:clientId
 */
const getSandboxClientDetails = async (req, res) => {
  try {
    const { clientId } = req.params;
    
    const sandboxClient = await Client.findOne({ 
      clientId, 
      sandbox: true 
    })
    .populate('leadInfo.consultantAdminId', 'email userName userType')
    .populate('leadInfo.assignedConsultantId', 'email userName userType')
    .populate('leadInfo.createdBy', 'email userName userType');
    
    if (!sandboxClient) {
      return res.status(404).json({
        success: false,
        message: 'Sandbox client not found'
      });
    }
    
    // Get associated sandbox users
    const sandboxUsers = await User.find({ 
      clientId,
      sandbox: true 
    }).select('email userName userType isActive createdAt');
    
    // Get data completeness
    const dataCompleteness = sandboxClient.calculateDataCompleteness 
      ? sandboxClient.calculateDataCompleteness() 
      : 0;
    
    res.status(200).json({
      success: true,
      data: {
        client: sandboxClient,
        users: sandboxUsers,
        statistics: {
          userCount: sandboxUsers.length,
          dataCompleteness: `${dataCompleteness}%`,
          daysSinceCreation: Math.floor((Date.now() - sandboxClient.createdAt) / (1000 * 60 * 60 * 24))
        }
      }
    });
    
  } catch (error) {
    console.error('Get sandbox client details error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch sandbox client details',
      error: error.message
    });
  }
};

/**
 * Reset sandbox client (clear data and start fresh)
 * POST /api/sandbox/reset/:clientId
 */
const resetSandboxClient = async (req, res) => {
  const session = await mongoose.startSession();
  
  try {
    const { clientId } = req.params;
    
    // Verify permission
    if (!['super_admin', 'consultant_admin'].includes(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message: 'Only super admins and consultant admins can reset sandbox clients'
      });
    }
    
    await session.startTransaction();
    
    // Find the sandbox client
    const sandboxClient = await Client.findOne({ 
      clientId, 
      sandbox: true 
    }).session(session);
    
    if (!sandboxClient) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: 'Sandbox client not found'
      });
    }
    
    // Clear submission data but keep lead info
    sandboxClient.submissionData = {};
    sandboxClient.proposalData = {};
    sandboxClient.workflowTracking = {
      flowchartStatus: 'not_started',
      processFlowchartStatus: 'not_started'
    };
    sandboxClient.status = 'pending';
    
    // Add reset to timeline
    if (!sandboxClient.timeline) sandboxClient.timeline = [];
    sandboxClient.timeline.push({
      stage: sandboxClient.stage,
      status: 'pending',
      action: 'sandbox_reset',
      performedBy: req.user.id,
      timestamp: new Date(),
      notes: 'Sandbox client data reset'
    });
    
    await sandboxClient.save({ session });
    
    // Delete associated data collections
    const collectionsToClean = [
      'flowcharts',
      'processflowcharts',
      'dataentries'
    ];
    
    for (const collectionName of collectionsToClean) {
      try {
        await mongoose.connection.collection(collectionName).deleteMany(
          { clientId },
          { session }
        );
      } catch (err) {
        console.log(`Skipping cleanup for collection ${collectionName}: ${err.message}`);
      }
    }
    
    await session.commitTransaction();
    
    res.status(200).json({
      success: true,
      message: 'Sandbox client successfully reset',
      data: {
        clientId,
        resetBy: req.user.email,
        resetAt: new Date()
      }
    });
    
  } catch (error) {
    await session.abortTransaction();
    console.error('Sandbox reset error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reset sandbox client',
      error: error.message
    });
  } finally {
    session.endSession();
  }
};

module.exports = {
  approveSandboxClient,
  rejectSandboxClient,
  getSandboxClients,
  getSandboxClientDetails,
  resetSandboxClient
};