const Client = require("../models/Client");
const User = require("../models/User");
const { sendMail } = require("../utils/mail");
const { createClientAdmin } = require("./userController");
const Notification = require("../models/Notification");
const moment = require("moment");
const { emailQueue } = require("../utils/emailQueue");
const { withTimeout } = require('../utils/queueUtils');

// Add these imports at the top of your clientController.js file
const Flowchart = require("../models/Flowchart");
const ProcessFlowchart = require("../models/ProcessFlowchart");

const {
  createLeadActionNotification,
  createDataSubmissionNotification,
  createProposalActionNotification,
  createConsultantAssignmentNotification
} = require("../utils/notifications/notificationHelper");

const {
  sendLeadCreatedEmail,
  sendConsultantAssignedEmail
} = require('../utils/emailHelper');

const {
 emitFlowchartStatusUpdate,
  emitDataInputPointUpdate,
  emitNewClientCreated,
  emitClientStageChange,
  emitDashboardRefresh,
  emitClientListUpdate,
  emitBatchClientUpdate,
  emitFilteredClientListUpdate
} = require('../utils/dashboardEmitter');

const {
  sendClientDataSubmittedEmail,
  sendClientDataUpdatedEmail,
  sendProposalCreatedEmail,
  sendProposalUpdatedEmail
} = require('../utils/emailServiceClient');


const { renderClientDataHTML, renderProposalHTML } = require('../utils/pdfTemplates');
const { htmlToPdfBuffer } = require('../utils/pdfService');

const {
  normalizeAssessmentLevels,
  validateSubmissionForLevels
} = require('../utils/assessmentLevel');



/**
 * Returns an array of "nodes" with scopeDetails that can be fed to mergePoints()
 * depending on submissionData.assessmentLevel:
 *  - organization → Flowchart nodes
 *  - process → ProcessFlowchart nodes
 *  - both → union of both
 *
 * We also de-duplicate by (nodeId + scopeIdentifier) across charts.
 */
