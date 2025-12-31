const Client = require("../../models/CMS/Client");
const User = require("../../models/User");
const { sendMail } = require("../../utils/mail");
const { createClientAdmin } = require("../userController");
const Notification = require("../../models/Notification/Notification");
const moment = require("moment");
const { emailQueue } = require("../../utils/emailQueue");
const { withTimeout } = require('../../utils/queueUtils');
const mongoose = require("mongoose"); 
// Add these imports at the top of your clientController.js file
const Flowchart = require("../../models/Organization/Flowchart");
const ProcessFlowchart = require("../../models/Organization/ProcessFlowchart");

// ⬇️ NEW imports for reductions + sandbox audit + (optional) SBTi
const Reduction = require("../../models/Reduction/Reduction");        // adjust path if needed
const SbtiTarget = require("../../models/Decarbonization/SbtiTarget"); // adjust path if needed

const {
  createLeadActionNotification,
  createDataSubmissionNotification,
  createProposalActionNotification,
  createConsultantAssignmentNotification
} = require("../../utils/notifications/notificationHelper");

const {
  sendLeadCreatedEmail,
  sendConsultantAssignedEmail
} = require('../../utils/emailHelper');

const {
 emitFlowchartStatusUpdate,
  emitDataInputPointUpdate,
  emitNewClientCreated,
  emitClientStageChange,
  emitDashboardRefresh,
  emitClientListUpdate,
  emitBatchClientUpdate,
  emitFilteredClientListUpdate,
  emitTargetedClientUpdate  // <-- ADD THIS LINE
} = require('../../utils/dashboardEmitter');


const {
  sendClientDataSubmittedEmail,
  sendClientDataUpdatedEmail,
  sendProposalCreatedEmail,
  sendProposalUpdatedEmail
} = require('../../utils/emailServiceClient');


const { renderClientDataHTML, renderProposalHTML } = require('../../utils/pdfTemplates');
const { htmlToPdfBuffer } = require('../../utils/pdfService');

const {
  normalizeAssessmentLevels,
  validateSubmissionForLevels
} = require('../../utils/assessmentLevel');





/**
 * Helper: when a client moves from sandbox/proposal → active,
 * update clientId for:
 *  - Users
 *  - Flowcharts
 *  - ProcessFlowcharts
 *  - Reductions
 *  - Decarbonization (raw collection 'decarbonizations')
 *
 * Also writes a SandboxAudit entry (who did it, when, what changed).
 */
