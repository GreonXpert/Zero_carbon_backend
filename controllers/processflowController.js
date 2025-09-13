// controllers/processflowController.js
const ProcessFlowchart = require('../models/ProcessFlowchart');
const Client = require('../models/Client');
const User = require('../models/User');
const mongoose = require('mongoose');
const Notification = require('../models/Notification')

// Import helper functions
const {
  validateScopeDetails,
  normalizeNodes,
  normalizeEdges,
  createChartNotifications,
  isChartAvailable,
  getChartUnavailableMessage
} = require('../utils/chart/chartHelpers');


// Import existing permission and workflow functions
const {autoUpdateProcessFlowchartStatus}  = require('../utils/Workflow/workflow');
const {canManageProcessFlowchart, canAssignHeadToNode} = require('../utils/Permissions/permissions');



// Enhanced validation for scope details (excerpt from flowchartController.js)
// const validateScopeDetails = (scopeDetails, nodeId) => {
//   if (!Array.isArray(scopeDetails)) {
//     throw new Error("scopeDetails must be an array");
//   }

//   // Check for unique identifiers within this node
//   const identifiers = new Set();
//   const scopeTypeCounts = {
//     'Scope 1': 0,
//     'Scope 2': 0,
//     'Scope 3': 0
//   };
  
//   scopeDetails.forEach((scope, index) => {
//     // Check required common fields
//     if (!scope.scopeIdentifier || scope.scopeIdentifier.trim() === '') {
//       throw new Error(`Scope at index ${index} must have a scopeIdentifier (unique name)`);
//     }
    
//     if (identifiers.has(scope.scopeIdentifier)) {
//       throw new Error(`Duplicate scopeIdentifier "${scope.scopeIdentifier}" in node ${nodeId}`);
//     }
//     identifiers.add(scope.scopeIdentifier);

//     if (!scope.scopeType) {
//       throw new Error(`Scope "${scope.scopeIdentifier}" must have a scopeType`);
//     }

//     if (!['Scope 1', 'Scope 2', 'Scope 3'].includes(scope.scopeType)) {
//       throw new Error(`Invalid scopeType "${scope.scopeType}" for scope "${scope.scopeIdentifier}"`);
//     }

//     if (!scope.inputType) {
//       throw new Error(`Scope "${scope.scopeIdentifier}" must have an inputType (manual/IOT/API)`);
//     }

//     if (!['manual', 'IOT', 'API'].includes(scope.inputType)) {
//       throw new Error(`Invalid inputType "${scope.inputType}" for scope "${scope.scopeIdentifier}". Must be manual, IOT, or API`);
//     }

//     // Count scope types
//     scopeTypeCounts[scope.scopeType]++;

//     // Validate based on scope type
//     switch (scope.scopeType) {
//       case "Scope 1":
//         if (!scope.emissionFactor || !scope.categoryName || !scope.activity || !scope.fuel || !scope.units) {
//           throw new Error(`Scope 1 "${scope.scopeIdentifier}" requires: emissionFactor, categoryName, activity, fuel, units`);
//         }
        
//         // Updated validation to include Custom and other emission factors
//         if (!['IPCC', 'DEFRA', 'EPA', 'EmissionFactorHub', 'Custom'].includes(scope.emissionFactor)) {
//           throw new Error(`Scope 1 "${scope.scopeIdentifier}" emissionFactor must be one of: IPCC, DEFRA, EPA, EmissionFactorHub, or Custom`);
//         }

//         // Validate custom emission factor if selected
//              if (scope.emissionFactor === 'Custom') {
//         // must exist inside emissionFactorValues.customEmissionFactor
//         const cef = scope.emissionFactorValues?.customEmissionFactor;
//         if (!cef || typeof cef !== 'object') {
//           throw new Error(
//             `Scope 1 "${scope.scopeIdentifier}" with Custom emission factor `
//              `must have an emissionFactorValues.customEmissionFactor object`
//           );
//         }