async function getMergedNodesForAssessment(clientId) {
  // 1) read assessment level
  const client = await Client.findOne(
    { clientId },
    { 'submissionData.assessmentLevel': 1, _id: 0 }
  ).lean();

  const levels = Array.isArray(client?.submissionData?.assessmentLevel)
    ? client.submissionData.assessmentLevel.map(s => String(s).toLowerCase())
    : [];

  const hasOrg = levels.includes('organization');
  const hasProc = levels.includes('process');

  // 2) fetch charts (don’t throw if one is missing)
  const [orgChart, procChart] = await Promise.all([
    hasOrg ? Flowchart.findOne({ clientId, isActive: true }).lean() : null,
    hasProc ? ProcessFlowchart.findOne({ clientId, isDeleted: { $ne: true } }).lean() : null
  ]);

  // 3) flatten nodes → (node, scope) pairs that actually have scopeDetails
  const pickScoped = (chart, chartType) => {
    if (!chart?.nodes?.length) return [];
    const list = [];
    for (const node of chart.nodes) {
      const scopes = node?.details?.scopeDetails || [];
      for (const s of scopes) {
        // normalize inputType shape
        const inputType = (s.inputType || '').toString().toLowerCase();
        list.push({
          chartType,
          id: node.id,
          label: node.label,
          details: {
            ...node.details,
            // keep only this scope in a single-scope node shell so mergePoints can iterate
            scopeDetails: [s]
          }
        });
      }
    }
    return list;
  };

  let raw = [];
  if (hasOrg) raw = raw.concat(pickScoped(orgChart, 'flowchart'));
  if (hasProc) raw = raw.concat(pickScoped(procChart, 'processflowchart'));

  // 4) de-duplicate on (nodeId + scopeIdentifier) to avoid doubles when people mirror scopes
  const seen = new Set();
  const unique = [];
  for (const n of raw) {
    const scopeId = n.details.scopeDetails[0]?.scopeIdentifier || 'Unknown';
    const key = `${n.id}::${scopeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(n);
  }

  // 5) regroup back to nodes with scopeDetails[] like Flowchart expects
  //    (merge of scopes per node id)
  const nodeMap = new Map();
  for (const n of unique) {
    const base = nodeMap.get(n.id) || { id: n.id, label: n.label, details: { ...n.details, scopeDetails: [] } };
    const scope = n.details.scopeDetails[0];
    base.details.scopeDetails.push(scope);
    nodeMap.set(n.id, base);
  }

  return Array.from(nodeMap.values());
}




// Additional helper function to emit targeted updates based on filters
const emitTargetedClientUpdate = async (client, action, userId, additionalFilters = {}) => {
    try {
        // Get all users who might be viewing this client
        const affectedUsers = await getAffectedUsers(client);
        
        // Emit update with filters
        for (const affectedUserId of affectedUsers) {
            if (global.io) {
                global.io.to(`user_${affectedUserId}`).emit('targeted_client_update', {
                    action: action,
                    client: {
                        _id: client._id,
                        clientId: client.clientId,
                        stage: client.stage,
                        status: client.status,
                        leadInfo: {
                            companyName: client.leadInfo.companyName
                        }
                    },
                    filters: additionalFilters,
                    timestamp: new Date().toISOString()
                });
            }
        }
    } catch (error) {
        console.error('Error emitting targeted client update:', error);
    }
};

// Helper function to determine affected users
const getAffectedUsers = async (client) => {
    const affectedUsers = new Set();
    
    // Add consultant admin
    if (client.leadInfo.consultantAdminId) {
        affectedUsers.add(client.leadInfo.consultantAdminId.toString());
    }
    
    // Add assigned consultants
    if (client.leadInfo.assignedConsultantId) {
        affectedUsers.add(client.leadInfo.assignedConsultantId.toString());
    }
    
    if (client.workflowTracking?.assignedConsultantId) {
        affectedUsers.add(client.workflowTracking.assignedConsultantId.toString());
    }
    
    // Add all consultants under the consultant admin
    if (client.leadInfo.consultantAdminId) {
        const consultants = await User.find({
            consultantAdminId: client.leadInfo.consultantAdminId,
            userType: 'consultant',
            isActive: true
        }).select('_id');
        
        consultants.forEach(c => affectedUsers.add(c._id.toString()));
    }
    
    // Add client users if active
    if (client.stage === 'active' && client.clientId) {
        const clientUsers = await User.find({
            clientId: client.clientId,
            isActive: true
        }).select('_id');
        
        clientUsers.forEach(u => affectedUsers.add(u._id.toString()));
    }
    
    // Add all super admins
    const superAdmins = await User.find({
        userType: 'super_admin',
        isActive: true
    }).select('_id');
    
    superAdmins.forEach(sa => affectedUsers.add(sa._id.toString()));
    
    return Array.from(affectedUsers);
};

// ====================================
// WORKFLOW TRACKING FUNCTIONS
// Add these functions to your existing clientController.js
// ====================================

// Update flowchart status
const updateFlowchartStatus = async (req, res) => {
  const startTime = Date.now();
  try {
    const { clientId } = req.params;
    const { status } = req.body;
    
    // Validate user is consultant or consultant_admin
    if (!['consultant', 'consultant_admin'].includes(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message: "Only consultants can update flowchart status",
        timestamp: new Date().toISOString()
      });
    }
    
    // Validate status
    if (!['not_started', 'on_going', 'pending', 'completed'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status value. Must be one of: not_started, on_going, pending, completed",
        timestamp: new Date().toISOString()
      });
    }
    
    // Find client
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ 
        success: false,
        message: "Client not found",
        timestamp: new Date().toISOString()
      });
    }
    
    // Check if consultant is assigned to this client
    if (req.user.userType === 'consultant') {
      if (client.workflowTracking.assignedConsultantId?.toString() !== req.user.id &&
          client.leadInfo.assignedConsultantId?.toString() !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: "You are not assigned to this client",
          timestamp: new Date().toISOString()
        });
      }
    }
    
    // Update flowchart status
    const previousStatus = client.workflowTracking.flowchartStatus;
    client.workflowTracking.flowchartStatus = status;
    
    // Set timestamps
    if (status === 'on_going' && previousStatus === 'not_started') {
      client.workflowTracking.flowchartStartedAt = new Date();
    } else if (status === 'completed') {
      client.workflowTracking.flowchartCompletedAt = new Date();
    }
    
    // Add timeline entry
    client.timeline.push({
      stage: client.stage,
      status: client.status,
      action: `Flowchart status updated to ${status}`,
      performedBy: req.user.id,
      notes: `Changed from ${previousStatus} to ${status}`
    });
    
    await client.save();
    await emitFlowchartStatusUpdate(client, req.user.id);
    
     if (client.stage === 'active') {
        await emitTargetedClientUpdate(
            client, 
            'workflow_updated', 
            req.user.id,
            { 
                stage: 'active',
                workflowStatus: status 
            }
        );
    }
    
    const responseTime = Date.now() - startTime;
    
    return res.status(200).json({
      success: true,
      message: "Flowchart status updated successfully",
      data: {
        clientId: client.clientId,
        flowchartStatus: client.workflowTracking.flowchartStatus,
        flowchartStartedAt: client.workflowTracking.flowchartStartedAt,
        flowchartCompletedAt: client.workflowTracking.flowchartCompletedAt
      },
      responseTime: `${responseTime}ms`,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error("Update flowchart status error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update flowchart status",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
};

// Update process flowchart status
const updateProcessFlowchartStatus = async (req, res) => {
  const startTime = Date.now();
  try {
    const { clientId } = req.params;
    const { status } = req.body;
    
    // Validate user is consultant or consultant_admin
    if (!['consultant', 'consultant_admin'].includes(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message: "Only consultants can update process flowchart status",
        timestamp: new Date().toISOString()
      });
    }
    
    // Validate status
    if (!['not_started', 'on_going', 'pending', 'completed'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status value. Must be one of: not_started, on_going, pending, completed",
        timestamp: new Date().toISOString()
      });
    }
    
    // Find client
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ 
        success: false,
        message: "Client not found",
        timestamp: new Date().toISOString()
      });
    }
    
    // Check if consultant is assigned to this client
    if (req.user.userType === 'consultant') {
      if (client.workflowTracking.assignedConsultantId?.toString() !== req.user.id &&
          client.leadInfo.assignedConsultantId?.toString() !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: "You are not assigned to this client",
          timestamp: new Date().toISOString()
        });
      }
    }
    
    // Update process flowchart status
    const previousStatus = client.workflowTracking.processFlowchartStatus;
    client.workflowTracking.processFlowchartStatus = status;
    
    // Set timestamps
    if (status === 'on_going' && previousStatus === 'not_started') {
      client.workflowTracking.processFlowchartStartedAt = new Date();
    } else if (status === 'completed') {
      client.workflowTracking.processFlowchartCompletedAt = new Date();
    }
    
    // Add timeline entry
    client.timeline.push({
      stage: client.stage,
      status: client.status,
      action: `Process flowchart status updated to ${status}`,
      performedBy: req.user.id,
      notes: `Changed from ${previousStatus} to ${status}`
    });
    
    await client.save();
    await emitFlowchartStatusUpdate(client, req.user.id);
    const responseTime = Date.now() - startTime;
    
    return res.status(200).json({
      success: true,
      message: "Process flowchart status updated successfully",
      data: {
        clientId: client.clientId,
        processFlowchartStatus: client.workflowTracking.processFlowchartStatus,
        processFlowchartStartedAt: client.workflowTracking.processFlowchartStartedAt,
        processFlowchartCompletedAt: client.workflowTracking.processFlowchartCompletedAt
      },
      responseTime: `${responseTime}ms`,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error("Update process flowchart status error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update process flowchart status",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
};

// Sync data input points from flowchart
const syncDataInputPoints = async (req, res) => {
  const startTime = Date.now();
  try {
    const { clientId } = req.params;
    if (!['consultant', 'consultant_admin'].includes(req.user.userType)) {
      return res.status(403).json({ success: false, message: "Only consultants can sync data input points", timestamp: new Date().toISOString() });
    }

    // Fetch client + active flowchart
    const [client, flowchart] = await Promise.all([
      Client.findOne({ clientId }),
      Flowchart.findOne({ clientId, isActive: true })
    ]);
    if (!client) return res.status(404).json({ success: false, message: "Client not found", timestamp: new Date().toISOString() });
    if (!flowchart) return res.status(404).json({ success: false, message: "Active flowchart not found. Please create a flowchart first.", timestamp: new Date().toISOString() });

    // Helper to merge points for a given type
    const mergePoints = (existing, nodes, inputType) => {
      // Build a map of existing by pointId
      const existingMap = new Map(existing.map(p => [p.pointId, p]));
      // Generate new list in flowchart order
      const newList = [];
      nodes.forEach(node => {
        if (node.details?.scopeDetails) {
          node.details.scopeDetails.forEach(scope => {
            if (scope.inputType.toLowerCase() === inputType) {
              const pointId = `${node.id}_${scope.scopeIdentifier}_${inputType}`;
              const base = {
                pointId,
                nodeId: node.id,
                scopeIdentifier: scope.scopeIdentifier,
                lastUpdatedBy: req.user.id,
                lastUpdatedAt: new Date()
              };
              // If existed, preserve all fields; otherwise create fresh
              if (existingMap.has(pointId)) {
                newList.push({ 
                  ...existingMap.get(pointId),
                  ...base,
                  // keep trainingCompletedFor, status, etc.
                });
              } else {
                // fresh entry defaults
                if (inputType === 'manual') {
                  newList.push({
                    ...base,
                    pointName: `${node.label} - ${scope.scopeName || scope.scopeIdentifier}`,
                    status: 'not_started'
                  });
                } else if (inputType === 'api') {
                  newList.push({
                    ...base,
                    endpoint: scope.apiEndpoint || '',
                    connectionStatus: scope.apiStatus ? 'connected' : 'not_connected',
                    status: 'not_started'
                  });
                } else { // iot
                  newList.push({
                    ...base,
                    deviceName: scope.iotDeviceName || `Device_${scope.scopeIdentifier}`,
                    deviceId: scope.iotDeviceId || '',
                    connectionStatus: scope.iotStatus ? 'connected' : 'not_connected',
                    status: 'not_started'
                  });
                }
              }
            }
          });
        }
      });
      return newList;
    };

        // Merge each type from BOTH charts depending on assessmentLevel
    const mergedNodes = await getMergedNodesForAssessment(clientId);

    client.workflowTracking.dataInputPoints.manual.inputs = mergePoints(
      client.workflowTracking.dataInputPoints.manual.inputs,
      mergedNodes,
      'manual'
    );
    client.workflowTracking.dataInputPoints.api.inputs = mergePoints(
      client.workflowTracking.dataInputPoints.api.inputs,
      mergedNodes,
      'api'
    );
    client.workflowTracking.dataInputPoints.iot.inputs = mergePoints(
      client.workflowTracking.dataInputPoints.iot.inputs,
      mergedNodes,
      'iot'
    );

    // Recalculate counts
    client.updateInputPointCounts('manual');
    client.updateInputPointCounts('api');
    client.updateInputPointCounts('iot');
    client.workflowTracking.dataInputPoints.lastSyncedWithFlowchart = new Date();

    // Timeline entry
    client.timeline.push({
      stage: client.stage,
      status: client.status,
      action: "Data input points synced from flowchart",
      performedBy: req.user.id,
      notes: `Manual: ${client.workflowTracking.dataInputPoints.manual.totalCount}, API: ${client.workflowTracking.dataInputPoints.api.totalCount}, IoT: ${client.workflowTracking.dataInputPoints.iot.totalCount}`
    });

    await client.save();

    const responseTime = Date.now() - startTime;
    return res.status(200).json({
      success: true,
      message: "Data input points synced successfully",
      data: {
        clientId: client.clientId,
        dataInputPoints: {
          manual: { total: client.workflowTracking.dataInputPoints.manual.totalCount, points: client.workflowTracking.dataInputPoints.manual.inputs },
          api:    { total: client.workflowTracking.dataInputPoints.api.totalCount,    points: client.workflowTracking.dataInputPoints.api.inputs },
          iot:    { total: client.workflowTracking.dataInputPoints.iot.totalCount,    points: client.workflowTracking.dataInputPoints.iot.inputs },
          totalDataPoints: client.workflowTracking.dataInputPoints.totalDataPoints,
          lastSyncedAt:    client.workflowTracking.dataInputPoints.lastSyncedWithFlowchart
        }
      },
      responseTime: `${responseTime}ms`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("Sync data input points error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to sync data input points",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
};
// Update manual input point status
const updateManualInputStatus = async (req, res) => {
  const startTime = Date.now();
  try {
    const { clientId, pointId } = req.params;
    const { status, trainingCompletedFor } = req.body;
    
    // Validate user
    if (!['consultant', 'consultant_admin'].includes(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message: "Only consultants can update input point status",
        timestamp: new Date().toISOString()
      });
    }
    
    // Validate status
    if (!['not_started', 'on_going', 'pending', 'completed'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status value. Must be one of: not_started, on_going, pending, completed",
        timestamp: new Date().toISOString()
      });
    }
    
    // Find client
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ 
        success: false,
        message: "Client not found",
        timestamp: new Date().toISOString()
      });
    }
    
    // Check permissions
    if (req.user.userType === 'consultant') {
      if (client.workflowTracking.assignedConsultantId?.toString() !== req.user.id &&
          client.leadInfo.assignedConsultantId?.toString() !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: "You are not assigned to this client",
          timestamp: new Date().toISOString()
        });
      }
    }
    
    // Find and update manual input point
    const inputIndex = client.workflowTracking.dataInputPoints.manual.inputs.findIndex(
      input => input.pointId === pointId
    );
    
    if (inputIndex === -1) {
      return res.status(404).json({ 
        success: false,
        message: "Manual input point not found",
        timestamp: new Date().toISOString()
      });
    }
    
    const previousStatus = client.workflowTracking.dataInputPoints.manual.inputs[inputIndex].status;
    
    // Update the input point
    client.workflowTracking.dataInputPoints.manual.inputs[inputIndex].status = status;
    client.workflowTracking.dataInputPoints.manual.inputs[inputIndex].lastUpdatedBy = req.user.id;
    client.workflowTracking.dataInputPoints.manual.inputs[inputIndex].lastUpdatedAt = new Date();
    
    if (trainingCompletedFor) {
      client.workflowTracking.dataInputPoints.manual.inputs[inputIndex].trainingCompletedFor = trainingCompletedFor;
    }
    
    // Update counts
    client.updateInputPointCounts('manual');
    
    // Add timeline entry
    client.timeline.push({
      stage: client.stage,
      status: client.status,
      action: `Manual input point ${pointId} status updated`,
      performedBy: req.user.id,
      notes: `Status changed from ${previousStatus} to ${status}${trainingCompletedFor ? `. Training completed for: ${trainingCompletedFor}` : ''}`
    });
    
    await client.save();
    await emitDataInputPointUpdate(client, 'manual', pointId, req.user.id);

    const responseTime = Date.now() - startTime;
    
    return res.status(200).json({
      success: true,
      message: "Manual input point status updated successfully",
      data: {
        pointId,
        status,
        trainingCompletedFor,
        counts: {
          total: client.workflowTracking.dataInputPoints.manual.totalCount,
          completed: client.workflowTracking.dataInputPoints.manual.completedCount,
          pending: client.workflowTracking.dataInputPoints.manual.pendingCount,
          onGoing: client.workflowTracking.dataInputPoints.manual.onGoingCount,
          notStarted: client.workflowTracking.dataInputPoints.manual.notStartedCount
        }
      },
      responseTime: `${responseTime}ms`,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error("Update manual input status error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update manual input status",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
};

// Update API input point status
const updateAPIInputStatus = async (req, res) => {
  const startTime = Date.now();
  try {
    const { clientId, pointId } = req.params;
    const { status, connectionStatus } = req.body;
    
    // Validate user
    if (!['consultant', 'consultant_admin'].includes(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message: "Only consultants can update input point status",
        timestamp: new Date().toISOString()
      });
    }
    
    // Validate status
    if (!['not_started', 'on_going', 'pending', 'completed'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status value. Must be one of: not_started, on_going, pending, completed",
        timestamp: new Date().toISOString()
      });
    }
    
    // Validate connection status if provided
    if (connectionStatus && !['not_connected', 'testing', 'connected', 'failed'].includes(connectionStatus)) {
      return res.status(400).json({
        success: false,
        message: "Invalid connection status. Must be one of: not_connected, testing, connected, failed",
        timestamp: new Date().toISOString()
      });
    }
    
    // Find client
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ 
        success: false,
        message: "Client not found",
        timestamp: new Date().toISOString()
      });
    }
    
    // Check permissions
    if (req.user.userType === 'consultant') {
      if (client.workflowTracking.assignedConsultantId?.toString() !== req.user.id &&
          client.leadInfo.assignedConsultantId?.toString() !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: "You are not assigned to this client",
          timestamp: new Date().toISOString()
        });
      }
    }
    
    // Find and update API input point
    const inputIndex = client.workflowTracking.dataInputPoints.api.inputs.findIndex(
      input => input.pointId === pointId
    );
    
    if (inputIndex === -1) {
      return res.status(404).json({ 
        success: false,
        message: "API input point not found",
        timestamp: new Date().toISOString()
      });
    }
    
    const previousStatus = client.workflowTracking.dataInputPoints.api.inputs[inputIndex].status;
    const previousConnectionStatus = client.workflowTracking.dataInputPoints.api.inputs[inputIndex].connectionStatus;
    
    // Update the input point
    client.workflowTracking.dataInputPoints.api.inputs[inputIndex].status = status;
    client.workflowTracking.dataInputPoints.api.inputs[inputIndex].lastUpdatedBy = req.user.id;
    client.workflowTracking.dataInputPoints.api.inputs[inputIndex].lastUpdatedAt = new Date();
    
    if (connectionStatus) {
      client.workflowTracking.dataInputPoints.api.inputs[inputIndex].connectionStatus = connectionStatus;
      if (connectionStatus === 'connected' || connectionStatus === 'testing') {
        client.workflowTracking.dataInputPoints.api.inputs[inputIndex].lastConnectionTest = new Date();
      }
    }
    
    // Update counts
    client.updateInputPointCounts('api');
    
    // Add timeline entry
    let notes = `Status changed from ${previousStatus} to ${status}`;
    if (connectionStatus && connectionStatus !== previousConnectionStatus) {
      notes += `. Connection status changed from ${previousConnectionStatus} to ${connectionStatus}`;
    }
    
    client.timeline.push({
      stage: client.stage,
      status: client.status,
      action: `API input point ${pointId} updated`,
      performedBy: req.user.id,
      notes
    });
    
    await client.save();
    await emitDataInputPointUpdate(client, 'api', pointId, req.user.id);

    const responseTime = Date.now() - startTime;
    
    return res.status(200).json({
      success: true,
      message: "API input point status updated successfully",
      data: {
        pointId,
        status,
        connectionStatus: client.workflowTracking.dataInputPoints.api.inputs[inputIndex].connectionStatus,
        lastConnectionTest: client.workflowTracking.dataInputPoints.api.inputs[inputIndex].lastConnectionTest,
        counts: {
          total: client.workflowTracking.dataInputPoints.api.totalCount,
          completed: client.workflowTracking.dataInputPoints.api.completedCount,
          pending: client.workflowTracking.dataInputPoints.api.pendingCount,
          onGoing: client.workflowTracking.dataInputPoints.api.onGoingCount,
          notStarted: client.workflowTracking.dataInputPoints.api.notStartedCount
        }
      },
      responseTime: `${responseTime}ms`,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error("Update API input status error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update API input status",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
};

// Update IoT input point status
const updateIoTInputStatus = async (req, res) => {
  const startTime = Date.now();
  try {
    const { clientId, pointId } = req.params;
    const { status, connectionStatus, deviceId } = req.body;
    
    // Validate user
    if (!['consultant', 'consultant_admin'].includes(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message: "Only consultants can update input point status",
        timestamp: new Date().toISOString()
      });
    }
    
    // Validate status
    if (!['not_started', 'on_going', 'pending', 'completed'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status value. Must be one of: not_started, on_going, pending, completed",
        timestamp: new Date().toISOString()
      });
    }
    
    // Validate connection status if provided
    if (connectionStatus && !['not_connected', 'configuring', 'connected', 'disconnected'].includes(connectionStatus)) {
      return res.status(400).json({
        success: false,
        message: "Invalid connection status. Must be one of: not_connected, configuring, connected, disconnected",
        timestamp: new Date().toISOString()
      });
    }
    
    // Find client
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ 
        success: false,
        message: "Client not found",
        timestamp: new Date().toISOString()
      });
    }
    
    // Check permissions
    if (req.user.userType === 'consultant') {
      if (client.workflowTracking.assignedConsultantId?.toString() !== req.user.id &&
          client.leadInfo.assignedConsultantId?.toString() !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: "You are not assigned to this client",
          timestamp: new Date().toISOString()
        });
      }
    }
    
    // Find and update IoT input point
    const inputIndex = client.workflowTracking.dataInputPoints.iot.inputs.findIndex(
      input => input.pointId === pointId
    );
    
    if (inputIndex === -1) {
      return res.status(404).json({ 
        success: false,
        message: "IoT input point not found",
        timestamp: new Date().toISOString()
      });
    }
    
    const previousStatus = client.workflowTracking.dataInputPoints.iot.inputs[inputIndex].status;
    const previousConnectionStatus = client.workflowTracking.dataInputPoints.iot.inputs[inputIndex].connectionStatus;
    const previousDeviceId = client.workflowTracking.dataInputPoints.iot.inputs[inputIndex].deviceId;
    
    // Update the input point
    client.workflowTracking.dataInputPoints.iot.inputs[inputIndex].status = status;
    client.workflowTracking.dataInputPoints.iot.inputs[inputIndex].lastUpdatedBy = req.user.id;
    client.workflowTracking.dataInputPoints.iot.inputs[inputIndex].lastUpdatedAt = new Date();
    
    if (connectionStatus) {
      client.workflowTracking.dataInputPoints.iot.inputs[inputIndex].connectionStatus = connectionStatus;
      if (connectionStatus === 'connected') {
        client.workflowTracking.dataInputPoints.iot.inputs[inputIndex].lastDataReceived = new Date();
      }
    }
    
    if (deviceId) {
      client.workflowTracking.dataInputPoints.iot.inputs[inputIndex].deviceId = deviceId;
    }
    
    // Update counts
    client.updateInputPointCounts('iot');
    
    // Build timeline notes
    let notes = `Status changed from ${previousStatus} to ${status}`;
    if (connectionStatus && connectionStatus !== previousConnectionStatus) {
      notes += `. Connection status changed from ${previousConnectionStatus} to ${connectionStatus}`;
    }
    if (deviceId && deviceId !== previousDeviceId) {
      notes += `. Device ID ${previousDeviceId ? 'updated' : 'set'} to ${deviceId}`;
    }
    
    // Add timeline entry
    client.timeline.push({
      stage: client.stage,
      status: client.status,
      action: `IoT input point ${pointId} updated`,
      performedBy: req.user.id,
      notes
    });
    
    await client.save();
    await emitDataInputPointUpdate(client, 'iot', pointId, req.user.id);

    const responseTime = Date.now() - startTime;
    
    return res.status(200).json({
      success: true,
      message: "IoT input point status updated successfully",
      data: {
        pointId,
        status,
        connectionStatus: client.workflowTracking.dataInputPoints.iot.inputs[inputIndex].connectionStatus,
        deviceId: client.workflowTracking.dataInputPoints.iot.inputs[inputIndex].deviceId,
        lastDataReceived: client.workflowTracking.dataInputPoints.iot.inputs[inputIndex].lastDataReceived,
        counts: {
          total: client.workflowTracking.dataInputPoints.iot.totalCount,
          completed: client.workflowTracking.dataInputPoints.iot.completedCount,
          pending: client.workflowTracking.dataInputPoints.iot.pendingCount,
          onGoing: client.workflowTracking.dataInputPoints.iot.onGoingCount,
          notStarted: client.workflowTracking.dataInputPoints.iot.notStartedCount
        }
      },
      responseTime: `${responseTime}ms`,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error("Update IoT input status error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update IoT input status",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
};






// ====================================
// Helper function for pagination with caching
const getPaginationOptions = (req) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
  const skip = (page - 1) * limit;
  
  const search = req.query.search?.trim() || '';
  const stage = req.query.stage || '';
  const status = req.query.status || '';
  const sortBy = req.query.sortBy || 'createdAt';
  const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
  
  return { 
    page, 
    limit, 
    skip, 
    search, 
    stage, 
    status, 
    sortBy, 
    sortOrder 
  };
};

// Enhanced response formatter
const formatPaginatedResponse = (data, total, options) => {
  const { page, limit } = options;
  const totalPages = Math.ceil(total / limit);
  
  return {
    success: true,
    data,
    pagination: {
      currentPage: page,
      totalPages,
      totalItems: total,
      itemsPerPage: limit,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    },
    timestamp: new Date().toISOString()
  };
};
// Create Lead (Stage 1)
// Create Lead (Stage 1)
const createLead = async (req, res) => {
    const startTime = Date.now();
  try {
    // Only consultant_admin can create leads
    if (!req.user || req.user.userType !== "consultant_admin") {
      return res.status(403).json({
        message: "Only Consultant Admins can create leads"
      });
    }

    const {
      companyName,
      contactPersonName,
      email,
      mobileNumber,
      leadSource,
      notes,
      assignedConsultantId,
      salesPersonName,
      salesPersonEmployeeId,
      referenceName,
      referenceContactNumber,
      eventName,
      eventPlace,
    } = req.body;
    // Validate required fields
    const requiredFields = { companyName, contactPersonName, email, mobileNumber };
    const missingFields = Object.entries(requiredFields)
      .filter(([_, value]) => !value)
      .map(([key]) => key);

    //Conditional Validation 
    if(leadSource === 'sales Team'){
      if(!salesPersonName || !salesPersonEmployeeId) missingFields.push("salesPersonName or salesPersonEmployeeId")
    }
    if(leadSource === 'reference'){
      if (!referenceName || !referenceContactNumber) missingFields.push("referenceName or referenceContactNumber")
    }
    if(leadSource === 'event'){
      if(!eventName || !eventPlace) missingFields.push("eventName or eventDate ")
    }
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missingFields.join(', ')}`,
        timestamp: new Date().toISOString()
      });
    }
    // Check if lead already exists by email
    const existingLead = await Client.findOne({
      "leadInfo.email": email
    });
    if (existingLead) {
      return res.status(409).json({
        success: false,
        message: "A lead with this email already exists",
        clientId: existingLead.clientId,
        timestamp: new Date().toISOString()
      });
    }

    // Generate a new Client ID
    const clientId = await Client.generateClientId();

    // Create the new lead
    const newClient = new Client({
      clientId,
      stage: "lead",
      status: "contacted",
      leadInfo: {
        companyName,
        contactPersonName,
        email,
        mobileNumber,
        leadSource,
        salesPersonName: leadSource === 'sales Team' ? salesPersonName : undefined,
        salesPersonEmployeeId: leadSource === 'sales Team' ? salesPersonEmployeeId : undefined,
        referenceName: leadSource === 'reference' ? referenceName : undefined,
        referenceContactNumber : leadSource === "reference" ? referenceContactNumber : undefined,
        eventName: leadSource === 'event' ? eventName : undefined,
        eventPlace: leadSource === 'event' ? eventPlace : undefined,
        notes,
        consultantAdminId: req.user.id,
        assignedConsultantId: assignedConsultantId || null,
        createdBy: req.user.id // ← store who created
        // createdAt is auto‐populated by schema default
      },
      timeline: [{
        stage: "lead",
        status: "contacted",
        action: "Lead created",
        performedBy: req.user.id,
        notes: `Lead created by ${req.user.userName}`
      }]
    });

    await newClient.save();
    await emitNewClientCreated(newClient, req.user.id);
    await emitClientListUpdate(newClient, 'created', req.user.id);
      try {
       sendLeadCreatedEmail(newClient, req.user.userName);
      console.log(`✉️  Lead creation email queued for super admin (${process.env.SUPER_ADMIN_EMAIL})`);
    } catch (mailErr) {
      console.error("⚠️  Could not send lead-created email:", mailErr);
    }


     // 1) Try sending the “lead created” notification, but don’t let it throw.
    try {
       createLeadActionNotification('created', newClient, req.user);
    } catch (notifErr) {
      console.error("Warning: could not enqueue lead notification:", notifErr);
      // (You can choose to swallow this completely or log it somewhere else.)
    }

    // 2) If there’s an assigned consultant, wrap that in its own try block too:
    if (assignedConsultantId) {
      // ── a) In‐app “assign” notification ───────────────────────────────────
      try {
        const consultant = await User.findById(assignedConsultantId).select('email userName');
        if (consultant) {
          // If createConsultantAssignmentNotification is async, await it
           createConsultantAssignmentNotification(consultant, newClient, req.user);
        }
      } catch (assignNotifErr) {
        console.error("Warning: could not enqueue consultant‐assignment notification:", assignNotifErr);
      }

      // ── b) Email the consultant ───────────────────────────────────────────
      try {
        // It’s often simpler to re‐fetch only email/userName via .lean(), but
        // since we already did findById above (with select), you can reuse it:
        const consultantUser = await User
          .findById(assignedConsultantId)
          .select('email userName')
          .lean();

        if (consultantUser && consultantUser.email) {
           sendConsultantAssignedEmail(
            consultantUser,
            newClient,
            req.user.userName
          );
          console.log(`✉️ Consultant assignment email sent to ${consultantUser.email}`);
        }
      } catch (assignEmailErr) {
        console.error("⚠️ Could not send consultant-assigned email:", assignEmailErr);
      }
    }


    const responseTime = Date.now() - startTime;

 return res.status(201).json({
      success: true,
      message: "Lead created successfully",
      data: {
        clientId: newClient.clientId,
        stage: newClient.stage,
        status: newClient.status,
        leadInfo: newClient.leadInfo
      },
      responseTime: `${responseTime}ms`,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error("Create lead error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create lead",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
};


/**
 * Update a Lead's basic "leadInfo" fields.
 * – Only a consultant_admin can call this.
 * – Only allowed when client.stage === "lead".
 * – Once moved to "registered" (data submission), it can no longer be edited.
 */
const updateLead = async (req, res) => {
  try {
    const { clientId } = req.params;
    const updateData = req.body;

    // 1) Only consultant_admin may update
    if (!req.user || req.user.userType !== "consultant_admin") {
      return res.status(403).json({
        message: "Only Consultant Admins can update leads"
      });
    }

    // 2) Find the lead (client) by clientId
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    // 3) Ensure the caller is the same consultant_admin who created this lead
    if (client.leadInfo.createdBy.toString() !== req.user.id) {
      return res.status(403).json({
        message: "You can only update leads you created"
      });
    }

    // 4) Ensure it is still in "lead" stage
    if (client.stage !== "lead") {
      return res.status(400).json({
        message: "Cannot edit a lead after it has moved to data submission"
      });
    }

    // 5) Request must wrap everything under `leadInfo`
    if (!updateData.leadInfo || typeof updateData.leadInfo !== "object") {
      return res.status(400).json({
        message: "Payload must contain a 'leadInfo' object"
      });
    }

    // 6) Allowed fields (under leadInfo) to update
    const allowedFields = [
      "companyName",
      "contactPersonName",
      "email",
      "mobileNumber",
      "leadSource",
      "notes",
      "assignedConsultantId",
      "salesPersonName",
      "salesPersonEmployeeId",
      "referenceName",
      "referenceContactNumber",
      "eventName",
      "eventPlace"
    ];

    // 7) Apply only those subfields if present
    allowedFields.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(updateData.leadInfo, field)) {
        client.leadInfo[field] = updateData.leadInfo[field];
      }
    });

    //8) Now enforce mutual exclusivity and auto-switching 
      //helper 
      const li = client.leadInfo;


     if (updateData.leadInfo.leadSource) {
      //user explicitly set leadSource
      const src = updateData.leadInfo.leadSource;
      if (src !== 'sales Team') {
        li.salesPersonName = undefined;
        li.salesPersonEmployeeId = undefined;
      }
      if (src !== 'reference') {
        li.referenceName = undefined;
        li.referenceContactNumber = undefined;
      }
      if (src !== 'event') {
        li.eventName = undefined;
        li.eventPlace = undefined;
      }
      else if (updateData.leadInfo.salesPersonName || updateData.leadInfo.salesPersonEmployeeId) {
        //user is updating sales fields -> promote to sales Team
        li.leadSource = 'sales Team';
        li.referenceName = undefined;
        li.referenceContactNumber = undefined;
        li.eventName = undefined;
        li.eventPlace = undefined;
      } else if (updateData.leadInfo.referenceName || updateData.leadInfo.referenceContactNumber) {
        //user is updating reference fields -> promote to reference
        li.leadSource = 'reference';
        li.salesPersonName = undefined;
        li.salesPersonEmployeeId = undefined;
        li.eventName = undefined;
        li.eventPlace = undefined;
      }
      else if (updateData.leadInfo.eventName || updateData.leadInfo.eventPlace) {
        //user is updating event fields -> promote to event
        li.leadSource = 'event';
        li.salesPersonName = undefined;
        li.salesPersonEmployeeId = undefined;
        li.referenceName = undefined;
        li.referenceContactNumber = undefined;
      }
    }
    // 8) If assignedConsultantId changed, notify that consultant
    if (updateData.leadInfo.assignedConsultantId && 
        updateData.leadInfo.assignedConsultantId !== client.leadInfo.assignedConsultantId?.toString()) {
      const newConsId = updateData.leadInfo.assignedConsultantId;
      const consultant = await User.findById(newConsId);
      if (consultant) {
        try {
          await createConsultantAssignmentNotification(consultant, client, req.user);
          
          // Send email notification
          await sendConsultantAssignedEmail(
            consultant,
            client,
            req.user.userName
          );
          console.log(`✉️ Consultant assignment email sent to ${consultant.email}`);
        } catch (notifErr) {
          console.error("Warning: could not send consultant assignment notifications:", notifErr);
          // Continue with the update even if notifications fail
        }
      }
    }

    // 9) Add timeline entry
    client.timeline.push({
      stage: client.stage,
      status: client.status,
      action: "Lead information updated",
      performedBy: req.user.id,
      notes: `Updated by ${req.user.userName}`
    });

    // 10) Save changes
    await client.save();

    // ADD THIS: Emit real-time update
    await emitClientListUpdate(client, 'updated', req.user.id);

    return res.status(200).json({
      message: "Lead updated successfully",
      lead: {
        clientId: client.clientId,
        stage: client.stage,
        status: client.status,
        leadInfo: client.leadInfo
      }
    });
  } catch (err) {
    console.error("Update lead error:", err);
    return res.status(500).json({
      message: "Failed to update lead",
      error: err.message
    });
  }
};


