// controllers/processflowController.js
const ProcessFlowchart = require('../models/ProcessFlowchart');
const Client = require('../models/Client');
const User = require('../models/User');
const mongoose = require('mongoose');

// Helper function to check if user can manage process flowchart
const canManageProcessFlowchart = async (user, clientId) => {
  // Super admin can manage all
  if (user.userType === 'super_admin') {
    return true;
  }

  const client = await Client.findOne({ clientId });
  if (!client) return false;

  // Consultant admin can manage their clients' flowcharts
  if (user.userType === 'consultant_admin') {
    // Get all consultant IDs under this admin
    const consultants = await User.find({ 
      consultantAdminId: user._id,
      userType: 'consultant'
    }).select('_id');
    const consultantIds = consultants.map(c => c._id);
    consultantIds.push(user._id);

    return (
      client.leadInfo.consultantAdminId?.toString() === user._id.toString() ||
      consultantIds.some(id => client.leadInfo.assignedConsultantId?.toString() === id.toString())
    );
  }

  // Consultant can manage assigned clients' flowcharts
  if (user.userType === 'consultant') {
    return client.leadInfo.assignedConsultantId?.toString() === user._id.toString();
  }

  return false;
};

// Save or update process flowchart
const saveProcessFlowchart = async (req, res) => {
  try {
    const { clientId, flowchartData } = req.body;

    // Validate input
    if (!clientId || !flowchartData || !flowchartData.nodes || !flowchartData.edges) {
      return res.status(400).json({ 
        message: 'Missing required fields: clientId and flowchartData (nodes, edges)' 
      });
    }

    // Check if user can manage this client's process flowchart
    const canManage = await canManageProcessFlowchart(req.user, clientId);
    if (!canManage) {
      return res.status(403).json({ 
        message: 'You do not have permission to manage process flowcharts for this client' 
      });
    }

    // Check if client exists and is active
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: 'Client not found' });
    }
    if (client.stage !== 'active') {
      return res.status(400).json({ 
        message: 'Process flowcharts can only be created for active clients' 
      });
    }

    // Find existing or create new
    let processFlowchart = await ProcessFlowchart.findOne({ 
      clientId, 
      isDeleted: false 
    });

    if (processFlowchart) {
      // Update existing
      processFlowchart.nodes = flowchartData.nodes;
      processFlowchart.edges = flowchartData.edges;
      processFlowchart.lastModifiedBy = req.user._id;
    } else {
      // Create new
      processFlowchart = new ProcessFlowchart({
        clientId,
        nodes: flowchartData.nodes,
        edges: flowchartData.edges,
        createdBy: req.user._id,
        lastModifiedBy: req.user._id
      });
    }

    await processFlowchart.save();

                // Auto‐start flowchart status
            if (['consultant','consultant_admin'].includes(req.user.userType)) {
              await Client.findOneAndUpdate(
                { clientId },
                { 
                  $set: {
                    'workflowTracking.flowchartStatus': 'on_going',
                    'workflowTracking.flowchartStartedAt': new Date()
                  }
                }
              );
            }

    res.status(200).json({ 
      message: processFlowchart.isNew ? 'Process flowchart created successfully' : 'Process flowchart updated successfully',
      flowchart: {
        clientId: processFlowchart.clientId,
        nodes: processFlowchart.nodes,
        edges: processFlowchart.edges,
        createdAt: processFlowchart.createdAt,
        updatedAt: processFlowchart.updatedAt
      }
    });

  } catch (error) {
    console.error('Save process flowchart error:', error);
    res.status(500).json({ 
      message: 'Failed to save process flowchart', 
      error: error.message 
    });
  }
};

// Get process flowchart by clientId
const getProcessFlowchart = async (req, res) => {
  try {
    const { clientId } = req.params;

    // Check permissions
    let canView = false;
    
    if (req.user.userType === 'super_admin') {
      canView = true;
    } else if (['consultant_admin', 'consultant'].includes(req.user.userType)) {
      canView = await canManageProcessFlowchart(req.user, clientId);
    } else if (req.user.userType === 'client_admin') {
      // Client admin can only view their own client's flowchart
      canView = req.user.clientId === clientId;
    }

    if (!canView) {
      return res.status(403).json({ 
        message: 'You do not have permission to view this process flowchart' 
      });
    }

    const processFlowchart = await ProcessFlowchart.findOne({ 
      clientId, 
      isDeleted: false 
    })
    .populate('createdBy', 'userName email')
    .populate('lastModifiedBy', 'userName email');

    if (!processFlowchart) {
      return res.status(404).json({ 
        message: 'Process flowchart not found' 
      });
    }

    res.status(200).json({
      flowchart: {
        clientId: processFlowchart.clientId,
        nodes: processFlowchart.nodes,
        edges: processFlowchart.edges,
        createdBy: processFlowchart.createdBy,
        lastModifiedBy: processFlowchart.lastModifiedBy,
        createdAt: processFlowchart.createdAt,
        updatedAt: processFlowchart.updatedAt
      }
    });

  } catch (error) {
    console.error('Get process flowchart error:', error);
    res.status(500).json({ 
      message: 'Failed to fetch process flowchart', 
      error: error.message 
    });
  }
};