//         // if they supply any numeric field, ensure it's non-negative
//         ['CO2','CH4','N2O','CO2e','leakageRate','Gwp_refrigerant'].forEach(key => {
//           const v = cef[key];
//           if (v != null && (typeof v !== 'number' || v < 0)) {
//             throw new Error(
//               `Scope 1 "${scope.scopeIdentifier}" `
//                `emissionFactorValues.customEmissionFactor.${key} `
//                `must be a non-negative number`
//             );
//           }
//         });
//       }


//         // Validate API endpoint if API input type
//         if (scope.inputType === 'API' && !scope.apiEndpoint) {
//           throw new Error(`Scope 1 "${scope.scopeIdentifier}" with API input type must have apiEndpoint`);
//         }

//         // Validate IOT device ID if IOT input type
//         if (scope.inputType === 'IOT' && !scope.iotDeviceId) {
//           throw new Error(`Scope 1 "${scope.scopeIdentifier}" with IOT input type must have iotDeviceId`);
//         }
//         break;

//       case "Scope 2":
//         if (!scope.country || !scope.regionGrid) {
//           throw new Error(`Scope 2 "${scope.scopeIdentifier}" requires: country, regionGrid`);
//         }
        
//         if (scope.electricityUnit && !['kWh', 'MWh', 'GWh'].includes(scope.electricityUnit)) {
//           throw new Error(`Invalid electricity unit "${scope.electricityUnit}" for scope "${scope.scopeIdentifier}"`);
//         }

//         // Validate API/IOT fields if applicable
//         if (scope.inputType === 'API' && !scope.apiEndpoint) {
//           throw new Error(`Scope 2 "${scope.scopeIdentifier}" with API input type must have apiEndpoint`);
//         }

//         if (scope.inputType === 'IOT' && !scope.iotDeviceId) {
//           throw new Error(`Scope 2 "${scope.scopeIdentifier}" with IOT input type must have iotDeviceId`);
//         }
//         break;

//       case "Scope 3":
//         if (!scope.categoryName || !scope.activity  ) {
//           throw new Error(`Scope 3 "${scope.scopeIdentifier}" requires: category and activity`);
//         }

//         // Validate API fields if applicable (Scope 3 typically doesn't use IOT)
//         if (scope.inputType === 'API' && !scope.apiEndpoint) {
//           throw new Error(`Scope 3 "${scope.scopeIdentifier}" with API input type must have apiEndpoint`);
//         }
//         break;

//       default:
//         throw new Error(`Invalid scopeType: ${scope.scopeType}`);
//     }
//   });

//   return {
//     isValid: true,
//     counts: scopeTypeCounts,
//     totalScopes: scopeDetails.length
//   };
// };