/**
 * Delete a lead (soft delete) **only** if:
 * 1) The lead’s stage is still "lead"
 * 2) The lead was created ≤ 3 days ago
 * 3) A reason is provided in the request body
 *
 * Upon deletion:
 * ‣ Soft-delete the client document (isDeleted = true, deletedAt, deletedBy, store reason)
 * ‣ Send a high-priority notification + email to the super_admin with the reason
 */
const deleteLead = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { reason } = req.body;

    // A) Only consultant_admin may delete
    if (!req.user || req.user.userType !== "consultant_admin") {
      return res.status(403).json({
        message: "Only Consultant Admins can delete leads"
      });
    }

    // B) Find the client record
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    // C) Only the same consultant_admin who created the lead
    if (client.leadInfo.createdBy.toString() !== req.user.id) {
      return res.status(403).json({
        message: "You can only delete leads you created"
      });
    }

    // D) Only delete if still in "lead" stage
    if (client.stage !== "lead") {
      return res.status(400).json({
        message: "Cannot delete: this lead has already advanced beyond 'lead' stage"
      });
    }

    // E) Enforce 3-day window since creation
    const createdAt = client.leadInfo.createdAt;
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    if (createdAt < threeDaysAgo) {
      return res.status(400).json({
        message: "Cannot delete lead: more than 3 days have elapsed since creation"
      });
    }

    // F) Validate deletion reason (min length 5)
    if (!reason || reason.length < 5) {
      return res.status(400).json({
        message: "Please provide a reason (minimum 5 characters)"
      });
    }

    // G) Soft‐delete / archive the lead
    client.isDeleted = true;
    client.deletedAt = new Date();
    client.leadInfo.deletionReason = reason;
    client.deletedBy = req.user.id;

    // → Update accountDetails with valid status
    // Instead of "deactivated", use "suspended" or another valid enum value
    client.accountDetails.isActive = false;
    // Only set subscriptionStatus if it exists and client is in active stage
    if (client.stage === "active" && client.accountDetails.subscriptionStatus) {
      client.accountDetails.subscriptionStatus = "suspended"; // Use a valid enum value
    }

    await client.save();

    // ADD THIS: Emit real-time update
    await emitClientListUpdate(client, 'deleted', req.user.id);

    // H) Notify super_admin: create Notification + email
    const superAdmin = await User.findOne({
      userType: "super_admin",
      isActive: true
    });
    
    if (superAdmin) {
      // a) Try to save a Notification (wrap in try-catch to handle Redis errors)
      try {
        const notif = new Notification({
          title: `Lead Deleted: ${clientId}`,
          message: `
${req.user.userName} (${req.user.userType}) deleted lead ${clientId}.
Reason: ${reason}

Lead Details:
• Company: ${client.leadInfo.companyName}
• Contact Person: ${client.leadInfo.contactPersonName}
• Email: ${client.leadInfo.email}
• Mobile: ${client.leadInfo.mobileNumber}
Deleted On: ${client.deletedAt.toLocaleString()}
          `.trim(),
          priority: "high",
          createdBy: req.user.id,
          creatorType: req.user.userType,
          targetUsers: [superAdmin._id],
          status: "published",
          publishedAt: new Date(),
          isSystemNotification: true,
          systemAction: "lead_deleted",
          relatedEntity: {
            type: "client",
            id: client._id
          }
        });
        await notif.save();
        
        // Broadcast notification if global.io exists
        if (global.io && global.broadcastNotification) {
          try {
            await global.broadcastNotification(notif);
          } catch (broadcastErr) {
            console.error("Warning: could not broadcast notification:", broadcastErr);
          }
        }
      } catch (notifErr) {
        console.error("Warning: could not create notification:", notifErr);
        // Continue with the deletion even if notification fails
      }

      // b) Send email to super_admin (wrap in try-catch)
      try {
        const adminSubject = `ZeroCarbon – Lead Deleted: ${clientId}`;
        const adminMessage = `
Dear ${superAdmin.userName},

${req.user.userName} (${req.user.userType}) has deleted lead ${clientId}.
Reason: ${reason}

Lead Details:
• Company: ${client.leadInfo.companyName}
• Contact Person: ${client.leadInfo.contactPersonName}
• Email: ${client.leadInfo.email}
• Mobile: ${client.leadInfo.mobileNumber}
Deleted On: ${client.deletedAt.toLocaleString()}

Please check the system for more details.

Best regards,
ZeroCarbon System
        `.trim();

        await sendMail(superAdmin.email, adminSubject, adminMessage);
      } catch (emailErr) {
        console.error("Warning: could not send email to super admin:", emailErr);
        // Continue with the deletion even if email fails
      }
    }

    // I) Respond
    return res.status(200).json({
      message: `Lead ${clientId} deleted successfully`,
      deletedLead: {
        clientId: client.clientId,
        deletedAt: client.deletedAt,
        deletedBy: req.user.id,
        reason
      }
    });

  } catch (err) {
    console.error("Delete lead error:", err);
    return res.status(500).json({
      message: "Failed to delete lead",
      error: err.message
    });
  }
};


// ─── Get Leads (Consultant Admin only) ──────────────────────────────────────────
const getLeads = async (req, res) => {
  try {
    // Only consultant_admin can fetch "their" leads
    if (req.user.userType !== "consultant_admin") {
      return res.status(403).json({
        message: "You don't have permission to view leads",
      });
    }
    
    const paginationParams = getPaginationOptions(req);
    const { page, limit, skip, search, stage, status, sortBy, sortOrder } = paginationParams;

    // Build query
    let query = {
      "leadInfo.consultantAdminId": req.user.id,
      "isDeleted": false,
    };

    // Add search filter if provided
    if (search) {
      query.$or = [
        { "leadInfo.companyName": { $regex: search, $options: 'i' } },
        { "leadInfo.contactPersonName": { $regex: search, $options: 'i' } },
        { "leadInfo.email": { $regex: search, $options: 'i' } },
        { "leadInfo.mobileNumber": { $regex: search, $options: 'i' } }
      ];
    }

    // Add stage filter if provided
    if (stage) {
      query.stage = stage;
    }

    // Add status filter if provided
    if (status) {
      query.status = status;
    }

    // Get total count for pagination
    const totalLeads = await Client.countDocuments(query);

    // Find all clients with pagination
    const leads = await Client.find(query)
      .select("clientId stage status leadInfo.companyName leadInfo.contactPersonName leadInfo.email leadInfo.mobileNumber leadInfo.leadSource leadInfo.createdAt")
      .sort({ [sortBy]: sortOrder })
      .skip(skip)
      .limit(limit)
      .lean();

    // Use the formatPaginatedResponse helper
    return res.status(200).json(
      formatPaginatedResponse(leads, totalLeads, paginationParams)
    );
    
  } catch (error) {
    console.error("Get leads error:", error);
    return res.status(500).json({
      message: "Failed to fetch leads",
      error: error.message
    });
  }
};

