// routes/sandboxRoutes.js
const express = require('express');
const router = express.Router();
const { auth, checkRole } = require('../middleware/auth');
const { checkSandboxAccess, attachSandboxStatus } = require('../middleware/sandboxAuth');
const {
  approveSandboxClient,
  rejectSandboxClient,
  getSandboxClients,
  getSandboxClientDetails,
  resetSandboxClient
} = require('../controllers/sandboxController');

// All routes require authentication
router.use(auth);
router.use(attachSandboxStatus);

// Admin routes (super_admin and consultant_admin only)
router.post('/approve/:clientId', 
  checkRole(['super_admin', 'consultant_admin']),
  approveSandboxClient
);

router.post('/reject/:clientId', 
  checkRole(['super_admin', 'consultant_admin']),
  rejectSandboxClient
);

router.post('/reset/:clientId', 
  checkRole(['super_admin', 'consultant_admin']),
  resetSandboxClient
);

router.get('/clients', 
  checkRole(['super_admin', 'consultant_admin']),
  getSandboxClients
);

router.get('/clients/:clientId', 
  checkRole(['super_admin', 'consultant_admin', 'consultant']),
  getSandboxClientDetails
);

// Sandbox user routes
router.get('/my-status', async (req, res) => {
  try {
    if (!req.user.sandbox) {
      return res.status(400).json({
        success: false,
        message: 'This endpoint is only for sandbox users'
      });
    }
    
    const Client = require('../models/Client');
    const client = await Client.findOne({ 
      clientId: req.user.clientId,
      sandbox: true 
    }).select('clientId status stage submissionData.companyInfo.companyName timeline');
    
    if (!client) {
      return res.status(404).json({
        success: false,
        message: 'Sandbox client not found'
      });
    }
    
    res.status(200).json({
      success: true,
      data: {
        clientId: client.clientId,
        companyName: client.submissionData?.companyInfo?.companyName,
        status: client.status,
        stage: client.stage,
        isSandbox: true,
        limitations: [
          'Limited to read-only access for most features',
          'Cannot create production data',
          'Cannot access billing or payment features',
          'Cannot manage other users'
        ],
        timeline: client.timeline?.slice(-5) // Last 5 timeline entries
      }
    });
  } catch (error) {
    console.error('Get sandbox status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get sandbox status',
      error: error.message
    });
  }
});

router.post('/request-approval', async (req, res) => {
  try {
    if (!req.user.sandbox) {
      return res.status(400).json({
        success: false,
        message: 'This endpoint is only for sandbox users'
      });
    }
    
    const { message, additionalInfo } = req.body;
    
    const Client = require('../models/Client');
    const client = await Client.findOne({ 
      clientId: req.user.clientId,
      sandbox: true 
    });
    
    if (!client) {
      return res.status(404).json({
        success: false,
        message: 'Sandbox client not found'
      });
    }
    
    // Add approval request to timeline
    if (!client.timeline) client.timeline = [];
    client.timeline.push({
      stage: client.stage,
      status: client.status,
      action: 'approval_requested',
      performedBy: req.user.id,
      timestamp: new Date(),
      notes: `Approval requested: ${message || 'No message provided'}. ${additionalInfo || ''}`
    });
    
    // Update proposal status if exists
    if (!client.proposalData) {
      client.proposalData = {};
    }
    client.proposalData.approvalRequest = {
      requestedBy: req.user.id,
      requestedAt: new Date(),
      message,
      additionalInfo,
      status: 'pending'
    };
    
    await client.save();
    
    // TODO: Send notification to admins
    // await notifyAdminsOfApprovalRequest(client, req.user);
    
    res.status(200).json({
      success: true,
      message: 'Approval request submitted successfully',
      data: {
        clientId: client.clientId,
        requestedAt: new Date(),
        status: 'pending',
        note: 'An administrator will review your request shortly.'
      }
    });
    
  } catch (error) {
    console.error('Request approval error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit approval request',
      error: error.message
    });
  }
});

module.exports = router;