// Save or update process flowchart
const saveProcessFlowchart = async (req, res) => {
  try {
    const { clientId, flowchartData } = req.body;
    
    // 0) Check if user is authenticated and has required fields
    if (!req.user || (!req.user._id && !req.user.id)) {
      return res.status(401).json({
        message: 'Authentication required - user information missing'
      });
    }

    // Ensure we have a consistent userId
    const userId = req.user._id || req.user.id;

    // 1) Basic request validation
    if (!clientId || !flowchartData || !Array.isArray(flowchartData.nodes)) {
      return res.status(400).json({ 
        message: 'Missing required fields: clientId or flowchartData.nodes' 
      });
    }

    // 2) Check if client exists and is active
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: 'Client not found' });
    }
    if (client.stage !== 'active') {
      return res.status(400).json({ 
        message: 'Process flowcharts can only be created for active clients' 
      });
    }

    // 3) Check process flowchart availability based on assessment level
    const assessmentLevel = client.submissionData?.assessmentLevel || 'both';
    if (!isChartAvailable(assessmentLevel, 'processFlowchart')) {
      return res.status(403).json(getChartUnavailableMessage(assessmentLevel, 'processFlowchart'));
    }

    // 4) Auto-update client workflow status when consultant starts creating process flowchart
    if (['consultant', 'consultant_admin'].includes(req.user.userType)) {
      await autoUpdateProcessFlowchartStatus(clientId, userId);
    }

    // 5) Check if user can manage this client's process flowchart
    const canManage = await canManageProcessFlowchart(req.user, clientId);
    if (!canManage) {
      return res.status(403).json({ 
        message: 'You do not have permission to manage process flowcharts for this client' 
      });
    }

    // 6) Normalize nodes based on assessmentLevel
    const normalizedNodes = normalizeNodes(flowchartData.nodes, assessmentLevel, 'processFlowchart');

    // 7) Normalize edges - The schema allows for many edges per node.
    const normalizedEdges = normalizeEdges(flowchartData.edges);

    // 8) Find existing or create new
    let processFlowchart = await ProcessFlowchart.findOne({ 
      clientId, 
      isDeleted: false 
    });

    let isNew = false;

    if (processFlowchart) {
      // Update existing
      processFlowchart.nodes = normalizedNodes;
      processFlowchart.edges = normalizedEdges;
      processFlowchart.lastModifiedBy = userId;
      processFlowchart.version = (processFlowchart.version || 0) + 1;
    } else {
      // Create new
      isNew = true;
      processFlowchart = new ProcessFlowchart({
        clientId,
        nodes: normalizedNodes,
        edges: normalizedEdges,
        createdBy: userId,
        creatorType: req.user.userType,
        lastModifiedBy: userId,
        assessmentLevel, // Store assessment level for reference
        version: 1
      });
    }

    // The .save() call will now automatically trigger the pre-save hook in the model
    await processFlowchart.save();

    // 9) Auto-start flowchart status
    if (['consultant', 'consultant_admin'].includes(req.user.userType) && isNew) {
      await Client.findOneAndUpdate(
        { clientId },
        { 
          $set: {
            'workflowTracking.processFlowchartStatus': 'on_going',
            'workflowTracking.processFlowchartStartedAt': new Date()
          }
        }
      );
    }

    // 10) Send notifications to all client_admins of this client
    await createChartNotifications(User, Notification, {
      clientId,
      userId,
      userType: req.user.userType,
      userName: req.user.userName,
      isNew,
      chartType: 'processFlowchart',
      chartId: processFlowchart._id
    });

    // 11) Prepare response based on assessmentLevel
    const responseData = {
      clientId: processFlowchart.clientId,
      nodes: processFlowchart.nodes,
      edges: processFlowchart.edges,
      assessmentLevel: assessmentLevel,
      version: processFlowchart.version,
      createdAt: processFlowchart.createdAt,
      updatedAt: processFlowchart.updatedAt
    };

    if (assessmentLevel === 'process') {
      responseData.hasFullScopeDetails = true;
      responseData.message = 'Process flowchart saved with complete scope details (flowchart not available for this assessment level)';
    } else if (assessmentLevel === 'both') {
      responseData.hasFullScopeDetails = false;
      responseData.message = 'Process flowchart saved with basic details only (full scope details available in flowchart)';
    }

    res.status(isNew ? 201 : 200).json({ 
      message: isNew ? 'Process flowchart created successfully' : 'Process flowchart updated successfully',
      flowchart: responseData
    });

  } catch (error) {
    console.error('Save process flowchart error:', error);
    
    // ** UPDATED ERROR HANDLING **
    // The pre-save hook will throw an error that gets caught here.
    // We can check for the custom status code we set.
    if (error.statusCode === 400) {
        return res.status(400).json({
            message: 'Process flowchart validation failed.',
            error: error.message
        });
    }

    if (error.code === 11000) {
      return res.status(400).json({
        message: 'Duplicate key error - check for duplicate identifiers',
        error: error.message,
        details: 'This might be caused by duplicate edge IDs or scope identifiers'
      });
    }

    res.status(500).json({ 
      message: 'Failed to save process flowchart', 
      error: error.message 
    });
  }
};