// Update Lead to Data Submission Stage (Stage 2)
const moveToDataSubmission = async (req, res) => {
  try {
    const { clientId } = req.params;

    // A) Only consultant_admin can perform this
    if (req.user.userType !== "consultant_admin") {
      return res.status(403).json({
        message: "Only Consultant Admins can move leads to data submission",
      });
    }

    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    // B) Only the consultant_admin who originally created the lead may move it
    if (client.leadInfo.createdBy.toString() !== req.user.id) {
      return res.status(403).json({
        message: "Only the Consultant Admin who created this lead can move it to data submission",
      });
    }

    if (client.stage !== "lead") {
      return res.status(400).json({
        message: "Client is not in lead stage",
      });
    }

    // Store the previous stage BEFORE updating it
    const previousStage = client.stage;

    // C) Update stage and status
    client.stage = "registered";
    client.status = "pending";
    client.timeline.push({
      stage: "registered",
      status: "pending",
      action: "Moved to data submission",
      performedBy: req.user.id,
      notes: "Client moved to data submission stage",
    });

    await client.save();
    
    // ADD THIS: Emit real-time updates
    await emitClientStageChange(client, previousStage, req.user.id);
    await emitClientListUpdate(client, 'stage_changed', req.user.id);

    // D) Send email to client
    const emailSubject = "ZeroCarbon - Please Submit Your Company Data";
    const emailMessage = `
      Dear ${client.leadInfo.contactPersonName},

      Thank you for your interest in ZeroCarbon services.

      To proceed with your carbon footprint assessment, we need some additional information about your company.

      Your Client ID: ${clientId}

      Our consultant will contact you shortly to guide you through the data submission process.

      Best regards,
      ZeroCarbon Team
    `;

    await sendMail(client.leadInfo.email, emailSubject, emailMessage);

    // E) CREATE NOTIFICATION for Super Admin and related users
    await createDataSubmissionNotification(client, req.user);


    return res.status(200).json({
      message: "Client moved to data submission stage",
      client: {
        clientId: client.clientId,
        stage: client.stage,
        status: client.status,
      },
    });
  } catch (error) {
    console.error("Move to data submission error:", error);
    return res.status(500).json({
      message: "Failed to update client stage",
      error: error.message,
    });
  }
};




// Submit Client Data (Stage 2)
const submitClientData = async (req, res) => {
  try {
    const { clientId } = req.params;
    const submissionData = req.body;
    
    // Check permissions
    if (!["consultant_admin", "consultant"].includes(req.user.userType)) {
      return res.status(403).json({ 
        message: "Only Consultants can submit client data" 
      });
    }
    
    const client = await Client.findOne({ clientId });
    
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }
    
    if (client.stage !== "registered") {
      return res.status(400).json({ 
        message: "Client is not in data submission stage" 
      });
    }
      // ─── EMAIL VALIDATION ──────────────────────────────────────────────────
    // Extract emails from both sources
    const primaryContactEmail = submissionData?.companyInfo?.primaryContactPerson?.email;
    const leadInfoEmail = client.leadInfo?.email;
    
    // Collect emails to check (remove duplicates and empty values)
    const emailsToCheck = [...new Set([primaryContactEmail, leadInfoEmail].filter(Boolean))];
    
    if (emailsToCheck.length > 0) {
      // Check if any of these emails already exist in User database
      const existingUsers = await User.find({
        email: { $in: emailsToCheck }
      }).select('email userType clientId');
      
      if (existingUsers.length > 0) {
        // Build detailed error message
        const conflictDetails = existingUsers.map(user => ({
          email: user.email,
          userType: user.userType,
          clientId: user.clientId
        }));
        
        return res.status(409).json({
          message: "Email address already exists in user database",
          conflictingEmails: conflictDetails,
          details: "The following email(s) are already registered with existing users. Please use different email addresses or contact system administrator."
        });
      }
    }
    // ─── END EMAIL VALIDATION ──────────────────────────────────────────────
          // --- NORMALIZE & VALIDATE assessmentLevel + conditional sections ---
      const inbound = req.body?.submissionData || {};
      const normalizedLevels = normalizeAssessmentLevels(inbound.assessmentLevel);

      if (normalizedLevels.length === 0) {
        return res.status(400).json({ message: "assessmentLevel is required (allowed: reduction, decarbonization, organization, process)" });
      }

      // Ensure we validate what will be saved
      const submissionPreview = { ...inbound, assessmentLevel: normalizedLevels };
      const { errors } = validateSubmissionForLevels(submissionPreview, normalizedLevels);

      if (errors.length) {
        return res.status(400).json({ message: "Validation error", errors });
      }
    // Update submission data
   client.submissionData = {
  ...inbound,
  assessmentLevel: normalizedLevels,
  submittedAt: new Date(),
  submittedBy: req.user.id
};  
    
    client.status = "submitted";
    client.timeline.push({
      stage: "registered",
      status: "submitted",
      action: "Data submitted",
      performedBy: req.user.id,
      notes: "Client data submission completed"
    });
    
    await client.save();

    try {
      const html = renderClientDataHTML(client);
      const pdf = await htmlToPdfBuffer(html, `ZeroCarbon_ClientData_${client.clientId}.pdf`);
      await sendClientDataSubmittedEmail(client, [pdf]);
      console.log('✉️ Client data submitted email sent with PDF.');
    } catch (e) {
      console.error('Email/PDF (submitClientData) error:', e.message);
    }
    
    res.status(200).json({
      message: "Client data submitted successfully",
      client: {
        clientId: client.clientId,
        stage: client.stage,
        status: client.status
      }
    });
    
  } catch (error) {
    console.error("Submit client data error:", error);
    res.status(500).json({ 
      message: "Failed to submit client data", 
      error: error.message 
    });
  }
};

// ─── Update Client Submission Data (Consultant Admin only, creator-only, pre-activation) ──────────────────────────────────────────
// ─── Update Client Submission Data (Consultant Admin only, creator-only, pre-activation) ──────────────────────────────────────────
const updateClientData = async (req, res) => {
  try {
    const { clientId } = req.params;

    // A) Find the client record
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    // B) Must be in "registered" stage and not yet active
    if (client.stage !== "registered" || client.status === "active") {
      return res.status(400).json({
        message:
          "Cannot update: client is either not in registration stage or is already active",
      });
    }

    // C) Only the Consultant Admin who created the lead or the assigned consultant may update
    const creatorId = client.leadInfo.createdBy?.toString();
    const assignedConsultantId = client.leadInfo.assignedConsultantId?.toString();
    if (req.user.id !== creatorId && req.user.id !== assignedConsultantId) {
      return res.status(403).json({
        message:
          "You can only update submission data if you created this client or are the assigned consultant",
      });
    }

    // D) Extract payload (REQUIRED)
    const payload = req.body?.submissionData;
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({
        message: "Request must contain a 'submissionData' object",
      });
    }

    // E) Helpers for unified emissions-profile details + deep merge
    const SCOPE1_KEYS = [
      "stationaryCombustion",
      "mobileCombustion",
      "processEmissions",
      "fugitiveEmissions",
    ];
    const SCOPE2_KEYS = ["purchasedElectricity", "purchasedSteamHeating"];
    const SCOPE3_KEYS = [
      "businessTravel",
      "employeeCommuting",
      "wasteGenerated",
      "upstreamTransportation",
      "downstreamTransportation",
      "purchasedGoodsAndServices",
      "capitalGoods",
      "fuelAndEnergyRelated",
      "upstreamLeasedAssets",
      "downstreamLeasedAssets",
      "processingOfSoldProducts",
      "useOfSoldProducts",
      "endOfLifeTreatment",
      "franchises",
      "investments",
    ];

    const mergeDetails = (existing = {}, incoming = {}) => ({
      name: incoming.name ?? existing.name ?? "",
      description: incoming.description ?? existing.description ?? "",
      otherDetails: incoming.otherDetails ?? existing.otherDetails ?? "",
    });

    const normalizeLocal = (levels) => {
      if (!levels) return [];
      const arr = Array.isArray(levels) ? levels : [levels];
      return Array.from(
        new Set(
          arr
            .map((s) => String(s || "").trim().toLowerCase())
            .filter(Boolean)
            .map((s) => (s === "organisation" ? "organization" : s))
        )
      );
    };

    const validateLocal =
      typeof validateSubmissionForLevels === "function"
        ? validateSubmissionForLevels
        : () => ({ errors: [] });

    // F) Build a "next state" (plain object) to validate before writing to the doc
    const current =
      client.submissionData?.toObject?.() ??
      JSON.parse(JSON.stringify(client.submissionData || {}));
    const next = { ...current };

    // Generic shallow merge for non-emissionsProfile keys
    Object.keys(payload).forEach((key) => {
      if (key !== "emissionsProfile") {
        const prevVal =
          next[key] && typeof next[key] === "object" ? next[key] : {};
        const incVal =
          payload[key] && typeof payload[key] === "object" ? payload[key] : payload[key];
        next[key] =
          typeof incVal === "object" && !Array.isArray(incVal)
            ? { ...prevVal, ...incVal }
            : incVal;
      }
    });

    // Specialized deep merge for emissionsProfile (unified details shape)
    if (payload.emissionsProfile) {
      next.emissionsProfile = next.emissionsProfile || {};

      // Scope 1
      const incS1 = payload.emissionsProfile.scope1 || {};
      next.emissionsProfile.scope1 = next.emissionsProfile.scope1 || {};
      SCOPE1_KEYS.forEach((k) => {
        const prev = next.emissionsProfile.scope1[k] || {
          included: false,
          details: {},
        };
        const inc = incS1[k] || {};
        next.emissionsProfile.scope1[k] = {
          included:
            typeof inc.included === "boolean" ? inc.included : prev.included ?? false,
          details: mergeDetails(prev.details, inc.details),
        };
      });

      // Scope 2
      const incS2 = payload.emissionsProfile.scope2 || {};
      next.emissionsProfile.scope2 = next.emissionsProfile.scope2 || {};
      SCOPE2_KEYS.forEach((k) => {
        const prev = next.emissionsProfile.scope2[k] || {
          included: false,
          details: {},
        };
        const inc = incS2[k] || {};
        next.emissionsProfile.scope2[k] = {
          included:
            typeof inc.included === "boolean" ? inc.included : prev.included ?? false,
          details: mergeDetails(prev.details, inc.details),
        };
      });

      // Scope 3
      const incS3 = payload.emissionsProfile.scope3 || {};
      const prevS3 = next.emissionsProfile.scope3 || {};
      next.emissionsProfile.scope3 = {
        includeScope3:
          typeof incS3.includeScope3 === "boolean"
            ? incS3.includeScope3
            : prevS3.includeScope3 ?? false,
        categories: {
          ...(prevS3.categories || {}),
          ...(incS3.categories || {}),
        },
        categoriesDetails: {},
        otherIndirectSources:
          incS3.otherIndirectSources ?? prevS3.otherIndirectSources ?? "",
      };

      const prevCD = prevS3.categoriesDetails || {};
      const incCD = incS3.categoriesDetails || {};
      SCOPE3_KEYS.forEach((k) => {
        const prev = (prevCD[k] && prevCD[k].details) || {};
        const inc = (incCD[k] && incCD[k].details) || {};
        next.emissionsProfile.scope3.categoriesDetails[k] = {
          details: mergeDetails(prev, inc),
        };
      });
    }

    // G) Normalize & validate assessmentLevel on the next state
    const prevAssessmentLevel = client.submissionData?.assessmentLevel || null;
    const normalizedLevels =
      typeof normalizeAssessmentLevels === "function"
        ? normalizeAssessmentLevels(next.assessmentLevel)
        : normalizeLocal(next.assessmentLevel);

    next.assessmentLevel = normalizedLevels.length ? normalizedLevels : [];

    const { errors } = validateLocal(next, normalizedLevels);
    if (errors.length) {
      return res.status(400).json({ message: "Validation error", errors });
    }

    // H) Write back "next" into the real document
    client.submissionData = next; // safe: subdoc assignment; mongoose will cast
    client.submissionData.updatedAt = new Date();

    // I) Update workflow if assessmentLevel changed
    const newAssessmentLevel = client.submissionData.assessmentLevel;
    const changed =
      JSON.stringify(newAssessmentLevel) !== JSON.stringify(prevAssessmentLevel);

    if (changed && typeof client.updateWorkflowBasedOnAssessment === "function") {
      client.updateWorkflowBasedOnAssessment();

      client.timeline = client.timeline || [];
      client.timeline.push({
        stage: "registered",
        status: "updated",
        action: "Workflow updated based on assessment level",
        performedBy: req.user.id,
        notes: `Assessment level changed from '${Array.isArray(prevAssessmentLevel) ? prevAssessmentLevel.join(", ") : prevAssessmentLevel || "none"}' to '${Array.isArray(newAssessmentLevel) ? newAssessmentLevel.join(", ") : newAssessmentLevel}'. Workflow tracking updated accordingly.`,
      });
    }

    await client.save();

    // J) Emits
    await emitClientListUpdate(client, "updated", req.user.id);

    if (client.stage === "registered") {
      await emitTargetedClientUpdate(client, "data_submission_updated", req.user.id, {
        stage: "registered",
        hasDataSubmission: true,
        dataCompleteness:
          typeof client.calculateDataCompleteness === "function"
            ? client.calculateDataCompleteness()
            : undefined,
      });
    }

    // K) Email / PDF (best-effort)
    try {
      const html = renderClientDataHTML(client);
      const pdf = await htmlToPdfBuffer(
        html,
        `ZeroCarbon_ClientData_${client.clientId}.pdf`
      );
      await sendClientDataUpdatedEmail(client, [pdf]);
      console.log("✉️ Client data updated email sent with PDF.");
    } catch (e) {
      console.error("Email/PDF (updateClientData) error:", e.message);
    }

    return res.status(200).json({
      message: "Client submission data updated successfully",
      client: {
        clientId: client.clientId,
        stage: client.stage,
        status: client.status,
      },
    });
  } catch (error) {
    console.error("Update client data error:", error);
    return res.status(500).json({
      message: "Failed to update client data",
      error: error.message,
    });
  }
};