// Get all process flowcharts (based on user hierarchy)
const getAllProcessFlowcharts = async (req, res) => {
  try {
    let query = { isDeleted: false };
    const { search, page = 1, limit = 10 } = req.query;

    // Build query based on user type
    if (req.user.userType === 'super_admin') {
      // Super admin sees all
    } else if (req.user.userType === 'consultant_admin') {
      // Get all clients managed by this consultant admin
      const consultants = await User.find({ 
        consultantAdminId: req.user._id,
        userType: 'consultant'
      }).select('_id');
      const consultantIds = consultants.map(c => c._id);
      consultantIds.push(req.user._id);

      const clients = await Client.find({
        $or: [
          { 'leadInfo.consultantAdminId': req.user._id },
          { 'leadInfo.assignedConsultantId': { $in: consultantIds } }
        ]
      }).select('clientId');

      query.clientId = { $in: clients.map(c => c.clientId) };
    } else if (req.user.userType === 'consultant') {
      // Consultant sees only assigned clients
      const clients = await Client.find({
        'leadInfo.assignedConsultantId': req.user._id
      }).select('clientId');

      query.clientId = { $in: clients.map(c => c.clientId) };
    } else if (req.user.userType === 'client_admin') {
      // Client admin sees only their client
      query.clientId = req.user.clientId;
    } else {
      return res.status(403).json({ 
        message: 'You do not have permission to view process flowcharts' 
      });
    }

    // Add search if provided
    if (search) {
      const clientIds = await Client.find({
        $or: [
          { clientId: { $regex: search, $options: 'i' } },
          { 'leadInfo.companyName': { $regex: search, $options: 'i' } }
        ]
      }).select('clientId');
      
      query.$and = [
        query,
        { clientId: { $in: clientIds.map(c => c.clientId) } }
      ];
    }

    // Pagination
    const skip = (page - 1) * limit;
    const total = await ProcessFlowchart.countDocuments(query);

    const flowcharts = await ProcessFlowchart.find(query)
      .populate('createdBy', 'userName email')
      .populate('lastModifiedBy', 'userName email')
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    // Get client details for each flowchart
    const enrichedFlowcharts = await Promise.all(
      flowcharts.map(async (flowchart) => {
        const client = await Client.findOne({ clientId: flowchart.clientId })
          .select('clientId leadInfo.companyName stage status');
        
        return {
          _id: flowchart._id,
          clientId: flowchart.clientId,
          companyName: client?.leadInfo?.companyName || 'Unknown',
          nodeCount: flowchart.nodes.length,
          edgeCount: flowchart.edges.length,
          createdBy: flowchart.createdBy,
          lastModifiedBy: flowchart.lastModifiedBy,
          createdAt: flowchart.createdAt,
          updatedAt: flowchart.updatedAt
        };
      })
    );

    res.status(200).json({
      flowcharts: enrichedFlowcharts,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Get all process flowcharts error:', error);
    res.status(500).json({ 
      message: 'Failed to fetch process flowcharts', 
      error: error.message 
    });
  }
};

// Update process flowchart node
const updateProcessFlowchartNode = async (req, res) => {
  try {
    const { clientId, nodeId } = req.params;
    const { nodeData } = req.body;

    // Check if user can manage
    const canManage = await canManageProcessFlowchart(req.user, clientId);
    if (!canManage) {
      return res.status(403).json({ 
        message: 'You do not have permission to update this process flowchart' 
      });
    }

    const processFlowchart = await ProcessFlowchart.findOne({ 
      clientId, 
      isDeleted: false 
    });

    if (!processFlowchart) {
      return res.status(404).json({ message: 'Process flowchart not found' });
    }

    // Find and update the specific node
    const nodeIndex = processFlowchart.nodes.findIndex(n => n.id === nodeId);
    if (nodeIndex === -1) {
      return res.status(404).json({ message: 'Node not found' });
    }

    // Update node data
    processFlowchart.nodes[nodeIndex] = {
      ...processFlowchart.nodes[nodeIndex],
      ...nodeData,
      id: nodeId // Ensure ID doesn't change
    };

    processFlowchart.lastModifiedBy = req.user._id;
    await processFlowchart.save();

    res.status(200).json({ 
      message: 'Node updated successfully',
      node: processFlowchart.nodes[nodeIndex]
    });

  } catch (error) {
    console.error('Update process flowchart node error:', error);
    res.status(500).json({ 
      message: 'Failed to update node', 
      error: error.message 
    });
  }
};

// Delete process flowchart (soft delete)
const deleteProcessFlowchart = async (req, res) => {
  try {
    const { clientId } = req.params;

    // Check if user can manage
    const canManage = await canManageProcessFlowchart(req.user, clientId);
    if (!canManage) {
      return res.status(403).json({ 
        message: 'You do not have permission to delete this process flowchart' 
      });
    }

    const processFlowchart = await ProcessFlowchart.findOne({ 
      clientId, 
      isDeleted: false 
    });

    if (!processFlowchart) {
      return res.status(404).json({ message: 'Process flowchart not found' });
    }

    // Soft delete
    processFlowchart.isDeleted = true;
    processFlowchart.deletedAt = new Date();
    processFlowchart.deletedBy = req.user._id;
    await processFlowchart.save();

    res.status(200).json({ 
      message: 'Process flowchart deleted successfully' 
    });

  } catch (error) {
    console.error('Delete process flowchart error:', error);
    res.status(500).json({ 
      message: 'Failed to delete process flowchart', 
      error: error.message 
    });
  }
};

// Delete specific node from process flowchart
const deleteProcessNode = async (req, res) => {
  try {
    const { clientId, nodeId } = req.params;

    // Check if user can manage
    const canManage = await canManageProcessFlowchart(req.user, clientId);
    if (!canManage) {
      return res.status(403).json({ 
        message: 'You do not have permission to modify this process flowchart' 
      });
    }

    const processFlowchart = await ProcessFlowchart.findOne({ 
      clientId, 
      isDeleted: false 
    });

    if (!processFlowchart) {
      return res.status(404).json({ message: 'Process flowchart not found' });
    }

    // Remove node and related edges
    processFlowchart.nodes = processFlowchart.nodes.filter(n => n.id !== nodeId);
    processFlowchart.edges = processFlowchart.edges.filter(
      e => e.source !== nodeId && e.target !== nodeId
    );

    processFlowchart.lastModifiedBy = req.user._id;
    await processFlowchart.save();

    res.status(200).json({ 
      message: 'Node and associated edges deleted successfully' 
    });

  } catch (error) {
    console.error('Delete process node error:', error);
    res.status(500).json({ 
      message: 'Failed to delete node', 
      error: error.message 
    });
  }
};

// Get process flowchart summary
const getProcessFlowchartSummary = async (req, res) => {
  try {
    const { clientId } = req.params;

    // Check permissions (same as view permissions)
    let canView = false;
    
    if (req.user.userType === 'super_admin') {
      canView = true;
    } else if (['consultant_admin', 'consultant'].includes(req.user.userType)) {
      canView = await canManageProcessFlowchart(req.user, clientId);
    } else if (req.user.userType === 'client_admin') {
      canView = req.user.clientId === clientId;
    }

    if (!canView) {
      return res.status(403).json({ 
        message: 'You do not have permission to view this process flowchart' 
      });
    }

    const processFlowchart = await ProcessFlowchart.findOne({ 
      clientId, 
      isDeleted: false 
    });

    if (!processFlowchart) {
      return res.status(404).json({ message: 'Process flowchart not found' });
    }

    // Generate summary
    const summary = {
      clientId,
      totalNodes: processFlowchart.nodes.length,
      totalEdges: processFlowchart.edges.length,
      nodeTypes: {},
      createdAt: processFlowchart.createdAt,
      lastModified: processFlowchart.updatedAt
    };

    // Count node types if they have a type property
    processFlowchart.nodes.forEach(node => {
      const type = node.details?.type || 'default';
      summary.nodeTypes[type] = (summary.nodeTypes[type] || 0) + 1;
    });

    res.status(200).json({ summary });

  } catch (error) {
    console.error('Get process flowchart summary error:', error);
    res.status(500).json({ 
      message: 'Failed to fetch summary', 
      error: error.message 
    });
  }
};

// Restore deleted process flowchart
// Restore deleted process flowchart
const restoreProcessFlowchart = async (req, res) => {
  try {
    const { clientId } = req.params;

    // Only super_admin, consultant_admin and consultant can restore
    const canManage = await canManageProcessFlowchart(req.user, clientId);
    if (!canManage) {
      return res.status(403).json({
        message: 'You do not have permission to restore this process flowchart'
      });
    }

    // If there's already an active flowchart, conflict
    const existingActive = await ProcessFlowchart.findOne({
      clientId,
      isDeleted: false
    });
    if (existingActive) {
      return res.status(409).json({
        message: 'Conflict: an active process flowchart already exists for this client'
      });
    }

    // Find the deleted flowchart
    const processFlowchart = await ProcessFlowchart.findOne({
      clientId,
      isDeleted: true
    });
    if (!processFlowchart) {
      return res.status(404).json({
        message: 'No deleted process flowchart found for this client'
      });
    }

    // Restore
    processFlowchart.isDeleted     = false;
    processFlowchart.deletedAt     = null;
    processFlowchart.deletedBy     = null;
    processFlowchart.lastModifiedBy = req.user._id;
    await processFlowchart.save();

    res.status(200).json({
      message: 'Process flowchart restored successfully'
    });

  } catch (error) {
    console.error('Restore process flowchart error:', error);
    res.status(500).json({
      message: 'Failed to restore process flowchart',
      error: error.message
    });
  }
};


module.exports = {
  saveProcessFlowchart,
  getProcessFlowchart,
  getAllProcessFlowcharts,
  updateProcessFlowchartNode,
  deleteProcessFlowchart,
  deleteProcessNode,
  getProcessFlowchartSummary,
  restoreProcessFlowchart
};