// Get process flowchart by clientId
// Get process flowchart by clientId
const getProcessFlowchart = async (req, res) => {
  try {
    const { clientId } = req.params;

    if (!clientId) {
      return res.status(400).json({ message: 'clientId is required' });
    }

    // ---------- 1) Permission gate ----------
    // We allow read for limited roles (same client), full access for admins/consultants/client_admin
    const userType = req.user.userType;
    const userClientId = req.user.clientId || req.user.client_id;
    const userId = (req.user.id || req.user._id || '').toString();

    let allowed = false;
    let fullAccess = false;

    if (userType === 'super_admin') {
      allowed = true; fullAccess = true;
    } else if (['consultant_admin', 'consultant'].includes(userType)) {
      // If your canManageProcessFlowchart returns boolean "can manage", treat that as fullAccess
      const canManage = await canManageProcessFlowchart(req.user, clientId);
      allowed = !!canManage;
      fullAccess = !!canManage;
    } else if (userType === 'client_admin') {
      allowed = (userClientId && userClientId.toString() === clientId.toString());
      fullAccess = allowed;
    } else if (['client_employee_head', 'employee', 'auditor', 'viewer'].includes(userType)) {
      // Read-only if they belong to the same client; further filtering happens below
      allowed = (userClientId && userClientId.toString() === clientId.toString());
      fullAccess = false;
    }

    if (!allowed) {
      return res.status(403).json({ 
        message: 'You do not have permission to view this process flowchart' 
      });
    }

    // ---------- 2) Load flowchart ----------
    const processFlowchart = await ProcessFlowchart.findOne({ 
      clientId, 
      isDeleted: false 
    })
    .populate('createdBy', 'userName email')
    .populate('lastModifiedBy', 'userName email');

    if (!processFlowchart) {
      return res.status(404).json({ message: 'Process flowchart not found' });
    }

    // ---------- 3) Assessment-level availability ----------
    const client = await Client.findOne({ clientId });
    const assessmentLevel = client?.submissionData?.assessmentLevel;
    if (assessmentLevel && assessmentLevel !== 'both' && assessmentLevel !== 'process') {
      return res.status(403).json({
        message: `Process flowchart is not available for current assessment level: ${assessmentLevel}`,
        availableFor: ['both', 'process']
      });
    }

    // ---------- 4) Build filtered nodes for limited roles ----------
    const originalNodes = Array.isArray(processFlowchart.nodes) ? processFlowchart.nodes : [];
    let filteredNodes = originalNodes;

    // Helper: return a safe copy of a node (remove/limit sensitive fields for read-only roles)
    const toSafeNode = (node) => {
      const base = typeof node.toObject === 'function' ? node.toObject() : node;
      const details = base?.details || {};

      // Scope detail guard + whitelisting
      const rawScopes = Array.isArray(details.scopeDetails) ? details.scopeDetails : [];
      const safeScopes = rawScopes.map(s => ({
        scopeIdentifier: s?.scopeIdentifier,
        scopeType: s?.scopeType,
        // normalize name if your schema uses dataCollectionType
        inputType: s?.inputType ?? s?.dataCollectionType
      }));

      // Return a shallow copy with limited details
      return {
        ...base,
        details: {
          ...details,
          scopeDetails: safeScopes,
          // optionally hide other sensitive internals if they exist on process nodes:
          emissionFactors: undefined,
          gwp: undefined,
          calculations: undefined,
          formulas: undefined
        }
      };
    };

    // Employee Head: see ONLY nodes assigned to them (primary),
    // fallback to department/location match if assignment not yet set.
    if (userType === 'client_employee_head' && !fullAccess) {
      const assigned = originalNodes.filter(n =>
        n?.details?.employeeHeadId &&
        n.details.employeeHeadId.toString?.() === userId
      );

      const departmentLocationFallback = originalNodes.filter(n =>
        (n?.details?.department && n.details.department === req.user.department) ||
        (n?.details?.location && n.details.location === req.user.location)
      );

      filteredNodes = (assigned.length > 0 ? assigned : departmentLocationFallback)
        .map(toSafeNode);
    }

    // Employee / Auditor / Viewer: allow read of nodes but with limited details
    if (['employee', 'auditor', 'viewer'].includes(userType) && !fullAccess) {
      filteredNodes = originalNodes.map(toSafeNode);
    }

    // Admin/Consultant/Client Admin with fullAccess: no node filtering
    // (keep originalNodes)

    // ---------- 5) Filter edges to visible nodes ----------
    // Be tolerant: some nodes may use id or _id
    const getNodeId = (n) => (n?.id ?? n?._id?.toString?.() ?? n?.data?.id);
    const visibleIds = new Set(filteredNodes.map(getNodeId).filter(Boolean));

    const filteredEdges = (Array.isArray(processFlowchart.edges) ? processFlowchart.edges : [])
      .filter(e => visibleIds.has(e.source) && visibleIds.has(e.target));

    // ---------- 6) Response ----------
    return res.status(200).json({
      flowchart: {
        clientId: processFlowchart.clientId,
        nodes: filteredNodes,
        edges: filteredEdges,
        createdBy: processFlowchart.createdBy,
        lastModifiedBy: processFlowchart.lastModifiedBy,
        createdAt: processFlowchart.createdAt,
        updatedAt: processFlowchart.updatedAt
      }
    });

  } catch (error) {
    console.error('Get process flowchart error:', error);
    return res.status(500).json({ 
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
// controllers/processflowController.js – PATCH /:clientId/node/:nodeId
const updateProcessFlowchartNode = async (req, res) => {
  try {
    const { clientId, nodeId } = req.params;
    const { nodeData } = req.body;

    // Permission
    const canManage = await canManageProcessFlowchart(req.user, clientId);
    if (!canManage) {
      return res.status(403).json({ message: 'You do not have permission to update this process flowchart' });
    }

    const processFlowchart = await ProcessFlowchart.findOne({ clientId, isDeleted: false });
    if (!processFlowchart) {
      return res.status(404).json({ message: 'Process flowchart not found' });
    }

    // Find node
    const nodeIndex = processFlowchart.nodes.findIndex(n => n.id === nodeId);
    if (nodeIndex === -1) {
      return res.status(404).json({ message: 'Node not found' });
    }

    // Existing node as plain object
    const existingNode =
      typeof processFlowchart.nodes[nodeIndex].toObject === 'function'
        ? processFlowchart.nodes[nodeIndex].toObject()
        : JSON.parse(JSON.stringify(processFlowchart.nodes[nodeIndex] || {}));

    // Reuse same helpers as above
    const shallowMerge = (base, patch) => {
      const out = { ...base };
      if (patch && typeof patch === 'object') {
        for (const k of Object.keys(patch)) {
          if (patch[k] !== undefined) out[k] = patch[k];
        }
      }
      return out;
    };

    const mergeEFBlocks = (finalEF, existingEFVals = {}, incomingEFVals = {}, incomingTopLevel = {}) => {
      const out = {
        defraData: { ...(existingEFVals.defraData || {}), ...(incomingEFVals.defraData || {}) },
        ipccData: { ...(existingEFVals.ipccData || {}), ...(incomingEFVals.ipccData || {}) },
        epaData: { ...(existingEFVals.epaData || {}), ...(incomingEFVals.epaData || {}) },
        countryData: { ...(existingEFVals.countryData || {}), ...(incomingEFVals.countryData || {}) },
        emissionFactorHubData: { ...(existingEFVals.emissionFactorHubData || {}), ...(incomingEFVals.emissionFactorHubData || {}) },
        customEmissionFactor: {
          ...(existingEFVals.customEmissionFactor || {}),
          ...((incomingEFVals && incomingEFVals.customEmissionFactor) || (incomingTopLevel && incomingTopLevel.customEmissionFactor) || {})
        },
        dataSource: incomingEFVals?.dataSource !== undefined ? incomingEFVals.dataSource : (existingEFVals.dataSource || undefined),
        lastUpdated: new Date()
      };
      if (finalEF === 'Custom' && !out.customEmissionFactor) out.customEmissionFactor = {};
      return out;
    };

    const mergeScopeDetail = (existingScope = {}, incomingScope = {}) => {
      const finalEF = incomingScope.emissionFactor ?? existingScope.emissionFactor ?? '';
      const mergedTop = {
        ...existingScope,
        ...Object.fromEntries(
          Object.entries(incomingScope).filter(([k, v]) => k !== 'emissionFactorValues' && v !== undefined)
        ),
        emissionFactor: finalEF
      };
      const existingEFVals = existingScope.emissionFactorValues || {};
      const incomingEFVals = incomingScope.emissionFactorValues || {};
      mergedTop.emissionFactorValues = mergeEFBlocks(finalEF, existingEFVals, incomingEFVals, incomingScope);

      if (incomingScope.UAD !== undefined) mergedTop.UAD = incomingScope.UAD;
      if (incomingScope.UEF !== undefined) mergedTop.UEF = incomingScope.UEF;

      return mergedTop;
    };

    // Merge the node (shallow first)
    const mergedNode = {
      ...existingNode,
      ...(nodeData && typeof nodeData === 'object' ? nodeData : {}),
      id: nodeId
    };

    // Merge details
    mergedNode.details = shallowMerge(existingNode.details || {}, (nodeData && nodeData.details) || {});

    // If this node carries scopeDetails in process-flow context, merge them too
    if (Array.isArray((nodeData && nodeData.details && nodeData.details.scopeDetails) || null)) {
      const incomingScopes = nodeData.details.scopeDetails;
      const byId = new Map(
        (Array.isArray(existingNode.details?.scopeDetails) ? existingNode.details.scopeDetails : [])
          .map(s => [s.scopeIdentifier, s])
      );

      const mergedScopes = [];
      for (const inc of incomingScopes) {
        const old = byId.get(inc.scopeIdentifier);
        if (old) {
          mergedScopes.push(mergeScopeDetail(old, inc));
          byId.delete(inc.scopeIdentifier);
        } else {
          mergedScopes.push(mergeScopeDetail({}, inc));
        }
      }
      for (const leftover of byId.values()) mergedScopes.push(leftover);
      mergedNode.details.scopeDetails = mergedScopes;
    }

    // Save back
    processFlowchart.nodes[nodeIndex] = mergedNode; // <-- fixed spread bug
    processFlowchart.markModified('nodes');
    processFlowchart.lastModifiedBy = req.user._id;

    await processFlowchart.save();

    return res.status(200).json({
      message: 'Node updated successfully',
      node: processFlowchart.nodes[nodeIndex]
    });
  } catch (error) {
    console.error('Update process flowchart node error:', error);
    return res.status(500).json({ message: 'Failed to update node', error: error.message });
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

const assignOrUnassignEmployeeHeadToNode = async (req, res) => {
  try {
    const { clientId, nodeId } = req.params;
    const { employeeHeadId } = req.body;

    // Permission checks
    const permissionCheck = await canAssignHeadToNode(req.user, clientId);
    if (!permissionCheck) {
      return res.status(403).json({ 
        message: 'Permission denied'
      });
    }

    if (req.user.userType !== 'client_admin' && !permissionCheck) {
      return res.status(403).json({ 
        message: 'Only client admins or authorized consultants can assign/unassign employee heads.'
      });
    }

    // Find the flowchart
    const flowchart = await ProcessFlowchart.findOne({ clientId, isActive: true });
    if (!flowchart) {
      return res.status(404).json({ message: 'Active process flowchart not found for this client.' });
    }

    // Find the node
    const node = flowchart.nodes.find(n => n.id === nodeId);
    if (!node) {
      return res.status(404).json({ message: 'Node not found in the process flowchart.' });
    }

    // ASSIGN
    if (employeeHeadId) {
      // Verify the employee head exists and belongs to the client
      const employeeHead = await User.findOne({ _id: employeeHeadId, userType: 'client_employee_head', clientId });
      if (!employeeHead) {
        return res.status(404).json({ message: 'Employee head not found or does not belong to this client.' });
      }

      node.details.employeeHeadId = employeeHeadId;

      await flowchart.save();

      return res.status(200).json({
        message: 'Employee head assigned to node successfully.',
        nodeId: node.id,
        employeeHeadId
      });
    } 
    
    // UNASSIGN
    else {
      if (!node.details.employeeHeadId) {
        return res.status(400).json({ message: 'No employee head is currently assigned to this node.' });
      }

      node.details.employeeHeadId = null;

      await flowchart.save();

      return res.status(200).json({
        message: 'Employee head unassigned from node successfully.',
        nodeId: node.id
      });
    }

  } catch (error) {
    console.error('Error assigning/unassigning employee head to node:', error);
    res.status(500).json({ 
      message: 'Failed to assign/unassign employee head to node.', 
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
  restoreProcessFlowchart,
  assignOrUnassignEmployeeHeadToNode
};