// ─── Delete Client Submission Data (Consultant Admin only, creator-only, pre-activation) ──────────────────────────────────────────
const deleteClientData = async (req, res) => {
  try {
    const { clientId } = req.params;

    // A) Only consultant_admin may delete
    if (!req.user || req.user.userType !== "consultant_admin") {
      return res.status(403).json({
        message: "Only Consultant Admins can delete submission data",
      });
    }

    // B) Find the client record
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    // C) Must be in “registered” stage and not yet active
    if (client.stage !== "registered" || client.status === "active") {
      return res.status(400).json({
        message:
          "Cannot delete: client is either not in registration stage or is already active",
      });
    }

    // D) Only the Consultant Admin who originally created the lead may delete submission data
    const creatorId = client.leadInfo.createdBy?.toString();
    if (req.user.id !== creatorId) {
      return res.status(403).json({
        message:
          "You can only delete submission data if you originally created this client",
      });
    }

    // E) Reset submissionData to an “empty” skeleton instead of undefined
    client.submissionData = {
      // 1) companyInfo defaults
      companyInfo: {
        companyName: "",
        companyAddress: "",
        primaryContactPerson: {
          name: "",
          designation: "",
          email: "",
          phoneNumber: ""
        },
        alternateContactPerson: {
          name: "",
          designation: "",
          email: "",
          phoneNumber: ""
        }
      },

      // 2) organizationalOverview defaults
      organizationalOverview: {
        industrySector: "",
        companyDescription: "",
        numberOfOperationalSites: 0,
        sitesDetails: [],
        totalEmployees: 0,
        employeesByFacility: [],
        accountingYear: ""
      },

      // 3) emissionsProfile defaults
emissionsProfile: {
  scope1: {
    stationaryCombustion: { included: false, details: { name: "", description: "", otherDetails: "" } },
    mobileCombustion:     { included: false, details: { name: "", description: "", otherDetails: "" } },
    processEmissions:     { included: false, details: { name: "", description: "", otherDetails: "" } },
    fugitiveEmissions:    { included: false, details: { name: "", description: "", otherDetails: "" } }
  },
  scope2: {
    purchasedElectricity: { included: false, details: { name: "", description: "", otherDetails: "" } },
    purchasedSteamHeating:{ included: false, details: { name: "", description: "", otherDetails: "" } }
  },
  scope3: {
    includeScope3: false,
    categories: {
      businessTravel: false, employeeCommuting: false, wasteGenerated: false,
      upstreamTransportation: false, downstreamTransportation: false,
      purchasedGoodsAndServices: false, capitalGoods: false, fuelAndEnergyRelated: false,
      upstreamLeasedAssets: false, downstreamLeasedAssets: false,
      processingOfSoldProducts: false, useOfSoldProducts: false,
      endOfLifeTreatment: false, franchises: false, investments: false
    },
    // NEW: per-category details
    categoriesDetails: {
      businessTravel:            { details: { name:"", description:"", otherDetails:"" } },
      employeeCommuting:         { details: { name:"", description:"", otherDetails:"" } },
      wasteGenerated:            { details: { name:"", description:"", otherDetails:"" } },
      upstreamTransportation:    { details: { name:"", description:"", otherDetails:"" } },
      downstreamTransportation:  { details: { name:"", description:"", otherDetails:"" } },
      purchasedGoodsAndServices: { details: { name:"", description:"", otherDetails:"" } },
      capitalGoods:              { details: { name:"", description:"", otherDetails:"" } },
      fuelAndEnergyRelated:      { details: { name:"", description:"", otherDetails:"" } },
      upstreamLeasedAssets:      { details: { name:"", description:"", otherDetails:"" } },
      downstreamLeasedAssets:    { details: { name:"", description:"", otherDetails:"" } },
      processingOfSoldProducts:  { details: { name:"", description:"", otherDetails:"" } },
      useOfSoldProducts:         { details: { name:"", description:"", otherDetails:"" } },
      endOfLifeTreatment:        { details: { name:"", description:"", otherDetails:"" } },
      franchises:                { details: { name:"", description:"", otherDetails:"" } },
      investments:               { details: { name:"", description:"", otherDetails:"" } }
    },
    otherIndirectSources: ""
  }
},


      // 4) ghgDataManagement defaults
      ghgDataManagement: {
        previousCarbonAccounting: {
          conducted: false,
          details: "",
          methodologies: ""
        },
        dataTypesAvailable: {
          energyUsage: false,
          fuelConsumption: false,
          productionProcesses: false,
          otherDataTypes: "",
          dataFormat: ""
        },
        isoCompliance: {
          hasEMSorQMS: false,
          containsGHGProcedures: false,
          certificationDetails: ""
        }
      },

      // 5) additionalNotes defaults
      additionalNotes: {
        stakeholderRequirements: "",
        additionalExpectations: "",
        completedBy: "",
        completionDate: null
      },

      // 6) supportingDocuments default
      supportingDocuments: [],

      // 7) clear any submission timestamps/IDs
      submittedAt: null,
      submittedBy: null,
      updatedAt: null
    };

    // F) Revert stage back to “lead”
    client.stage = "lead";

    // G) Update status to indicate that submitted data was deleted
    client.status = "submission_deleted";

    // H) Log timeline entry
    client.timeline.push({
      stage: "lead",
      status: "submission_deleted",
      action: "Submission data deleted",
      performedBy: req.user.id,
      notes:
        "Consultant Admin (creator) removed their submission; reverted to lead stage",
    });

    await client.save();

    return res.status(200).json({
      message:
        "Client submission data deleted successfully; stage reverted to lead",
      client: {
        clientId: client.clientId,
        stage: client.stage,
        status: client.status,
        submissionData: client.submissionData
      },
    });
  } catch (error) {
    console.error("Delete client data error:", error);
    return res.status(500).json({
      message: "Failed to delete client submission data",
      error: error.message,
    });
  }
};

// ─── Get Client Submission Data (createdBy or assignedConsultant only) ──────────────────────────────────────────
const getClientSubmissionData = async (req, res) => {
  try {
    const { clientId } = req.params;

    // A) Must be a consultant (consultant_admin or consultant)
    if (!["consultant_admin", "consultant"].includes(req.user.userType)) {
      return res.status(403).json({
        message: "Only Consultants can view submission data",
      });
    }

    // B) Find the client record
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    // C) Only the Consultant Admin who created the lead or the assigned consultant may access submissionData
    const creatorId = client.leadInfo.createdBy?.toString();
    const assignedConsultantId = client.leadInfo.assignedConsultantId?.toString();
    if (req.user.id !== creatorId && req.user.id !== assignedConsultantId) {
      return res.status(403).json({
        message:
          "You can only view submission data if you created this client or are the assigned consultant",
      });
    }

    // D) Ensure submissionData exists
    if (!client.submissionData) {
      return res.status(404).json({
        message: "No submission data available for this client",
      });
    }

    // E) Return submissionData
    return res.status(200).json({
      message: "Submission data fetched successfully",
      submissionData: client.submissionData,
    });
  } catch (error) {
    console.error("Get submission data error:", error);
    return res.status(500).json({
      message: "Failed to fetch submission data",
      error: error.message,
    });
  }
};




// Move to Proposal Stage (Stage 3)
// Move to Proposal Stage (Stage 3)
const moveToProposal = async (req, res) => {
  try {
    const { clientId } = req.params;

    // Only consultant_admin can perform this
    if (req.user.userType !== "consultant_admin") {
      return res.status(403).json({
        message: "Only Consultant Admins can move clients to proposal stage",
      });
    }

    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    // Only the same consultant_admin who submitted the data can move it forward
    if (!client.submissionData || client.submissionData.submittedBy?.toString() !== req.user.id) {
      return res.status(403).json({
        message: "Only the Consultant Admin who submitted data can move to proposal stage",
      });
    }

    if (client.stage !== "registered" || client.status !== "submitted") {
      return res.status(400).json({
        message: "Client data must be submitted before moving to proposal stage",
      });
    }

    const previousStage = client.stage;

    // —— Mark proposal submitted (toggle) and switch stage/status
    client.stage = "proposal";
    client.status = "proposal_submitted";
    client.proposalData = {
      ...client.proposalData,
      submitted: true,
      submittedAt: new Date(),
      submittedBy: req.user.id,
      // verifiedAt: new Date(),
      // verifiedBy: req.user.id,
    };

    client.timeline.push({
      stage: "proposal",
      status: "proposal_submitted",
      action: "Submission verified & proposal submitted",
      performedBy: req.user.id,
      notes: "Moved to proposal (toggle only — no proposal creation).",
    });

    await client.save();

    // === Generate PDF of FULL submissionData and email it ===
    try {
      if (!client.submissionData) {
        console.warn(`Client ${client.clientId} moved to proposal without submissionData.`);
      }
      const html = renderClientDataHTML(client); // uses full submissionData
      const filename = `ZeroCarbon_Submission_${client.clientId}.pdf`;
      const pdf = await htmlToPdfBuffer(html, filename);

      // Preferred helper: sends to appropriate recipient(s) with branding
      await sendProposalCreatedEmail(client, [pdf]);

      // If you ever need a fallback:
      // await sendMail(
      //   client.leadInfo.email,
      //   'ZeroCarbon – Proposal Submitted (Submission Summary Attached)',
      //   `Dear ${client.leadInfo.contactPersonName || 'Client'},\n\nWe have submitted your proposal. Please find attached the PDF containing your full submission details.\n\nRegards,\nZeroCarbon Team`,
      //   [{ filename, content: pdf }]
      // );

      console.log(`✉️ Proposal submission email with PDF sent to ${client.leadInfo.email}`);
    } catch (e) {
      console.error('Email/PDF (moveToProposal) error:', e.message);
    }

    // Real-time updates
    await emitClientStageChange(client, previousStage, req.user.id);
    await emitClientListUpdate(client, 'stage_changed', req.user.id);

    return res.status(200).json({
      message: "Client moved to proposal stage (proposal submitted)",
      client: {
        clientId: client.clientId,
        stage: client.stage,
        status: client.status,
        proposalData: client.proposalData
      },
    });
  } catch (error) {
    console.error("Move to proposal error:", error);
    return res.status(500).json({
      message: "Failed to move client to proposal stage",
      error: error.message,
    });
  }
};



// ─── Get Client Proposal Data (creator-only or assignedConsultant) ─────────────────────────────
const getClientProposalData = async (req, res) => {
  try {
    const { clientId } = req.params;

    if (!["consultant_admin", "consultant"].includes(req.user.userType)) {
      return res.status(403).json({ message: "Only Consultants can view proposal data" });
    }

    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ message: "Client not found" });

    // NOW: check toggle instead of proposalNumber
    if (!client.proposalData || !client.proposalData.submitted) {
      return res.status(404).json({ message: "No submitted proposal (toggle) for this client" });
    }

    return res.status(200).json({
      message: "Proposal data fetched successfully",
      proposalData: client.proposalData,
    });
  } catch (error) {
    console.error("Get proposal data error:", error);
    return res.status(500).json({
      message: "Failed to fetch proposal data",
      error: error.message,
    });
  }
};



// Accept/Reject Proposal
// Accept/Reject Proposal - FIXED VERSION
// Accept/Reject Proposal - FIXED
const updateProposalStatus = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { action, reason } = req.body;

    if (req.user.userType !== "consultant_admin") {
      return res.status(403).json({
        message: "Only Consultant Admins can update proposal status",
      });
    }

    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    if (client.stage !== "proposal" || client.status !== "proposal_submitted") {
      return res.status(400).json({
        message: "No submitted proposal to act on for this client",
      });
    }

    if (action === "accept") {
      client.status = "proposal_accepted";
      client.proposalData.clientApprovalDate = new Date();
      const approvedByName =
        client.submissionData?.companyInfo?.primaryContactPerson?.name ||
        client.leadInfo?.contactPersonName ||
        "Client Representative";
      client.proposalData.approvedBy = approvedByName;

      // Move to Active
      const prevStage = client.stage;
      client.stage = "active";
      client.accountDetails = {
        subscriptionStartDate: new Date(),
        subscriptionEndDate: moment().add(1, "year").toDate(),
        subscriptionStatus: "active",
        isActive: true,
        activeUsers: 1,
        lastLoginDate: null,
        dataSubmissions: 0,
      };

      client.timeline.push({
        stage: "active",
        status: "active",
        action: "Proposal accepted and account activated",
        performedBy: req.user.id,
        notes: "Client subscription activated for 1 year",
      });

      // Try to create a client admin (best-effort)
      try {
        await createClientAdmin(clientId, { consultantId: req.user.id });
      } catch (err) {
        console.warn(`createClientAdmin warning: ${err.message}`);
      }

      await client.save();

      // Real-time emits (corrected: use action, not "decision")
      await emitClientStageChange(client, prevStage, req.user.id);
      await emitClientListUpdate(client, 'updated', req.user.id);

      return res.status(200).json({
        message: "Proposal accepted and client account activated",
        client: {
          clientId: client.clientId,
          stage: client.stage,
          status: client.accountDetails.subscriptionStatus,
          subscriptionEndDate: client.accountDetails.subscriptionEndDate,
        },
      });

    } else if (action === "reject") {
      client.status = "proposal_rejected";
      client.proposalData.rejectionReason = reason;
      client.timeline.push({
        stage: "proposal",
        status: "proposal_rejected",
        action: "Proposal rejected",
        performedBy: req.user.id,
        notes: reason || "Client rejected the proposal",
      });

      await client.save();

      await emitClientListUpdate(client, 'updated', req.user.id);

      return res.status(200).json({
        message: "Proposal rejected",
        client: {
          clientId: client.clientId,
          stage: client.stage,
          status: client.status,
        },
      });
    } else {
      return res.status(400).json({
        message: "Invalid action. Use 'accept' or 'reject'",
      });
    }
  } catch (error) {
    console.error("Update proposal status error:", error);
    return res.status(500).json({
      message: "Failed to update proposal status",
      error: error.message,
    });
  }
};