async function updateClientIdReferencesOnActivation(oldClientId, newClientId, actorUserId, actionLabel = 'proposal_accept') {
  if (!oldClientId || !newClientId || oldClientId === newClientId) {
    return;
  }

  const conn = mongoose.connection;
  const results = {};

  // 1) Users: move them from old clientId → new clientId, and activate them
  try {
    const userRes = await User.updateMany(
      { clientId: oldClientId },
      {
        $set: {
          clientId: newClientId,
          sandbox: false,
          isActive: true,
        },
      }
    );
    results.users = {
      matched: userRes.matchedCount ?? userRes.n ?? 0,
      modified: userRes.modifiedCount ?? userRes.nModified ?? 0,
    };
  } catch (err) {
    console.error('[updateClientIdReferencesOnActivation] User update error:', err.message);
    results.users = { error: err.message };
  }

  // 2) Flowcharts
  try {
    const fcRes = await Flowchart.updateMany(
      { clientId: oldClientId },
      { $set: { clientId: newClientId } }
    );
    results.flowcharts = {
      matched: fcRes.matchedCount ?? fcRes.n ?? 0,
      modified: fcRes.modifiedCount ?? fcRes.nModified ?? 0,
    };
  } catch (err) {
    console.error('[updateClientIdReferencesOnActivation] Flowchart update error:', err.message);
    results.flowcharts = { error: err.message };
  }

  // 3) Process Flowcharts
  try {
    const pfcRes = await ProcessFlowchart.updateMany(
      { clientId: oldClientId },
      { $set: { clientId: newClientId } }
    );
    results.processFlowcharts = {
      matched: pfcRes.matchedCount ?? pfcRes.n ?? 0,
      modified: pfcRes.modifiedCount ?? pfcRes.nModified ?? 0,
    };
  } catch (err) {
    console.error('[updateClientIdReferencesOnActivation] ProcessFlowchart update error:', err.message);
    results.processFlowcharts = { error: err.message };
  }

  // 4) Reductions
  try {
    const redRes = await Reduction.updateMany(
      { clientId: oldClientId },
      { $set: { clientId: newClientId } }
    );
    results.reductions = {
      matched: redRes.matchedCount ?? redRes.n ?? 0,
      modified: redRes.modifiedCount ?? redRes.nModified ?? 0,
    };
  } catch (err) {
    console.error('[updateClientIdReferencesOnActivation] Reduction update error:', err.message);
    results.reductions = { error: err.message };
  }

  // 5) Decarbonization collection (raw collection name)
  try {
    const decarbColl = conn.collection('decarbonizations'); // same name used in sandboxController
    const decRes = await decarbColl.updateMany(
      { clientId: oldClientId },
      { $set: { clientId: newClientId } }
    );
    results.decarbonizations = {
      matched: decRes.matchedCount ?? decRes.n ?? 0,
      modified: decRes.modifiedCount ?? decRes.nModified ?? 0,
    };
  } catch (err) {
    // Not fatal – maybe collection does not exist yet
    console.warn('[updateClientIdReferencesOnActivation] Decarbonization update warning:', err.message);
    results.decarbonizations = { warning: err.message };
  }

  //6) (Optional) if you also want to update SBTi targets by model
  try {
    const sbtiRes = await SbtiTarget.updateMany(
      { clientId: oldClientId },
      { $set: { clientId: newClientId } }
    );
    results.sbtiTargets = {
      matched: sbtiRes.matchedCount ?? sbtiRes.n ?? 0,
      modified: sbtiRes.modifiedCount ?? sbtiRes.nModified ?? 0,
    };
  } catch (err) {
    console.warn('[updateClientIdReferencesOnActivation] SBTi update warning:', err.message);
    results.sbtiTargets = { warning: err.message };
  }

  // 7) Write an audit log entry (who, when, what)
  try {
    if (actorUserId) {
      await SandboxAudit.create({
        oldClientId,
        newClientId,
        updatedBy: actorUserId,
        action: actionLabel,
        reason: 'Client moved to active. ClientId and related documents updated.',
        meta: results,
      });
    }
  } catch (err) {
    console.error('[updateClientIdReferencesOnActivation] SandboxAudit create error:', err.message);
  }

  return results;
}

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
// Sync data input points from flowchart + processflowchart
const syncDataInputPoints = async (req, res) => {
  const startTime = Date.now();

  try {
    const { clientId } = req.params;

    // ---------------------------------------------
    // 1️⃣ PERMISSION CHECK
    // ---------------------------------------------
    if (!['consultant', 'consultant_admin'].includes(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message: "Only consultants can sync data input points",
        timestamp: new Date().toISOString()
      });
    }

    // ---------------------------------------------
    // 2️⃣ LOAD CLIENT + FLOWCHARTS
    // ---------------------------------------------
    const [client, flowchart, processFlowchart] = await Promise.all([
      Client.findOne({ clientId }),
      Flowchart.findOne({ clientId, isActive: true }).lean(),
      ProcessFlowchart.findOne({ clientId, isDeleted: false }).lean()
    ]);

    if (!client) {
      return res.status(404).json({
        success: false,
        message: "Client not found",
        timestamp: new Date().toISOString()
      });
    }

    if (!flowchart) {
      return res.status(404).json({
        success: false,
        message: "Active flowchart not found. Please create a flowchart first.",
        timestamp: new Date().toISOString()
      });
    }

    // ---------------------------------------------
    // 3️⃣ BUILD MERGED NODES (WITH fromOtherChart RULE)
    // ---------------------------------------------
    const mergedNodes = [];

    // 3A️⃣ ORGANIZATION FLOWCHART → ALWAYS INCLUDED
    for (const node of flowchart.nodes || []) {
      if (!node?.details?.scopeDetails?.length) continue;

      mergedNodes.push({
        ...node,
        __source: 'organization'
      });
    }

    // 3B️⃣ PROCESS FLOWCHART → ONLY fromOtherChart === false
    if (processFlowchart?.nodes?.length) {
      for (const node of processFlowchart.nodes) {
        const validScopes = (node.details?.scopeDetails || []).filter(
          scope => scope.fromOtherChart === false && !scope.isDeleted
        );

        if (validScopes.length === 0) continue;

        mergedNodes.push({
          ...node,
          details: {
            ...node.details,
            scopeDetails: validScopes
          },
          __source: 'process'
        });
      }
    }

    // ---------------------------------------------
    // 4️⃣ HELPER: MERGE INPUT POINTS
    // ---------------------------------------------
    const mergePoints = (existing = [], nodes, inputType) => {
      const existingMap = new Map(existing.map(p => [p.pointId, p]));
      const newList = [];

      for (const node of nodes) {
        const scopes = node.details?.scopeDetails || [];

        for (const scope of scopes) {
          if (scope.inputType?.toLowerCase() !== inputType) continue;

          const pointId = `${node.id}_${scope.scopeIdentifier}_${inputType}`;

          const base = {
            pointId,
            nodeId: node.id,
            scopeIdentifier: scope.scopeIdentifier,
            lastUpdatedBy: req.user.id,
            lastUpdatedAt: new Date()
          };

          if (existingMap.has(pointId)) {
            newList.push({
              ...existingMap.get(pointId),
              ...base
            });
          } else {
            // -------- CREATE NEW POINT ----------
            if (inputType === 'manual') {
              newList.push({
                ...base,
                pointName: `${node.label} - ${scope.scopeIdentifier}`,
                status: 'not_started'
              });
            }

            if (inputType === 'api') {
              newList.push({
                ...base,
                endpoint: scope.apiEndpoint || '',
                connectionStatus: scope.apiStatus ? 'connected' : 'not_connected',
                status: 'not_started'
              });
            }

            if (inputType === 'iot') {
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
      }

      return newList;
    };

    // ---------------------------------------------
    // 5️⃣ MERGE INPUT POINTS BY TYPE
    // ---------------------------------------------
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

    // ---------------------------------------------
    // 6️⃣ RECALCULATE COUNTS
    // ---------------------------------------------
    client.updateInputPointCounts('manual');
    client.updateInputPointCounts('api');
    client.updateInputPointCounts('iot');

    client.workflowTracking.dataInputPoints.lastSyncedWithFlowchart = new Date();

    // ---------------------------------------------
    // 7️⃣ TIMELINE ENTRY
    // ---------------------------------------------
    client.timeline.push({
      stage: client.stage,
      status: client.status,
      action: "Data input points synced from flowchart",
      performedBy: req.user.id,
      notes: `Manual: ${client.workflowTracking.dataInputPoints.manual.totalCount}, API: ${client.workflowTracking.dataInputPoints.api.totalCount}, IoT: ${client.workflowTracking.dataInputPoints.iot.totalCount}`
    });

    await client.save();

    // ---------------------------------------------
    // 8️⃣ RESPONSE
    // ---------------------------------------------
    const responseTime = Date.now() - startTime;

    return res.status(200).json({
      success: true,
      message: "Data input points synced successfully",
      data: {
        clientId: client.clientId,
        dataInputPoints: {
          manual: {
            total: client.workflowTracking.dataInputPoints.manual.totalCount,
            points: client.workflowTracking.dataInputPoints.manual.inputs
          },
          api: {
            total: client.workflowTracking.dataInputPoints.api.totalCount,
            points: client.workflowTracking.dataInputPoints.api.inputs
          },
          iot: {
            total: client.workflowTracking.dataInputPoints.iot.totalCount,
            points: client.workflowTracking.dataInputPoints.iot.inputs
          },
          totalDataPoints: client.workflowTracking.dataInputPoints.totalDataPoints,
          lastSyncedAt: client.workflowTracking.dataInputPoints.lastSyncedWithFlowchart
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
    // if(leadSource === 'sales Team'){
    //   if(!salesPersonName || !salesPersonEmployeeId) missingFields.push("salesPersonName or salesPersonEmployeeId")
    // }
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
     const seq = await Client.getNextClientSequence();      // 1, 2, 3, ...
    const clientId = Client.buildClientIdForStage(seq, "lead"); 

    // Create the new lead
    const newClient = new Client({
      clientId,
       clientSequenceNumber: seq, // 1, 2, 3, ...
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
// Submit Client Data (Stage 2)
// Submit Client Data (Stage 2)
const submitClientData = async (req, res) => {
  try {
    const { clientId } = req.params;

    // Body can be { submissionData: {...} } (new) or flat (old)
    const inbound = (req.body && (req.body.submissionData || req.body)) || {};

    // 1) Permission check
    if (!["consultant_admin", "consultant"].includes(req.user.userType)) {
      return res.status(403).json({
        message: "Only Consultants can submit client data",
      });
    }

    // 2) Basic sanity checks for required fields
    if (!inbound.companyInfo || !inbound.companyInfo.primaryContactPerson) {
      return res.status(400).json({
        success: false,
        message: "companyInfo.primaryContactPerson is required",
      });
    }

    const companyInfo = inbound.companyInfo;
    const primaryContactPerson = companyInfo.primaryContactPerson;

    // 3) Fetch client and check stage
    const client = await Client.findOne({ clientId });

    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    if (client.stage !== "registered") {
      return res.status(400).json({
        message: "Client is not in data submission stage",
      });
    }

    // 4) EMAIL VALIDATION (against User collection)
    const primaryContactEmail = primaryContactPerson.email || undefined;
    const leadInfoEmail = client.leadInfo?.email;

    const emailsToCheck = [
      ...new Set([primaryContactEmail, leadInfoEmail].filter(Boolean)),
    ];

    if (emailsToCheck.length > 0) {
      const existingUsers = await User.find({
        email: { $in: emailsToCheck },
      }).select("email userType clientId");

      if (existingUsers.length > 0) {
        const conflictDetails = existingUsers.map((user) => ({
          email: user.email,
          userType: user.userType,
          clientId: user.clientId,
        }));

        return res.status(409).json({
          message: "Email address already exists in user database",
          conflictingEmails: conflictDetails,
          details:
            "The following email(s) are already registered with existing users. Please use different email addresses or contact system administrator.",
        });
      }
    }

    // 5) NORMALIZE + VALIDATE assessmentLevel
    const normalizedLevels = normalizeAssessmentLevels(
      inbound.assessmentLevel
    );

    if (!normalizedLevels || normalizedLevels.length === 0) {
      return res.status(400).json({
        message:
          "assessmentLevel is required (allowed: reduction, decarbonization, organization, process)",
      });
    }

    const submissionPreview = {
      ...inbound,
      assessmentLevel: normalizedLevels,
    };

    const { errors } = validateSubmissionForLevels(
      submissionPreview,
      normalizedLevels
    );

    if (errors && errors.length) {
      return res.status(400).json({
        message: "Validation error",
        errors,
      });
    }

    // 6) MARK CLIENT AS SANDBOX HERE
    //    This is the missing piece: after data submission, the client becomes a sandbox client.
    client.sandbox = true;

    // If you want sandbox clients to be "inactive" in your access control,
    // uncomment this block (optional – depends on your business logic):
    //
    // if (client.accountDetails && typeof client.accountDetails.isActive === "boolean") {
    //   client.accountDetails.isActive = false;
    // }

    // 7) UPDATE submissionData on the client
    //    Keep schema field names EXACTLY as defined in Client.js:
    //    assessmentLevel, projectProfile, companyInfo, organizationalOverview,
    //    emissionsProfile, ghgDataManagement, additionalNotes, supportingDocuments, etc.
    client.submissionData = {
      // keep any existing internal fields if present (e.g. validationStatus, reviewNotes)
      ...(client.submissionData?.toObject?.() || client.submissionData || {}),
      ...inbound,
      assessmentLevel: normalizedLevels,
      submittedAt: new Date(),
      submittedBy: req.user.id,
    };

    // Recalculate dataCompleteness (uses submissionData.* fields)
    const dataCompleteness = client.calculateDataCompleteness();
client.submissionData.dataCompleteness = dataCompleteness;

// 8) Update status + timeline
    client.status = "submitted";

      // 🔹 NEW: make sure we have a sequence number
    if (!client.clientSequenceNumber) {
      // Try to parse from existing clientId (e.g. Lead_Greon001)
      const match = client.clientId && client.clientId.match(/(\d+)$/);
      if (match) {
        client.clientSequenceNumber = parseInt(match[1], 10);
      } else {
        // Fallback for very old data
        const seq = await Client.getNextClientSequence();
        client.clientSequenceNumber = seq;
      }
    }

    // 🔹 Update clientId to Sandbox_GreonXXX for this stage
    client.clientId = Client.buildClientIdForStage(
      client.clientSequenceNumber,
      "registered"
    );

     // 🔹 NEW: Sandbox ID (Stage 2)
    if (!client.sandboxClientId) {
      client.sandboxClientId = `Sandbox_${client.clientId}`;
    }

    client.submissionData.validationStatus = "validated";
    client.submissionData.validatedAt = new Date();
    client.submissionData.validatedBy = req.user.id;

    if (!client.timeline) client.timeline = [];

    client.timeline.push({
      stage: "registered",
      status: "submitted",
      action: "Data submitted",
      performedBy: req.user.id,
      notes: "Client data submission completed",
      timestamp: new Date(),
    });

    // Save the submission + sandbox flag on the client first
    await client.save();

    // 🔹 NEW STEP: create sandbox client_admin user when data submission is completed
    try {
      await createClientAdmin(client.clientId, {
        consultantId: req.user.id,
        sandbox: true, // ✅ this is a sandbox user
      });
    } catch (err) {
      console.warn(
        `createClientAdmin (sandbox, submitClientData) warning: ${err.message}`
      );
      // Do not block the main flow if user creation fails
    }

    // 9) Generate PDF + send email (non-blocking for main logic)
    try {
      const html = renderClientDataHTML(client);
      const pdf = await htmlToPdfBuffer(
        html,
        `ZeroCarbon_ClientData_${client.clientId}.pdf`
      );
      await sendClientDataSubmittedEmail(client, [pdf]);
      console.log("✉️ Client data submitted email sent with PDF.");
    } catch (e) {
      console.error("Email/PDF (submitClientData) error:", e.message);
    }

    // 10) Response
    return res.status(200).json({
      message: "Client data submitted successfully",
      client: {
        clientId: client.clientId,
        stage: client.stage,
        status: client.status,
        sandbox: client.sandbox,
      },
    });
  } catch (error) {
    console.error("Submit client data error:", error);
    return res.status(500).json({
      message: "Failed to submit client data",
      error: error.message,
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
// Accept / Reject Proposal and activate client
// Accept / Reject Proposal and activate client
const updateProposalStatus = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { action, reason, sandboxStatus } = req.body; // 🔹 NEW: sandboxStatus

    // Only consultant_admin can change proposal status
    if (req.user.userType !== "consultant_admin") {
      return res.status(403).json({
        message: "Only Consultant Admins can update proposal status",
      });
    }

    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    // Must be in proposal stage with a submitted proposal
    if (client.stage !== "proposal" || client.status !== "proposal_submitted") {
      return res.status(400).json({
        message: "No submitted proposal to act on for this client",
      });
    }

    // Ensure proposalData object exists
    if (!client.proposalData) {
      client.proposalData = {};
    }

    // ⬅️ Save the OLD clientId before we change it
    const oldClientId = client.clientId;

    // ==========================
    // ACCEPT FLOW
    // ==========================
    if (action === "accept") {
      // 1) Mark proposal as accepted (business meaning)
      client.status = "proposal_accepted";
      client.proposalData.clientApprovalDate = new Date();

      const approvedByName =
        client.submissionData?.companyInfo?.primaryContactPerson?.name ||
        client.leadInfo?.contactPersonName ||
        "Client Representative";

      client.proposalData.approvedBy = approvedByName;

      const prevStage = client.stage;

      // 2) Move to Active stage (as per your requirement)
      client.stage = "active";
      client.status = "active"; // 🔹 explicitly set active

      // 3) Build / keep sequence and generate ACTIVE clientId (GreonXXX)
      if (!client.clientSequenceNumber) {
        const match = client.clientId && client.clientId.match(/(\d+)$/);
        if (match) {
          client.clientSequenceNumber = parseInt(match[1], 10);
        } else {
          const seq = await Client.getNextClientSequence();
          client.clientSequenceNumber = seq;
        }
      }

      const newClientId = Client.buildClientIdForStage(
        client.clientSequenceNumber,
        "active"
      );
      client.clientId = newClientId;

      // 4) Sandbox handling (NEW LOGIC)
      //
      // - If sandboxStatus is provided (true/false) → override sandbox flag
      // - If sandboxStatus is NOT provided → DO NOT modify sandbox value
      if (typeof sandboxStatus === "boolean") {
        client.sandbox = sandboxStatus;
      }
      // (previously you had: client.sandbox = false; we removed that to respect sandboxStatus)

      // 5) Initialize / update account details for active subscription
      if (!client.accountDetails) {
        client.accountDetails = {};
      }

      client.accountDetails.subscriptionStartDate = new Date();
      client.accountDetails.subscriptionEndDate = moment()
        .add(1, "year")
        .toDate();
      client.accountDetails.subscriptionStatus = "active";
      client.accountDetails.isActive = true;

      // Keep existing counts if present, otherwise set defaults
      if (
        typeof client.accountDetails.activeUsers !== "number" ||
        client.accountDetails.activeUsers <= 0
      ) {
        client.accountDetails.activeUsers = 1;
      }
      if (typeof client.accountDetails.dataSubmissions !== "number") {
        client.accountDetails.dataSubmissions = 0;
      }

      // 6) Timeline entry
      client.timeline.push({
        stage: "active",
        status: "active",
        action: "Proposal accepted and account activated",
        performedBy: req.user.id,
        notes:
          reason ||
          (typeof sandboxStatus === "boolean"
            ? `Client activation; sandboxStatus = ${sandboxStatus}`
            : "Client subscription activated for 1 year"),
        timestamp: new Date(),
      });

      // 7) Save client FIRST (so newClientId is persistent)
      await client.save();

      // 8) Update references in all related collections
      //    - Users (sandbox → active, clientId updated)
      //    - Flowchart / ProcessFlowchart
      //    - Reduction
      //    - Decarbonization
      try {
        await updateClientIdReferencesOnActivation(
          oldClientId,
          newClientId,
          req.user.id,
          "proposal_accept"
        );
      } catch (err) {
        console.error(
          "updateClientIdReferencesOnActivation error:",
          err.message
        );
        // We don't fail the main request for this, but we log it.
      }

      // 9) Best-effort: create a client admin if needed
      try {
        await createClientAdmin(newClientId, {
          consultantId: req.user.id,
          sandbox: typeof sandboxStatus === "boolean" ? sandboxStatus : false,
        });
      } catch (err) {
        console.warn(`createClientAdmin warning: ${err.message}`);
      }

      // 10) Real-time events
      try {
        await emitClientStageChange(client, prevStage, req.user.id);
      } catch (err) {
        console.warn(`emitClientStageChange warning: ${err.message}`);
      }

      try {
        await emitClientListUpdate(client, "updated", req.user.id);
      } catch (err) {
        console.warn(`emitClientListUpdate warning: ${err.message}`);
      }

      // 11) Response
      return res.status(200).json({
        message: "Proposal accepted and client account activated",
        client: {
          clientId: client.clientId,
          stage: client.stage,
          status: client.accountDetails.subscriptionStatus,
          subscriptionEndDate: client.accountDetails.subscriptionEndDate,
          sandbox: client.sandbox,
        },
      });
    }

    // ==========================
    // REJECT FLOW
    // ==========================
    else if (action === "reject") {
      client.status = "proposal_rejected";
      client.proposalData.rejectionReason = reason;

      client.timeline.push({
        stage: "proposal",
        status: "proposal_rejected",
        action: "Proposal rejected",
        performedBy: req.user.id,
        notes: reason || "Client rejected the proposal",
        timestamp: new Date(),
      });

      await client.save();

      try {
        await emitClientListUpdate(client, "updated", req.user.id);
      } catch (err) {
        console.warn(`emitClientListUpdate warning: ${err.message}`);
      }

      return res.status(200).json({
        message: "Proposal rejected",
        client: {
          clientId: client.clientId,
          stage: client.stage,
          status: client.status,
          sandbox: client.sandbox,
        },
      });
    }

    // ==========================
    // INVALID ACTION
    // ==========================
    else {
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






// ===============================================
// FINAL FULL VERSION OF getClients WITH FILTERS
// ===============================================

// ===============================================
// FINAL FIXED VERSION OF getClients (S3 SAFE)
// ===============================================
const getClients = async (req, res) => {
  try {
    const {
      stage,
      status,
      sandbox,
      isActive,
      validationStatus,
      subscriptionStatus,
      flowchartStatus,
      processFlowchartStatus,
      reductionStatus,
      hasAssignedConsultant,
      search,
      sortBy = "createdAt",
      sortOrder = "desc",
      page = 1,
      limit = 10
    } = req.query;

    let query = { isDeleted: false };

    // -----------------------------------------------
    // 1. USER PERMISSIONS
    // -----------------------------------------------
    switch (req.user.userType) {
      case "super_admin":
        break;

      case "consultant_admin": {
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
      }

      case "consultant":
        query.$or = [
          { "leadInfo.assignedConsultantId": req.user.id },
          { "workflowTracking.assignedConsultantId": req.user.id }
        ];
        break;

      case "client_admin":
      case "client_employee_head":
      case "employee":
      case "auditor":
      case "viewer":
        query.clientId = req.user.clientId;
        break;

      default:
        return res.status(403).json({
          success: false,
          message: "Unauthorized"
        });
    }

    // -----------------------------------------------
    // 2. APPLY FILTERS
    // -----------------------------------------------
    if (stage) query.stage = stage;
    if (status) query.status = status;

    if (sandbox === "true") query.sandbox = true;
    if (sandbox === "false") query.sandbox = false;

    if (isActive === "true") query["accountDetails.isActive"] = true;
    if (isActive === "false") query["accountDetails.isActive"] = false;

    if (validationStatus)
      query["submissionData.validationStatus"] = validationStatus;

    if (subscriptionStatus)
      query["accountDetails.subscriptionStatus"] = subscriptionStatus;

    if (flowchartStatus)
      query["workflowTracking.flowchartStatus"] = flowchartStatus;

    if (processFlowchartStatus)
      query["workflowTracking.processFlowchartStatus"] = processFlowchartStatus;

    if (reductionStatus)
      query["workflowTracking.reduction.status"] = reductionStatus;

    if (hasAssignedConsultant === "true")
      query["leadInfo.hasAssignedConsultant"] = true;

    if (hasAssignedConsultant === "false")
      query["leadInfo.hasAssignedConsultant"] = false;

    // -----------------------------------------------
    // 3. SEARCH
    // -----------------------------------------------
    if (search) {
      const regex = new RegExp(search, "i");
      query.$and = [
        ...(query.$and || []),
        {
          $or: [
            { clientId: regex },
            { "leadInfo.companyName": regex },
            { "leadInfo.contactPersonName": regex },
            { "leadInfo.email": regex },
            { "leadInfo.mobileNumber": regex }
          ]
        }
      ];
    }

    // -----------------------------------------------
    // 4. SORT + PAGINATION
    // -----------------------------------------------
    const sortOptions = { [sortBy]: sortOrder === "asc" ? 1 : -1 };
    const skip = (page - 1) * limit;
    const total = await Client.countDocuments(query);

    // -----------------------------------------------
    // 5. FETCH CLIENTS (IMPORTANT FIX HERE)
    // -----------------------------------------------
    const clients = await Client.find(query)
      .populate("leadInfo.consultantAdminId", "userName email profileImage")
      .populate("leadInfo.assignedConsultantId", "userName email profileImage")
      .populate("workflowTracking.assignedConsultantId", "userName email profileImage")
      .sort(sortOptions)
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const BASE = process.env.SERVER_BASE_URL?.replace(/\/+$/, "");

    // -----------------------------------------------
    // 6. FORMAT RESPONSE + 🔥 IMAGE FIX
    // -----------------------------------------------
    const responseClients = clients.map(client => {
      const normalizeUser = (user) => {
        if (!user) return null;

        // ✅ Keep S3 URL untouched
        if (user.profileImage?.url) return user;

        // ⚠ legacy local image support
        if (user.profileImage?.path && BASE) {
          user.profileImage.url =
            `${BASE}/${user.profileImage.path.replace(/\\/g, "/")}`;
        }

        return user;
      };

      return {
        _id: client._id,
        clientId: client.clientId,
        stage: client.stage,
        status: client.status,
        sandbox: client.sandbox,

        leadInfo: {
          ...client.leadInfo,
          consultantAdmin: normalizeUser(client.leadInfo.consultantAdminId),
          assignedConsultant: normalizeUser(client.leadInfo.assignedConsultantId)
        },

        workflowTracking: {
          ...client.workflowTracking,
          assignedConsultant: normalizeUser(
            client.workflowTracking.assignedConsultantId
          )
        },

        submissionData: client.submissionData || {},
        accountDetails: client.accountDetails || {},

        createdAt: client.createdAt,
        updatedAt: client.updatedAt
      };
    });

    // -----------------------------------------------
    // 7. RESPONSE
    // -----------------------------------------------
    return res.status(200).json({
      success: true,
      message: "Clients fetched successfully",
      clients: responseClients,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page < Math.ceil(total / limit),
        hasPrevPage: page > 1
      }
    });

  } catch (error) {
    console.error("Get Clients Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch clients",
      error: error.message
    });
  }
};






// ===============================================
// FIXED getClientById (S3 PROFILE IMAGE SAFE)
// ===============================================
const getClientById = async (req, res) => {
  try {
    const { clientId } = req.params;

    const client = await Client.findOne({ clientId })
      .populate("leadInfo.consultantAdminId", "userName email profileImage")
      .populate("leadInfo.assignedConsultantId", "userName email profileImage")
      .populate("workflowTracking.assignedConsultantId", "userName email profileImage")
      .populate("timeline.performedBy", "userName email profileImage")
      .lean();

    if (!client) {
      return res.status(404).json({
        success: false,
        message: "Client not found"
      });
    }

    // ------------------------------------------------
    // PERMISSION CHECK
    // ------------------------------------------------
    let hasAccess = false;

    switch (req.user.userType) {
      case "super_admin":
        hasAccess = true;
        break;

      case "consultant_admin":
        hasAccess =
          client.leadInfo.consultantAdminId?._id.toString() === req.user.id;
        break;

      case "consultant":
        hasAccess =
          client.leadInfo.assignedConsultantId?._id.toString() === req.user.id ||
          client.workflowTracking.assignedConsultantId?._id.toString() === req.user.id;
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
        success: false,
        message: "You don't have permission to view this client"
      });
    }

    // ------------------------------------------------
    // 🔥 PROFILE IMAGE FIX (CRITICAL)
    // ------------------------------------------------
    const BASE = process.env.SERVER_BASE_URL?.replace(/\/+$/, "");

    const normalizeUser = (user) => {
      if (!user) return null;

      // ✅ S3 URL → DO NOT TOUCH
      if (user.profileImage?.url) return user;

      // ⚠ legacy local image
      if (user.profileImage?.path && BASE) {
        user.profileImage.url =
          `${BASE}/${user.profileImage.path.replace(/\\/g, "/")}`;
      }

      return user;
    };

    if (client.leadInfo) {
      client.leadInfo.consultantAdminId =
        normalizeUser(client.leadInfo.consultantAdminId);

      client.leadInfo.assignedConsultantId =
        normalizeUser(client.leadInfo.assignedConsultantId);
    }

    if (client.workflowTracking) {
      client.workflowTracking.assignedConsultantId =
        normalizeUser(client.workflowTracking.assignedConsultantId);
    }

    if (Array.isArray(client.timeline)) {
      client.timeline = client.timeline.map(t => ({
        ...t,
        performedBy: normalizeUser(t.performedBy)
      }));
    }

    // ------------------------------------------------
    // RESPONSE
    // ------------------------------------------------
    return res.status(200).json({
      success: true,
      message: "Client details fetched successfully",
      client
    });

  } catch (error) {
    console.error("Get client by ID error:", error);
    return res.status(500).json({
      success: false,
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
// Supports actions: suspend, reactivate, renew, extend
// - consultant: can request suspend / reactivate (creates pending request)
// - consultant_admin / super_admin: can directly suspend/reactivate/renew/extend
//   and also implicitly approve matching pending requests
const manageSubscription = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { action, reason, extensionDays } = req.body;

    const actor = req.user;
    const actorType = actor.userType;

    // 1) Validate action
    const allowedActions = ["suspend", "reactivate", "renew", "extend"];
    if (!allowedActions.includes(action)) {
      return res.status(400).json({
        message: "Invalid action. Use: suspend, reactivate, renew, or extend",
      });
    }

    // 2) Load client
    const client = await Client.findOne({
      clientId,
      isDeleted: { $ne: true },
    });

    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    if (client.stage !== "active") {
      return res.status(400).json({
        message: "Subscription actions are only allowed for clients in Active stage",
      });
    }

    const msPerDay = 24 * 60 * 60 * 1000;
    const now = new Date();
    const pending = client.accountDetails.pendingSubscriptionRequest || null;

    // Helper to approve a matching pending request
    const approveMatchingPendingRequest = () => {
      if (!pending || pending.status !== "pending") return;

      // Approve if:
      // - admin performs same action, OR
      // - admin performs 'renew' when consultant requested 'reactivate'
      const isMatch =
        pending.action === action ||
        (action === "renew" && pending.action === "reactivate");

      if (!isMatch) return;

      pending.status = "approved";
      pending.reviewedBy = actor._id;
      pending.reviewedAt = new Date();
      pending.reviewComment = reason || "";
    };

    // 3) Consultant FLOW – can only create requests
    if (actorType === "consultant") {
      if (!["suspend", "reactivate"].includes(action)) {
        return res.status(403).json({
          message:
            "Consultants can only request suspension or reactivation. Renew/extend can be done by Consultant Admin.",
        });
      }

      // Do not allow multiple pending requests
      if (pending && pending.status === "pending") {
        return res.status(400).json({
          message:
            "There is already a pending subscription request for this client.",
          pendingRequest: pending,
        });
      }

      // Create new pending request
      client.accountDetails.pendingSubscriptionRequest = {
        action,
        status: "pending",
        reason:
          reason ||
          (action === "suspend"
            ? "Consultant requested subscription suspension"
            : "Consultant requested subscription reactivation"),
        requestedBy: actor._id,
        requestedAt: new Date(),
        reviewedBy: undefined,
        reviewedAt: undefined,
        reviewComment: undefined,
      };

      client.timeline.push({
        stage: client.stage,
        status: client.status,
        action:
          action === "suspend"
            ? "Subscription suspension requested"
            : "Subscription reactivation requested",
        performedBy: actor._id,
        notes: reason || "",
      });

      await client.save();

      return res.status(202).json({
        message: `Subscription ${action} request has been sent to Consultant Admin.`,
        pendingRequest: client.accountDetails.pendingSubscriptionRequest,
      });
    }

    // 4) Admin FLOW – consultant_admin / super_admin can apply actions directly
    if (!["consultant_admin", "super_admin"].includes(actorType)) {
      return res.status(403).json({
        message:
          "Only Consultant Admin and Super Admin can directly manage subscriptions.",
      });
    }

    // For admin we apply actual state changes
    switch (action) {
      case "suspend": {
        // Already suspended?
        if (client.accountDetails.subscriptionStatus === "suspended") {
          return res
            .status(400)
            .json({ message: "Subscription is already suspended." });
        }

        client.accountDetails.subscriptionStatus = "suspended";
        client.accountDetails.isActive = false;
        client.accountDetails.suspensionReason =
          reason || "Suspended by admin";
        client.accountDetails.suspendedBy = actor._id;
        client.accountDetails.suspendedAt = now;
        client.status = "suspended";

        approveMatchingPendingRequest();

        client.timeline.push({
          stage: client.stage,
          status: client.status,
          action: "Subscription suspended",
          performedBy: actor._id,
          notes: reason || "Subscription suspended by admin",
        });
        break;
      }

      case "reactivate": {
        if (
          client.accountDetails.subscriptionStatus === "active" &&
          client.accountDetails.isActive
        ) {
          return res
            .status(400)
            .json({ message: "Subscription is already active." });
        }

        // Reactivate without touching dates
        client.accountDetails.subscriptionStatus = "active";
        client.accountDetails.isActive = true;
        client.accountDetails.suspensionReason = undefined;
        client.accountDetails.suspendedBy = undefined;
        client.accountDetails.suspendedAt = undefined;
        client.status = "active";

        approveMatchingPendingRequest();

        client.timeline.push({
          stage: client.stage,
          status: client.status,
          action: "Subscription reactivated",
          performedBy: actor._id,
          notes: reason || "Subscription reactivated by admin",
        });
        break;
      }

      case "renew": {
        // Renew means: start a fresh cycle from today (or keep existing start if you prefer)
        const days =
          Number.isFinite(Number(extensionDays)) && Number(extensionDays) > 0
            ? Number(extensionDays)
            : 365; // default 1 year if not sent

        const newStart = now;
        const newEnd = new Date(now.getTime() + days * msPerDay);

        client.accountDetails.subscriptionStartDate = newStart;
        client.accountDetails.subscriptionEndDate = newEnd;
        client.accountDetails.subscriptionStatus = "active";
        client.accountDetails.isActive = true;
        client.status = "renewed";

        approveMatchingPendingRequest(); // this will also approve a pending "reactivate" request

        client.timeline.push({
          stage: client.stage,
          status: client.status,
          action: "Subscription renewed",
          performedBy: actor._id,
          notes:
            reason ||
            `Subscription renewed for ${days} days (until ${newEnd.toISOString()})`,
        });
        break;
      }

      case "extend": {
        if (!client.accountDetails.subscriptionEndDate) {
          return res.status(400).json({
            message:
              "Cannot extend subscription because subscriptionEndDate is not set.",
          });
        }

        const days = Number(extensionDays);
        if (!Number.isFinite(days) || days <= 0) {
          return res.status(400).json({
            message:
              "extensionDays must be a positive number when using action 'extend'.",
          });
        }

        const currentEnd = client.accountDetails.subscriptionEndDate;
        const newEnd = new Date(currentEnd.getTime() + days * msPerDay);

        client.accountDetails.subscriptionEndDate = newEnd;

        // If previously expired, you might want to bring it back to active
        if (client.accountDetails.subscriptionStatus === "expired") {
          client.accountDetails.subscriptionStatus = "active";
          client.accountDetails.isActive = true;
          client.status = "active";
        }

        approveMatchingPendingRequest();

        client.timeline.push({
          stage: client.stage,
          status: client.status,
          action: "Subscription extended",
          performedBy: actor._id,
          notes:
            reason ||
            `Subscription extended by ${days} days (until ${newEnd.toISOString()})`,
        });
        break;
      }

      default:
        return res.status(400).json({ message: "Unsupported action" });
    }

    // Save all changes
    await client.save();

    return res.status(200).json({
      message: `Subscription ${action} action completed successfully.`,
      client: {
        clientId: client.clientId,
        stage: client.stage,
        status: client.status,
        accountDetails: client.accountDetails,
      },
    });
  } catch (err) {
    console.error("manageSubscription error:", err);
    return res.status(500).json({
      message: "Failed to manage subscription",
      error: err.message,
    });
  }
};




const getPendingSubscriptionApprovals = async (req, res) => {
  try {
    if (!["consultant_admin", "super_admin"].includes(req.user.userType)) {
      return res.status(403).json({
        message:
          "Only Consultant Admin and Super Admin can view pending subscription approvals",
      });
    }

    const clients = await Client.find({
      stage: "active",
      "accountDetails.pendingSubscriptionRequest.status": "pending",
    })
      .populate(
        "accountDetails.pendingSubscriptionRequest.requestedBy",
        "userName email userType"
      )
      .select(
        "clientId stage status leadInfo.companyName accountDetails.subscriptionStatus accountDetails.subscriptionEndDate accountDetails.pendingSubscriptionRequest"
      );

    const requests = clients.map((c) => {
      const reqObj = c.accountDetails.pendingSubscriptionRequest || {};
      return {
        clientId: c.clientId,
        companyName: c.leadInfo?.companyName,
        stage: c.stage,
        status: c.status,
        subscriptionStatus: c.accountDetails.subscriptionStatus,
        subscriptionEndDate: c.accountDetails.subscriptionEndDate,
        pendingRequest: {
          action: reqObj.action,
          status: reqObj.status,
          reason: reqObj.reason,
          requestedAt: reqObj.requestedAt,
          requestedBy: reqObj.requestedBy,
        },
      };
    });

    return res.status(200).json({
      count: requests.length,
      requests,
    });
  } catch (err) {
    console.error("getPendingSubscriptionApprovals error:", err);
    return res.status(500).json({
      message: "Failed to fetch pending subscription approvals",
      error: err.message,
    });
  }
};



const getClientsExpiringSoon = async (req, res) => {
  try {
    // Consultant, Consultant Admin and Super Admin can view expiring subscriptions
    if (
      !["consultant", "consultant_admin", "super_admin"].includes(
        req.user.userType
      )
    ) {
      return res.status(403).json({
        message:
          "Only Consultant, Consultant Admin and Super Admin can view expiring subscriptions",
      });
    }

    const days = parseInt(req.query.days, 10) || 30; // default 30 days
    const now = moment().startOf("day");
    const windowEnd = moment().add(days, "days").endOf("day");

    const clients = await Client.find({
      stage: "active",
      "accountDetails.subscriptionEndDate": {
        $gte: now.toDate(),
        $lte: windowEnd.toDate(),
      },
      "accountDetails.subscriptionStatus": { $in: ["active", "grace_period"] },
    })
      .populate("accountDetails.clientAdminId", "userName email")
      .select(
        "clientId stage status leadInfo.companyName accountDetails.subscriptionStatus accountDetails.subscriptionEndDate accountDetails.clientAdminId"
      );

    const result = clients.map((c) => {
      const endDate = c.accountDetails.subscriptionEndDate;
      const daysRemaining = moment(endDate).diff(now, "days");

      return {
        clientId: c.clientId,
        companyName: c.leadInfo?.companyName,
        stage: c.stage,
        status: c.status,
        subscriptionStatus: c.accountDetails.subscriptionStatus,
        subscriptionEndDate: endDate,
        daysRemaining,
        clientAdmin: c.accountDetails.clientAdminId
          ? {
              id: c.accountDetails.clientAdminId._id,
              userName: c.accountDetails.clientAdminId.userName,
              email: c.accountDetails.clientAdminId.email,
            }
          : null,
      };
    });

    return res.status(200).json({
      daysWindow: days,
      count: result.length,
      clients: result,
    });
  } catch (err) {
    console.error("getClientsExpiringSoon error:", err);
    return res.status(500).json({
      message: "Failed to fetch expiring subscriptions",
      error: err.message,
    });
  }
};



const checkUpcomingSubscriptionExpiries = async (daysBefore = 30) => {
  try {
    const now = moment();
    const windowEnd = moment().add(daysBefore, "days").endOf("day");

    const expiringClients = await Client.find({
      stage: "active",
      "accountDetails.subscriptionEndDate": {
        $gt: now.toDate(),
        $lte: windowEnd.toDate()
      },
      "accountDetails.subscriptionStatus": { $in: ["active", "grace_period"] },
      "accountDetails.subscriptionExpiryWarningSentFor30Days": { $ne: true }
    })
      .populate("accountDetails.clientAdminId", "userName email userType")
      .populate("assignedConsultantId", "userName email userType");

    const consultantAdmins = await User.find({
      userType: "consultant_admin",
      isActive: true
    }).select("_id userName email");

    for (const client of expiringClients) {
      const endDate = moment(client.accountDetails.subscriptionEndDate);
      const daysLeft = endDate.diff(now, "days");

      const targetUserIds = [];

      // Client Admin
      if (client.accountDetails.clientAdminId) {
        targetUserIds.push(client.accountDetails.clientAdminId._id);
      }

      // Assigned Consultant
      if (client.assignedConsultantId) {
        targetUserIds.push(client.assignedConsultantId._id);
      }

      // All Consultant Admins
      for (const admin of consultantAdmins) {
        targetUserIds.push(admin._id);
      }

      if (targetUserIds.length === 0) {
        continue;
      }

      try {
        const notif = new Notification({
          title: `Subscription Expiry Warning – ${client.clientId}`,
          message: `
The subscription for client ${client.clientId} (${client.leadInfo?.companyName || "Unknown Company"}) is going to expire in approximately ${daysLeft} day(s).

Current end date: ${endDate.format("DD/MM/YYYY")}

Please take necessary action (renew or extend the subscription) before expiry.
          `.trim(),
          priority: "high",
          createdBy: null,
          creatorType: "system",
          targetUsers: targetUserIds,
          targetClients: [client.clientId],
          status: "published",
          publishedAt: new Date(),
          isSystemNotification: true,
          systemAction: "subscription_expiry_warning",
          relatedEntity: {
            type: "client",
            id: client._id
          }
        });

        await notif.save();

        if (global.io && global.broadcastNotification) {
          try {
            await global.broadcastNotification(notif);
          } catch (broadcastErr) {
            console.error("Warning: could not broadcast expiry warning notification:", broadcastErr);
          }
        }
      } catch (notifErr) {
        console.error("Warning: could not create expiry warning notification:", notifErr);
      }

      // Mark warning as sent to avoid duplicate
      client.accountDetails.subscriptionExpiryWarningSentFor30Days = true;
      await client.save();
    }

    console.log(`Processed ${expiringClients.length} upcoming subscription expiries (within ${daysBefore} days).`);

  } catch (error) {
    console.error("checkUpcomingSubscriptionExpiries error:", error);
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



/**
 * 🚨 HARD RESET CLIENT SYSTEM
 * Deletes ALL clients and resets ID counter
 */
/**
 * 🚨 HARD RESET CLIENT SYSTEM
 * Deletes ALL clients so next clientId starts from beginning
 */
const hardResetClientSystem = async (req, res) => {
  try {
    if (!req.user || req.user.userType !== 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Only Super Admin can perform this action'
      });
    }

    const { confirm } = req.body;

    if (confirm !== 'DELETE_ALL_CLIENTS_AND_RESET') {
      return res.status(400).json({
        success: false,
        message:
          "Confirmation required. Pass confirm = 'DELETE_ALL_CLIENTS_AND_RESET'"
      });
    }

    const Client = require('../models/CMS/Client');

    await Client.hardResetClientSystem(req.user);

    return res.status(200).json({
      success: true,
      message:
        'Client system reset complete. Next client will start from beginning.',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Hard reset error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to reset client system',
      error:
        process.env.NODE_ENV === 'development' ? error.message : undefined
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
  getPendingSubscriptionApprovals,
  getClientsExpiringSoon,  
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
  updateAssessmentLevelOnly,
  hardResetClientSystem
};