// Get Clients based on user permissions
// Updated getClients function with real-time support
const getClients = async (req, res) => {
  try {
    let query = { isDeleted: false };
    const { stage, status, search, page = 1, limit = 10 } = req.query;
    
    // Build query based on user type
    switch (req.user.userType) {
      case "super_admin":
        // Can see all clients
        break;
        
      case "consultant_admin":
        // Can see clients they or their consultants manage
        const consultants = await User.find({ 
          consultantAdminId: req.user.id 
        }).select("_id");
        
        const consultantIds = consultants.map(c => c._id);
        consultantIds.push(req.user.id);
        
        query.$or = [
          { "leadInfo.consultantAdminId": req.user.id },
          { "leadInfo.assignedConsultantId": { $in: consultantIds } },
          { "workflowTracking.assignedConsultantId": { $in: consultantIds } }
        ];
        break;
        
      case "consultant":
        // Can see assigned clients
        query.$or = [
          { "leadInfo.assignedConsultantId": req.user.id },
          { "workflowTracking.assignedConsultantId": req.user.id }
        ];
        break;
        
      case "client_admin":
      case "auditor":
      case "viewer":
        // Can see own client data
        query.clientId = req.user.clientId;
        break;
        
      default:
        return res.status(403).json({ 
          message: "You don't have permission to view clients" 
        });
    }
    
    // Apply filters
    if (stage) query.stage = stage;
    if (status) query.status = status;
    if (search) {
      query.$and = [
        ...(query.$and || []),
        {
          $or: [
            { clientId: { $regex: search, $options: 'i' } },
            { "leadInfo.companyName": { $regex: search, $options: 'i' } },
            { "leadInfo.email": { $regex: search, $options: 'i' } }
          ]
        }
      ];
    }
    
    // Calculate pagination
    const skip = (page - 1) * limit;
    const total = await Client.countDocuments(query);
    
    const clients = await Client.find(query)
      .populate("leadInfo.consultantAdminId", "userName email")
      .populate("leadInfo.assignedConsultantId", "userName email")
      .populate("workflowTracking.assignedConsultantId", "userName email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    // Format response data
    const responseData = {
      clients: clients.map(client => ({
        _id: client._id,
        clientId: client.clientId,
        stage: client.stage,
        status: client.status,
        leadInfo: {
          companyName: client.leadInfo.companyName,
          contactPersonName: client.leadInfo.contactPersonName,
          email: client.leadInfo.email,
          mobileNumber: client.leadInfo.mobileNumber,
          leadSource: client.leadInfo.leadSource,
            salesPersonName:        client.leadInfo.salesPersonName,
            salesPersonEmployeeId:  client.leadInfo.salesPersonEmployeeId,
            referenceName:          client.leadInfo.referenceName,
            referenceContactNumber: client.leadInfo.referenceContactNumber,
            eventName:              client.leadInfo.eventName,
            eventPlace:             client.leadInfo.eventPlace,
          consultantAdmin: client.leadInfo.consultantAdminId ? {
            id: client.leadInfo.consultantAdminId._id,
            name: client.leadInfo.consultantAdminId.userName,
            email: client.leadInfo.consultantAdminId.email
          } : null,
          assignedConsultant: client.leadInfo.assignedConsultantId ? {
            id: client.leadInfo.assignedConsultantId._id,
            name: client.leadInfo.assignedConsultantId.userName,
            email: client.leadInfo.assignedConsultantId.email
          } : null
        },
        workflowTracking: client.stage === 'active' ? {
          flowchartStatus: client.workflowTracking?.flowchartStatus,
          processFlowchartStatus: client.workflowTracking?.processFlowchartStatus,
          assignedConsultant: client.workflowTracking?.assignedConsultantId ? {
            id: client.workflowTracking.assignedConsultantId._id,
            name: client.workflowTracking.assignedConsultantId.userName,
            email: client.workflowTracking.assignedConsultantId.email
          } : null
        } : undefined,
        accountDetails: client.stage === 'active' ? {
          subscriptionStatus: client.accountDetails?.subscriptionStatus,
          subscriptionEndDate: client.accountDetails?.subscriptionEndDate,
          activeUsers: client.accountDetails?.activeUsers
        } : undefined,
        createdAt: client.createdAt,
        updatedAt: client.updatedAt
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page < Math.ceil(total / limit),
        hasPrevPage: page > 1
      }
    };
    
    // Emit real-time update to the requesting user
    if (global.io) {
      global.io.to(`user_${req.user.id}`).emit('clients_data', {
        type: 'clients_list',
        data: responseData,
        timestamp: new Date().toISOString()
      });
    }
    
    res.status(200).json({
      success: true,
      message: "Clients fetched successfully",
      ...responseData
    });
    
  } catch (error) {
    console.error("Get clients error:", error);
    res.status(500).json({ 
      success: false,
      message: "Failed to fetch clients", 
      error: error.message 
    });
  }
};



// Get single client details
const getClientById = async (req, res) => {
  try {
    const { clientId } = req.params;
    const client = await Client.findOne({ clientId })
      .populate("leadInfo.consultantAdminId", "userName email")
      .populate("leadInfo.assignedConsultantId", "userName email")
      .populate("timeline.performedBy", "userName email");
    
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }
    
    // Check permissions
    let hasAccess = false;
    
    switch (req.user.userType) {
      case "super_admin":
        hasAccess = true;
        break;
        
      case "consultant_admin":
        hasAccess = client.leadInfo.consultantAdminId._id.toString() === req.user.id;
        break;
        
      case "consultant":
        hasAccess = client.leadInfo.assignedConsultantId?._id.toString() === req.user.id;
        break;
        
      case "client_admin":
      case "client_employee_head":
      case "auditor":
      case "viewer":
        hasAccess = client.clientId === req.user.clientId;
        break;
        
      default:
        hasAccess = false;
    }
    
    if (!hasAccess) {
      return res.status(403).json({ 
        message: "You don't have permission to view this client" 
      });
    }
    
    res.status(200).json({
      message: "Client details fetched successfully",
      client
    });
    
  } catch (error) {
    console.error("Get client by ID error:", error);
    res.status(500).json({ 
      message: "Failed to fetch client details", 
      error: error.message 
    });
  }
};

// Update client assignment
// Update client assignment
const assignConsultant = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { consultantId, reasonForChange } = req.body;
    
    // Only consultant admin can assign consultants
    if (req.user.userType !== "consultant_admin") {
      return res.status(403).json({ 
        message: "Only Consultant Admins can assign consultants" 
      });
    }
    
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }
    
    // Verify consultant belongs to this consultant admin
    const consultant = await User.findOne({
      _id: consultantId,
      userType: "consultant",
      consultantAdminId: req.user.id
    });
    
    if (!consultant) {
      return res.status(400).json({ 
        message: "Invalid consultant or consultant not under your management" 
      });
    }
    
    // Store previous consultant info for history and notifications
    const previousConsultantId = client.leadInfo.assignedConsultantId;
    let wasAlreadyAssigned = false;
    
    // Check if consultant is already assigned to this client
    if (previousConsultantId && previousConsultantId.toString() === consultantId) {
      wasAlreadyAssigned = true;
      return res.status(400).json({
        message: "This consultant is already assigned to this client",
        alreadyAssigned: true,
        client: {
          clientId: client.clientId,
          assignedConsultant: {
            id: consultant._id,
            name: consultant.userName,
            employeeId: consultant.employeeId
          }
        }
      });
    }
    
    // Handle previous consultant unassignment
    if (previousConsultantId) {
      // Remove client from previous consultant's assignedClients array
      await User.findByIdAndUpdate(
        previousConsultantId,
        { 
          $pull: { assignedClients: clientId },
          $set: { hasAssignedClients: false } // Will be updated correctly below
        }
      );
      
      // Update consultant history - mark previous assignment as inactive
      const previousHistoryIndex = client.leadInfo.consultantHistory.findIndex(
        h => h.consultantId.toString() === previousConsultantId.toString() && h.isActive
      );
      
      if (previousHistoryIndex !== -1) {
        client.leadInfo.consultantHistory[previousHistoryIndex].isActive = false;
        client.leadInfo.consultantHistory[previousHistoryIndex].unassignedAt = new Date();
        client.leadInfo.consultantHistory[previousHistoryIndex].unassignedBy = req.user.id;
        client.leadInfo.consultantHistory[previousHistoryIndex].reasonForChange = reasonForChange || "Reassigned to new consultant";
      }
    }
    
    // Update client with new consultant
    client.leadInfo.assignedConsultantId = consultantId;
    client.leadInfo.hasAssignedConsultant = true;
    
    // Add new consultant to history
    client.leadInfo.consultantHistory.push({
      consultantId: consultantId,
      consultantName: consultant.userName,
      employeeId: consultant.employeeId,
      assignedAt: new Date(),
      assignedBy: req.user.id,
      reasonForChange: reasonForChange || "Initial assignment",
      isActive: true
    });
    
    // Add timeline entry
    client.timeline.push({
      stage: client.stage,
      status: client.status,
      action: wasAlreadyAssigned ? "Consultant reassigned" : "Consultant assigned",
      performedBy: req.user.id,
      notes: `${wasAlreadyAssigned ? 'Reassigned' : 'Assigned'} to ${consultant.userName} (${consultant.employeeId})`
    });
    
    // ========== WORKFLOW TRACKING UPDATE ==========
    client.workflowTracking.assignedConsultantId = consultantId;
    client.workflowTracking.consultantAssignedAt = new Date();
    // Ensure flowchart & processflowchart start at 'not_started'
    client.workflowTracking.flowchartStatus = 'not_started';
    client.workflowTracking.processFlowchartStatus = 'not_started';
    // reset any old data‐points
    client.workflowTracking.dataInputPoints = {
      manual: { inputs: [], totalCount:0, completedCount:0, pendingCount:0, onGoingCount:0, notStartedCount:0 },
      api:    { inputs: [], totalCount:0, completedCount:0, pendingCount:0, onGoingCount:0, notStartedCount:0 },
      iot:    { inputs: [], totalCount:0, completedCount:0, pendingCount:0, onGoingCount:0, notStartedCount:0 },
      totalDataPoints: 0,
      lastSyncedWithFlowchart: null
    };
    
    await client.save();
    
    // Update new consultant's assignedClients array and hasAssignedClients flag
    await User.findByIdAndUpdate(
      consultantId,
      { 
        $addToSet: { assignedClients: clientId },
        $set: { hasAssignedClients: true }
      },
      { new: true }
    );
    
    // Update previous consultant's hasAssignedClients flag
    if (previousConsultantId) {
      const previousConsultantClients = await User.findById(previousConsultantId).select('assignedClients');
      if (previousConsultantClients && previousConsultantClients.assignedClients.length === 0) {
        await User.findByIdAndUpdate(
          previousConsultantId,
          { $set: { hasAssignedClients: false } }
        );
      }
    }
    
    // ADD THIS: Emit real-time updates (keep existing real-time functionality)
    if (typeof emitClientListUpdate === 'function') {
      await emitClientListUpdate(client, 'updated', req.user.id);
    }
    
    // ADD THIS: Targeted updates for specific consultant views
    // Notify users viewing the previous consultant's clients
    if (previousConsultantId && typeof emitTargetedClientUpdate === 'function') {
        await emitTargetedClientUpdate(
            client,
            'consultant_unassigned',
            req.user.id,
            {
                consultantId: previousConsultantId.toString(),
                action: 'removed'
            }
        );
    }
    
    // Notify users viewing the new consultant's clients
    if (typeof emitTargetedClientUpdate === 'function') {
        await emitTargetedClientUpdate(
            client,
            'consultant_assigned',
            req.user.id,
            {
                consultantId: consultantId,
                action: 'added'
            }
        );
    }

    // Notify the newly assigned consultant
    if (global.io) {
        global.io.to(`user_${consultantId}`).emit('new_client_assignment', {
            clientId: client.clientId,
            companyName: client.leadInfo.companyName,
            timestamp: new Date().toISOString()
        });
    }
    
    // Notify the assigned consultant via email
    const emailSubject = wasAlreadyAssigned ? "Client Reassignment" : "New Client Assignment";
    const emailMessage = `
      You have been ${wasAlreadyAssigned ? 'reassigned' : 'assigned'} to a client:
      
      Client ID: ${clientId}
      Company: ${client.leadInfo.companyName}
      Current Stage: ${client.stage}
      ${reasonForChange ? `Reason: ${reasonForChange}` : ''}
      
      Please review the client details and take appropriate action.
    `;
    
    if (typeof sendMail === 'function') {
      await sendMail(consultant.email, emailSubject, emailMessage);
    }
    
    res.status(200).json({
      message: wasAlreadyAssigned ? "Consultant reassigned successfully" : "Consultant assigned successfully",
      alreadyAssigned: wasAlreadyAssigned,
      client: {
        clientId: client.clientId,
        hasAssignedConsultant: client.leadInfo.hasAssignedConsultant,
        assignedConsultant: {
          id: consultant._id,
          name: consultant.userName,
          email: consultant.email,
          employeeId: consultant.employeeId
        },
        consultantHistory: client.leadInfo.consultantHistory
      }
    });
    
  } catch (error) {
    console.error("Assign consultant error:", error);
    res.status(500).json({ 
      message: "Failed to assign consultant", 
      error: error.message 
    });
  }
};

// Manage subscription
const manageSubscription = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { action, reason, extensionDays } = req.body;
    
    // Check permissions
    if (!["super_admin", "consultant_admin"].includes(req.user.userType)) {
      return res.status(403).json({ 
        message: "Only Super Admin and Consultant Admin can manage subscriptions" 
      });
    }
    
    const client = await Client.findOne({ clientId });
    const previousStatus = client.accountDetails.subscriptionStatus;
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }
    
    if (client.stage !== "active") {
      return res.status(400).json({ 
        message: "Client is not in active stage" 
      });
    }
    
    switch (action) {
      case "suspend":
        client.accountDetails.subscriptionStatus = "suspended";
        client.accountDetails.isActive = false;
        client.accountDetails.suspensionReason = reason;
        client.accountDetails.suspendedBy = req.user.id;
        client.accountDetails.suspendedAt = new Date();
        
        // Deactivate all client users
        await User.updateMany(
          { clientId: client.clientId },
          { isActive: false }
        );
        
        client.timeline.push({
          stage: "active",
          status: "suspended",
          action: "Subscription suspended",
          performedBy: req.user.id,
          notes: reason
        });
        
        break;
        
      case "reactivate":
        client.accountDetails.subscriptionStatus = "active";
        client.accountDetails.isActive = true;
        client.accountDetails.suspensionReason = null;
        client.accountDetails.suspendedBy = null;
        client.accountDetails.suspendedAt = null;
        
        // Reactivate client admin only
        await User.updateOne(
          { 
            _id: client.accountDetails.clientAdminId,
            userType: "client_admin"
          },
          { isActive: true }
        );
        
        client.timeline.push({
          stage: "active",
          status: "active",
          action: "Subscription reactivated",
          performedBy: req.user.id,
          notes: "Account reactivated"
        });
        
        break;
        
      case "extend":
        const currentEndDate = moment(client.accountDetails.subscriptionEndDate);
        const newEndDate = currentEndDate.add(extensionDays || 30, 'days');
        
        client.accountDetails.subscriptionEndDate = newEndDate.toDate();
        
        client.timeline.push({
          stage: "active",
          status: client.accountDetails.subscriptionStatus,
          action: "Subscription extended",
          performedBy: req.user.id,
          notes: `Extended by ${extensionDays || 30} days`
        });
        
        break;
        
      case "renew":
        client.accountDetails.subscriptionStartDate = new Date();
        client.accountDetails.subscriptionEndDate = moment().add(1, 'year').toDate();
        client.accountDetails.subscriptionStatus = "active";
        client.accountDetails.isActive = true;
        
        client.timeline.push({
          stage: "active",
          status: "active",
          action: "Subscription renewed",
          performedBy: req.user.id,
          notes: "Renewed for 1 year"
        });
        
        break;
        
      default:
        return res.status(400).json({ 
          message: "Invalid action. Use: suspend, reactivate, extend, or renew" 
        });
    }
    
    await client.save();

    // ADD THIS: Emit real-time updates
    await emitClientListUpdate(client, 'updated', req.user.id);

    // ADD THIS: Targeted update for users viewing clients by subscription status
    await emitTargetedClientUpdate(
        client,
        'subscription_changed',
        req.user.id,
        {
            stage: 'active',
            subscriptionStatus: client.accountDetails.subscriptionStatus,
            previousStatus: previousStatus
        }
    );


    res.status(200).json({
      message: `Subscription ${action} successful`,
      subscription: {
        status: client.accountDetails.subscriptionStatus,
        endDate: client.accountDetails.subscriptionEndDate,
        isActive: client.accountDetails.isActive
      }
    });
    
  } catch (error) {
    console.error("Manage subscription error:", error);
    res.status(500).json({ 
      message: "Failed to manage subscription", 
      error: error.message 
    });
  }
};



// Enhanced getDashboardMetrics with real-time updates
const getDashboardMetrics = async (req, res) => {
  try {
    // ─── Build base query ────────────────────────────────────────
    let query = { isDeleted: false };
    if (req.user.userType === 'consultant_admin') {
      const consultants = await User.find({
        consultantAdminId: req.user.id,
        userType: 'consultant'
      }).select('_id');
      const consultantIds = consultants.map(c => c._id);
      consultantIds.push(req.user.id);
      query.$or = [
        { 'leadInfo.consultantAdminId': req.user.id },
        { 'leadInfo.assignedConsultantId': { $in: consultantIds } }
      ];
    } else if (req.user.userType === 'consultant') {
      query['leadInfo.assignedConsultantId'] = req.user.id;
    } else if (req.user.userType !== 'super_admin') {
      return res.status(403).json({
        success: false,
        message: "You don't have permission to view dashboard metrics"
      });
    }
    // ────────────────────────────────────────────────────────────────

    // ─── Pagination setup ────────────────────────────────────────
    const paginationParams = getPaginationOptions(req);
    const { page, limit, skip } = paginationParams;
    // ────────────────────────────────────────────────────────────────

    // ─── Aggregated counts (all roles) ──────────────────────────
    const [
      totalClients,
      totalLeadsGenerated,
      regPending,
      regSubmitted,
      regRejected,
      propPending,
      propSubmitted,
      propRejected,
      activeClients,
      expiringSoon
    ] = await Promise.all([
      Client.countDocuments(query),
      Client.countDocuments({ ...query, stage: 'lead' }),
      Client.countDocuments({ ...query, stage: 'registered', status: 'pending' }),
      Client.countDocuments({ ...query, stage: 'registered', status: 'submitted' }),
      Client.countDocuments({ ...query, stage: 'registered', status: 'rejected' }),
      Client.countDocuments({ ...query, stage: 'proposal', status: 'proposal_pending' }),
      Client.countDocuments({ ...query, stage: 'proposal', status: 'proposal_submitted' }),
      Client.countDocuments({ ...query, stage: 'proposal', status: 'proposal_rejected' }),
      Client.countDocuments({ ...query, stage: 'active' }),
      Client.countDocuments({
        ...query,
        stage: 'active',
        'accountDetails.subscriptionEndDate': {
          $lte: moment().add(30, 'days').toDate(),
          $gte: new Date()
        }
      })
    ]);

    // ─── recentActivities ────────────────────────────────────────
    const recentDocs = await Client.find(query)
      .select('clientId timeline')
      .populate('timeline.performedBy', 'userName')
      .sort({ 'timeline.timestamp': -1 })
      .limit(10)
      .lean();
    const recentActivities = recentDocs.flatMap(doc => {
      const last = doc.timeline?.slice(-1)[0];
      return last ? [{
        clientId:   doc.clientId,
        action:     last.action,
        performedBy:last.performedBy?.userName,
        timestamp:  last.timestamp
      }] : [];
    });

    // ─── flowchart/process aggregation ───────────────────────────
    const [ wfAgg = {} ] = await Client.aggregate([
      { $match: query },
      { $group: {
          _id: null,
          totalFlowchartsNotStarted:        { $sum:{ $cond:[{ $eq:['$workflowTracking.flowchartStatus','not_started']},1,0] } },
          totalFlowchartsPending:           { $sum:{ $cond:[{ $eq:['$workflowTracking.flowchartStatus','pending']},1,0] } },
          totalFlowchartsOnGoing:           { $sum:{ $cond:[{ $eq:['$workflowTracking.flowchartStatus','on_going']},1,0] } },
          totalFlowchartsCompleted:         { $sum:{ $cond:[{ $eq:['$workflowTracking.flowchartStatus','completed']},1,0] } },

          totalProcessFlowchartsNotStarted: { $sum:{ $cond:[{ $eq:['$workflowTracking.processFlowchartStatus','not_started']},1,0] } },
          totalProcessFlowchartsPending:    { $sum:{ $cond:[{ $eq:['$workflowTracking.processFlowchartStatus','pending']},1,0] } },
          totalProcessFlowchartsOnGoing:    { $sum:{ $cond:[{ $eq:['$workflowTracking.processFlowchartStatus','on_going']},1,0] } },
          totalProcessFlowchartsCompleted:  { $sum:{ $cond:[{ $eq:['$workflowTracking.processFlowchartStatus','completed']},1,0] } }
        }
      }
    ]);

    // ─── data-input-point aggregation ─────────────────────────────
    const [ ipAgg = {} ] = await Client.aggregate([
      { $match: query },
      { $group: {
          _id: null,
          manualTotal:      { $sum:'$workflowTracking.dataInputPoints.manual.totalCount' },
          manualCompleted:  { $sum:'$workflowTracking.dataInputPoints.manual.completedCount' },
          manualPending:    { $sum:'$workflowTracking.dataInputPoints.manual.pendingCount' },

          apiTotal:         { $sum:'$workflowTracking.dataInputPoints.api.totalCount' },
          apiCompleted:     { $sum:'$workflowTracking.dataInputPoints.api.completedCount' },
          apiPending:       { $sum:'$workflowTracking.dataInputPoints.api.pendingCount' },

          iotTotal:         { $sum:'$workflowTracking.dataInputPoints.iot.totalCount' },
          iotCompleted:     { $sum:'$workflowTracking.dataInputPoints.iot.completedCount' },
          iotPending:       { $sum:'$workflowTracking.dataInputPoints.iot.pendingCount' }
        }
      }
    ]);

    // ─── build the aggregated workflowProgress ───────────────────
    const workflowProgress = {
      flowcharts: {
        notStarted: wfAgg.totalFlowchartsNotStarted   || 0,
        pending:    wfAgg.totalFlowchartsPending      || 0,
        onGoing:    wfAgg.totalFlowchartsOnGoing      || 0,
        completed:  wfAgg.totalFlowchartsCompleted    || 0
      },
      processFlowcharts: {
        notStarted: wfAgg.totalProcessFlowchartsNotStarted || 0,
        pending:    wfAgg.totalProcessFlowchartsPending    || 0,
        onGoing:    wfAgg.totalProcessFlowchartsOnGoing    || 0,
        completed:  wfAgg.totalProcessFlowchartsCompleted  || 0
      },
      dataInputPoints: {
        manual: {
          total:     ipAgg.manualTotal     || 0,
          completed: ipAgg.manualCompleted || 0,
          pending:   ipAgg.manualPending   || 0
        },
        api: {
          total:     ipAgg.apiTotal        || 0,
          completed: ipAgg.apiCompleted    || 0,
          pending:   ipAgg.apiPending      || 0
        },
        iot: {
          total:     ipAgg.iotTotal        || 0,
          completed: ipAgg.iotCompleted    || 0,
          pending:   ipAgg.iotPending      || 0
        },
        total: (ipAgg.manualTotal||0) + (ipAgg.apiTotal||0) + (ipAgg.iotTotal||0)
      }
    };

    const conversionRate = totalClients > 0
      ? ((activeClients / totalClients) * 100).toFixed(2)
      : '0';

    // ─── assemble the static metrics block ──────────────────────
    const metrics = {
      overview:          { totalClients, totalLeadsGenerated, activeClients },
      registrationStage: { pending: regPending, submitted: regSubmitted, rejected: regRejected },
      proposalStage:     { proposal_pending: propPending, proposal_submitted: propSubmitted, proposal_rejected: propRejected },
      expiringSoon,
      conversionRate:    `${conversionRate}%`,
      recentActivities,
      workflowProgress
    };

    // ─── consultant_admin: paginated clients + metrics ─────────
    if (req.user.userType === 'consultant_admin') {
      // totalClients already = count for pagination
      const clientDocs = await Client.find(query)
        .select('clientId workflowTracking accountDetails')
        .skip(skip)
        .limit(limit)
        .lean();

      const clientDetails = clientDocs.map(c => {
        const wt  = c.workflowTracking || {};
        const dip = wt.dataInputPoints || {};
        const totalPts  = (dip.manual?.totalCount||0) + (dip.api?.totalCount||0) + (dip.iot?.totalCount||0);
        const completed = (dip.manual?.completedCount||0) + (dip.api?.completedCount||0) + (dip.iot?.completedCount||0);
        const remaining = totalPts - completed;
        const endDate   = c.accountDetails?.subscriptionEndDate;
        const remDays   = endDate
          ? Math.max(0, Math.ceil((new Date(endDate) - Date.now())/86400000))
          : null;

        return {
          clientId: c.clientId,
          workflowProgress: {
            flowchartStatus:        wt.flowchartStatus        || 'not_started',
            processFlowchartStatus: wt.processFlowchartStatus || 'not_started',
            dataInputPoints: {
              manual:   { total: dip.manual?.totalCount||0, completed: dip.manual?.completedCount||0, pending: dip.manual?.pendingCount||0 },
              api:      { total: dip.api?.totalCount||0,    completed: dip.api?.completedCount||0,    pending: dip.api?.pendingCount||0    },
              iot:      { total: dip.iot?.totalCount||0,    completed: dip.iot?.completedCount||0,    pending: dip.iot?.pendingCount||0    },
              overall:  totalPts
            }
          },
          remainingDataPoints:       remaining,
          remainingSubscriptionDays: remDays
        };
      });

      // build pagination metadata
      const totalPages = Math.ceil(totalClients / limit);
      const pagination = {
        currentPage:  page,
        totalPages,
        totalItems:   totalClients,
        itemsPerPage: limit,
        hasNextPage:  page < totalPages,
        hasPrevPage:  page > 1
      };

      // emit real-time update
      if (global.broadcastDashboardUpdate) {
        await global.broadcastDashboardUpdate(
          'dashboard_metrics',
          { metrics, clients: clientDetails, pagination },
          [ req.user.id ]
        );
      }

      return res.status(200).json({
        success:   true,
        message:   'Dashboard metrics fetched successfully',
        metrics,
        clients:   clientDetails,
        pagination
      });
    }

    // ─── consultant-only: paginated clients + minimal metrics ────
    if (req.user.userType === 'consultant') {
      const docs = await Client.find(query)
        .skip(skip)
        .limit(limit);

      const data = docs.map(c => {
        const wf = c.getWorkflowDashboard();
        const completed = wf.dataInputPoints.manual.completed
                        + wf.dataInputPoints.api.completed
                        + wf.dataInputPoints.iot.completed;
        const remaining = wf.dataInputPoints.overall - completed;
        const end = c.accountDetails.subscriptionEndDate;
        const remDays = end ? moment(end).diff(moment(), 'days') : null;

        return {
          clientId:                c.clientId,
          workflowProgress:        wf,
          remainingDataPoints:     remaining,
          remainingSubscriptionDays: remDays
        };
      });

      const totalPages = Math.ceil(totalClients / limit);
      const pagination = {
        currentPage:  page,
        totalPages,
        totalItems:   totalClients,
        itemsPerPage: limit,
        hasNextPage:  page < totalPages,
        hasPrevPage:  page > 1
      };

      if (global.broadcastDashboardUpdate) {
        await global.broadcastDashboardUpdate(
          'dashboard_metrics',
          { clients: data, pagination },
          [ req.user.id ]
        );
      }

      return res.status(200).json({
        success:   true,
        message:   'Consultant dashboard metrics fetched successfully',
        clients:   data,
        pagination
      });
    }

    // ─── super_admin: paginated clients + metrics ───────────────
    if (req.user.userType === 'super_admin') {
      const docs = await Client.find(query)
        .select('clientId workflowTracking dataInputPoints accountDetails')
        .skip(skip)
        .limit(limit)
        .lean();

      const clientList = docs.map(c => {
        const wt  = c.workflowTracking || {};
        const dip = wt.dataInputPoints || {};
        const totalPts     = (dip.manual?.totalCount||0) + (dip.api?.totalCount||0) + (dip.iot?.totalCount||0);
        const completedPts = (dip.manual?.completedCount||0) + (dip.api?.completedCount||0) + (dip.iot?.completedCount||0);
        const remaining    = totalPts - completedPts;

        return {
          clientId:              c.clientId,
          flowchartStatus:       wt.flowchartStatus        || 'not_started',
          processFlowchartStatus:wt.processFlowchartStatus || 'not_started',
          remainingDataPoints:   remaining
        };
      });

      const totalPages = Math.ceil(totalClients / limit);
      const pagination = {
        currentPage:  page,
        totalPages,
        totalItems:   totalClients,
        itemsPerPage: limit,
        hasNextPage:  page < totalPages,
        hasPrevPage:  page > 1
      };

      if (global.broadcastDashboardUpdate) {
        await global.broadcastDashboardUpdate(
          'dashboard_metrics',
          { metrics, clients: clientList, pagination }
        );
      }

      return res.status(200).json({
        success:   true,
        message:   'Dashboard metrics fetched successfully',
        metrics,
        clients:   clientList,
        pagination
      });
    }

  } catch (error) {
    console.error('Get dashboard metrics error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch dashboard metrics',
      error:   error.message
    });
  }
};




// Check and update expired subscriptions (to be called by cron job)
const checkExpiredSubscriptions = async () => {
  try {
    const expiredClients = await Client.find({
      stage: "active",
      "accountDetails.subscriptionEndDate": { $lte: new Date() },
      "accountDetails.subscriptionStatus": "active"
    });
      const updatedClientIds =[];
      
    for (const client of expiredClients) {
      // Check if in grace period (30 days)
      const daysSinceExpiry = moment().diff(
        moment(client.accountDetails.subscriptionEndDate), 
        'days'
      );
      
      if (daysSinceExpiry <= 30) {
        // Grace period
        client.accountDetails.subscriptionStatus = "grace_period";
        
        // Send grace period notification
        const clientAdmin = await User.findById(client.accountDetails.clientAdminId);
        if (clientAdmin) {
          const emailSubject = "ZeroCarbon - Subscription Expired (Grace Period)";
          const emailMessage = `
            Your ZeroCarbon subscription has expired.
            
            You are currently in a 30-day grace period. Please renew your subscription to continue using our services.
            
            Grace period ends on: ${moment(client.accountDetails.subscriptionEndDate).add(30, 'days').format('DD/MM/YYYY')}
            
            Contact your consultant for renewal.
          `;
          
          await sendMail(clientAdmin.email, emailSubject, emailMessage);
        }
      } else {
        // Fully expired
        client.accountDetails.subscriptionStatus = "expired";
        client.accountDetails.isActive = false;
        
        // Deactivate all users
        await User.updateMany(
          { clientId: client.clientId },
          { isActive: false }
        );
      }
      
      client.timeline.push({
        stage: "active",
        status: client.accountDetails.subscriptionStatus,
        action: `Subscription ${client.accountDetails.subscriptionStatus}`,
        performedBy: null,
        notes: "Automatic system update"
      });

    
      
      await client.save();
      updatedClientIds.push(client._id);
      
       // ADD THIS: Batch emit updates
    if (updatedClientIds.length > 0) {
        await emitBatchClientUpdate(updatedClientIds, 'updated', null);
    }
    }
    
    console.log(`Processed ${expiredClients.length} expired subscriptions`);
    
  } catch (error) {
    console.error("Check expired subscriptions error:", error);
  }
};


// Get consultant assignment history for a client
const getConsultantHistory = async (req, res) => {
  try {
    const { clientId } = req.params;
    
    const client = await Client.findOne({ clientId })
      .populate('leadInfo.consultantHistory.consultantId', 'userName email employeeId')
      .populate('leadInfo.consultantHistory.assignedBy', 'userName email')
      .populate('leadInfo.consultantHistory.unassignedBy', 'userName email');
    
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }
    
    // Check permissions (same as getClientById)
    let hasAccess = false;
    switch (req.user.userType) {
      case "super_admin":
        hasAccess = true;
        break;
      case "consultant_admin":
        hasAccess = client.leadInfo.consultantAdminId._id.toString() === req.user.id;
        break;
      case "consultant":
        hasAccess = client.leadInfo.assignedConsultantId?._id.toString() === req.user.id;
        break;
      default:
        hasAccess = false;
    }
    
    if (!hasAccess) {
      return res.status(403).json({ 
        message: "You don't have permission to view this client's consultant history" 
      });
    }
    
    res.status(200).json({
      message: "Consultant history fetched successfully",
      clientId: client.clientId,
      companyName: client.leadInfo.companyName,
      hasAssignedConsultant: client.leadInfo.hasAssignedConsultant,
      currentConsultant: client.leadInfo.assignedConsultantId,
      consultantHistory: client.leadInfo.consultantHistory
    });
    
  } catch (error) {
    console.error("Get consultant history error:", error);
    res.status(500).json({ 
      message: "Failed to fetch consultant history", 
      error: error.message 
    });
  }
};

// Add this function to your clientController.js

/**
 * Change Consultant - Remove current consultant and assign new one
 * PATCH /api/clients/:clientId/change-consultant
 * Only consultant_admin can change consultants
 * Body: { newConsultantId, reasonForChange }
 */
const changeConsultant = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { newConsultantId, reasonForChange } = req.body;
    
    // Validation
    if (!newConsultantId || !reasonForChange) {
      return res.status(400).json({ 
        message: "New consultant ID and reason for change are required" 
      });
    }
    
    // Only consultant admin can change consultants
    if (req.user.userType !== "consultant_admin") {
      return res.status(403).json({ 
        message: "Only Consultant Admins can change consultants" 
      });
    }
    
    // Find the client
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }
    
    // Check if client belongs to this consultant admin
    if (client.leadInfo.consultantAdminId._id.toString() !== req.user.id) {
      return res.status(403).json({ 
        message: "You can only change consultants for your own clients" 
      });
    }
    
    // Check if client currently has a consultant assigned
    const currentConsultantId = client.leadInfo.assignedConsultantId;
    if (!currentConsultantId) {
      return res.status(400).json({ 
        message: "No consultant is currently assigned to this client" 
      });
    }
    
    // Verify new consultant belongs to this consultant admin
    const newConsultant = await User.findOne({
      _id: newConsultantId,
      userType: "consultant",
      consultantAdminId: req.user.id,
      isActive: true
    });
    
    if (!newConsultant) {
      return res.status(400).json({ 
        message: "Invalid consultant or consultant not under your management" 
      });
    }
    
    // Check if new consultant is same as current consultant
    if (currentConsultantId.toString() === newConsultantId) {
      return res.status(400).json({
        message: "The selected consultant is already assigned to this client"
      });
    }
    
    // Get current consultant details for history
    const currentConsultant = await User.findById(currentConsultantId);
    
    // === STEP 1: Remove current consultant ===
    
    // Remove client from current consultant's assignedClients array
    await User.findByIdAndUpdate(
      currentConsultantId,
      { 
        $pull: { assignedClients: clientId }
      }
    );
    
    // Update current consultant's hasAssignedClients flag
    const currentConsultantClients = await User.findById(currentConsultantId).select('assignedClients');
    if (currentConsultantClients && currentConsultantClients.assignedClients.length === 0) {
      await User.findByIdAndUpdate(
        currentConsultantId,
        { $set: { hasAssignedClients: false } }
      );
    }
    
    // Mark previous assignment as inactive in consultant history
    const previousHistoryIndex = client.leadInfo.consultantHistory.findIndex(
      h => h.consultantId.toString() === currentConsultantId.toString() && h.isActive
    );
    
    if (previousHistoryIndex !== -1) {
      client.leadInfo.consultantHistory[previousHistoryIndex].isActive = false;
      client.leadInfo.consultantHistory[previousHistoryIndex].unassignedAt = new Date();
      client.leadInfo.consultantHistory[previousHistoryIndex].unassignedBy = req.user.id;
      client.leadInfo.consultantHistory[previousHistoryIndex].reasonForChange = reasonForChange;
    }
    
    // === STEP 2: Assign new consultant ===
    
    // Update client with new consultant
    client.leadInfo.assignedConsultantId = newConsultantId;
    client.leadInfo.hasAssignedConsultant = true;
    
    // Add new consultant to history
    client.leadInfo.consultantHistory.push({
      consultantId: newConsultantId,
      consultantName: newConsultant.userName,
      employeeId: newConsultant.employeeId,
      assignedAt: new Date(),
      assignedBy: req.user.id,
      reasonForChange: reasonForChange,
      isActive: true
    });
    
    // Add timeline entry
    client.timeline.push({
      stage: client.stage,
      status: client.status,
      action: "Consultant changed",
      performedBy: req.user.id,
      notes: `Changed from ${currentConsultant?.userName || 'Unknown'} to ${newConsultant.userName}. Reason: ${reasonForChange}`
    });
    
    // ========== WORKFLOW TRACKING UPDATE ==========
    if (client.workflowTracking) {
      client.workflowTracking.assignedConsultantId = newConsultantId;
      client.workflowTracking.consultantAssignedAt = new Date();
      
      // Reset workflow status if client is in workflow stage
      if (client.stage === 'active_client') {
        client.workflowTracking.flowchartStatus = 'not_started';
        client.workflowTracking.processFlowchartStatus = 'not_started';
        
        // Reset data input points
        client.workflowTracking.dataInputPoints = {
          manual: { inputs: [], totalCount:0, completedCount:0, pendingCount:0, onGoingCount:0, notStartedCount:0 },
          api:    { inputs: [], totalCount:0, completedCount:0, pendingCount:0, onGoingCount:0, notStartedCount:0 },
          iot:    { inputs: [], totalCount:0, completedCount:0, pendingCount:0, onGoingCount:0, notStartedCount:0 },
          totalDataPoints: 0,
          lastSyncedWithFlowchart: null
        };
      }
    }
    
    await client.save();
    
    // Update new consultant's assignedClients array and hasAssignedClients flag
    await User.findByIdAndUpdate(
      newConsultantId,
      { 
        $addToSet: { assignedClients: clientId },
        $set: { hasAssignedClients: true }
      }
    );
    
    // === NOTIFICATIONS ===
    
    // Notify the previously assigned consultant
    if (currentConsultant && global.io) {
      global.io.to(`user_${currentConsultantId}`).emit('consultant_unassigned', {
        clientId: client.clientId,
        companyName: client.leadInfo.companyName,
        reason: reasonForChange,
        timestamp: new Date().toISOString()
      });
    }
    
    // Notify the newly assigned consultant
    if (global.io) {
      global.io.to(`user_${newConsultantId}`).emit('consultant_assigned', {
        clientId: client.clientId,
        companyName: client.leadInfo.companyName,
        previousConsultant: currentConsultant?.userName || 'Unknown',
        reason: reasonForChange,
        timestamp: new Date().toISOString()
      });
    }
    
    // Send email notifications
    try {
      // Email to new consultant
      const newConsultantEmailSubject = "New Client Assignment";
      const newConsultantEmailMessage = `
        You have been assigned to a new client:
        
        Client ID: ${clientId}
        Company: ${client.leadInfo.companyName}
        Current Stage: ${client.stage}
        Previous Consultant: ${currentConsultant?.userName || 'Unknown'}
        Reason for Change: ${reasonForChange}
        
        Please review the client details and take appropriate action.
      `;
      
      if (typeof sendMail === 'function') {
        await sendMail(newConsultant.email, newConsultantEmailSubject, newConsultantEmailMessage);
      }
      
      // Email to previous consultant
      if (currentConsultant) {
        const prevConsultantEmailSubject = "Client Reassignment Notification";
        const prevConsultantEmailMessage = `
          You have been unassigned from the following client:
          
          Client ID: ${clientId}
          Company: ${client.leadInfo.companyName}
          New Consultant: ${newConsultant.userName}
          Reason for Change: ${reasonForChange}
          
          Please ensure all client materials are properly handed over.
        `;
        
        if (typeof sendMail === 'function') {
          await sendMail(currentConsultant.email, prevConsultantEmailSubject, prevConsultantEmailMessage);
        }
      }
    } catch (emailError) {
      console.error("Warning: Could not send email notifications:", emailError);
      // Continue with the response even if email fails
    }
    
    // Emit real-time updates for dashboard
    if (typeof emitClientListUpdate === 'function') {
      await emitClientListUpdate(client, 'consultant_changed', req.user.id);
    }
    
    res.status(200).json({
      message: "Consultant changed successfully",
      client: {
        clientId: client.clientId,
        companyName: client.leadInfo.companyName,
        stage: client.stage,
        previousConsultant: {
          id: currentConsultantId,
          name: currentConsultant?.userName || 'Unknown',
          employeeId: currentConsultant?.employeeId || 'Unknown'
        },
        newConsultant: {
          id: newConsultant._id,
          name: newConsultant.userName,
          employeeId: newConsultant.employeeId
        },
        reasonForChange: reasonForChange
      }
    });
    
  } catch (error) {
    console.error("Change consultant error:", error);
    res.status(500).json({ 
      message: "Failed to change consultant", 
      error: error.message 
    });
  }
};

/**
 * Remove Consultant - Remove current consultant without assigning new one
 * PATCH /api/clients/:clientId/remove-consultant
 * Only consultant_admin can remove consultants
 * Body: { reasonForRemoval }
 */
const removeConsultant = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { reasonForRemoval } = req.body;
    
    // Validation
    if (!reasonForRemoval) {
      return res.status(400).json({ 
        message: "Reason for removal is required" 
      });
    }
    
    // Only consultant admin can remove consultants
    if (req.user.userType !== "consultant_admin") {
      return res.status(403).json({ 
        message: "Only Consultant Admins can remove consultants" 
      });
    }
    
    // Find the client
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }
    
    // Check if client belongs to this consultant admin
    if (client.leadInfo.consultantAdminId._id.toString() !== req.user.id) {
      return res.status(403).json({ 
        message: "You can only remove consultants from your own clients" 
      });
    }
    
    // Check if client currently has a consultant assigned
    const currentConsultantId = client.leadInfo.assignedConsultantId;
    if (!currentConsultantId) {
      return res.status(400).json({ 
        message: "No consultant is currently assigned to this client" 
      });
    }
    
    // Get current consultant details for history
    const currentConsultant = await User.findById(currentConsultantId);
    
    // Remove client from current consultant's assignedClients array
    await User.findByIdAndUpdate(
      currentConsultantId,
      { 
        $pull: { assignedClients: clientId }
      }
    );
    
    // Update current consultant's hasAssignedClients flag
    const currentConsultantClients = await User.findById(currentConsultantId).select('assignedClients');
    if (currentConsultantClients && currentConsultantClients.assignedClients.length === 0) {
      await User.findByIdAndUpdate(
        currentConsultantId,
        { $set: { hasAssignedClients: false } }
      );
    }
    
    // Mark assignment as inactive in consultant history
    const historyIndex = client.leadInfo.consultantHistory.findIndex(
      h => h.consultantId.toString() === currentConsultantId.toString() && h.isActive
    );
    
    if (historyIndex !== -1) {
      client.leadInfo.consultantHistory[historyIndex].isActive = false;
      client.leadInfo.consultantHistory[historyIndex].unassignedAt = new Date();
      client.leadInfo.consultantHistory[historyIndex].unassignedBy = req.user.id;
      client.leadInfo.consultantHistory[historyIndex].reasonForChange = reasonForRemoval;
    }
    
    // Remove consultant from client
    client.leadInfo.assignedConsultantId = null;
    client.leadInfo.hasAssignedConsultant = false;
    
    // Add timeline entry
    client.timeline.push({
      stage: client.stage,
      status: client.status,
      action: "Consultant removed",
      performedBy: req.user.id,
      notes: `Removed ${currentConsultant?.userName || 'Unknown'} from client. Reason: ${reasonForRemoval}`
    });
    
    // Clear workflow tracking consultant
    if (client.workflowTracking) {
      client.workflowTracking.assignedConsultantId = null;
    }
    
    await client.save();
    
    // Notify the removed consultant
    if (currentConsultant && global.io) {
      global.io.to(`user_${currentConsultantId}`).emit('consultant_removed', {
        clientId: client.clientId,
        companyName: client.leadInfo.companyName,
        reason: reasonForRemoval,
        timestamp: new Date().toISOString()
      });
    }
    
    // Send email notification to removed consultant
    try {
      if (currentConsultant && typeof sendMail === 'function') {
        const emailSubject = "Client Assignment Removed";
        const emailMessage = `
          You have been removed from the following client:
          
          Client ID: ${clientId}
          Company: ${client.leadInfo.companyName}
          Reason for Removal: ${reasonForRemoval}
          
          Please ensure all client materials are properly returned.
        `;
        
        await sendMail(currentConsultant.email, emailSubject, emailMessage);
      }
    } catch (emailError) {
      console.error("Warning: Could not send email notification:", emailError);
    }
    
    // Emit real-time updates
    if (typeof emitClientListUpdate === 'function') {
      await emitClientListUpdate(client, 'consultant_removed', req.user.id);
    }
    
    res.status(200).json({
      message: "Consultant removed successfully",
      client: {
        clientId: client.clientId,
        companyName: client.leadInfo.companyName,
        stage: client.stage,
        removedConsultant: {
          id: currentConsultantId,
          name: currentConsultant?.userName || 'Unknown',
          employeeId: currentConsultant?.employeeId || 'Unknown'
        },
        reasonForRemoval: reasonForRemoval
      }
    });
    
  } catch (error) {
    console.error("Remove consultant error:", error);
    res.status(500).json({ 
      message: "Failed to remove consultant", 
      error: error.message 
    });
  }
};

// ─── Update assessmentLevel only (post-onboarding) ─────────────────────────────
// ─── Update assessmentLevel only (post-onboarding, no submission checks) ─────
const updateAssessmentLevelOnly = async (req, res) => {
  try {
    const { clientId } = req.params;
    const rawLevels = req.body?.assessmentLevel;

    if (!rawLevels) {
      return res.status(400).json({ message: "assessmentLevel is required in body" });
    }

    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ message: "Client not found" });

    // Only after onboarding
    if (client.stage !== 'active') {
      return res.status(400).json({
        message: "assessmentLevel can be changed only after onboarding (stage === 'active')."
      });
    }

    // Normalize allowed values (accepts string or array; maps 'organisation' → 'organization')
    const nextLevels = normalizeAssessmentLevels(rawLevels);
    if (nextLevels.length === 0) {
      return res.status(400).json({
        message: "assessmentLevel must contain at least one allowed value (reduction, decarbonization, organization, process)"
      });
    }

    // Ensure submissionData exists, but DO NOT overwrite subdocs
    if (!client.submissionData || typeof client.submissionData !== 'object') {
      client.submissionData = {}; // create container only
    }

    // Update only the specific nested paths to avoid casting entire object
    client.set('submissionData.assessmentLevel', nextLevels);
    client.set('submissionData.updatedAt', new Date());

    // Keep your existing workflow alignment
    if (typeof client.updateWorkflowBasedOnAssessment === 'function') {
      client.updateWorkflowBasedOnAssessment();
    }

    const previous = Array.isArray(client.submissionData?.assessmentLevel)
      ? client.submissionData.assessmentLevel
      : [];

    client.timeline.push({
      stage: client.stage,
      status: client.status,
      action: "Assessment level updated (post-onboarding)",
      performedBy: req.user.id,
      notes: `Changed from [${previous}] to [${nextLevels}].`
    });

    // Save without running unrelated validators on submission subdocs
    await client.save({ validateBeforeSave: false });

    return res.status(200).json({
      message: "assessmentLevel updated successfully",
      assessmentLevel: nextLevels
    });

  } catch (err) {
    console.error("Update assessmentLevel error:", err);
    return res.status(500).json({
      message: "Failed to update assessmentLevel",
      error: err.message
    });
  }
};




module.exports = {
  createLead,
  updateLead,
  deleteLead,
  getLeads,
  moveToDataSubmission,
  submitClientData,
  updateClientData,
  deleteClientData,
  getClientSubmissionData,
  moveToProposal,

  getClientProposalData,
  updateProposalStatus,
  getClients,
  getClientById,
  assignConsultant,
  manageSubscription,
  getDashboardMetrics,
  checkExpiredSubscriptions,
  updateFlowchartStatus,
  updateProcessFlowchartStatus,
  syncDataInputPoints,
  updateManualInputStatus,
  updateAPIInputStatus,
  updateIoTInputStatus,
  getConsultantHistory,
  changeConsultant,
  removeConsultant,
  updateAssessmentLevelOnly
};