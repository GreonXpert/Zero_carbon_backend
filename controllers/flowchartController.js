const Flowchart = require('../models/Flowchart');
const Client = require('../models/Client');
const User = require('../models/User');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const Notification   = require('../models/Notification');

// Import helper functions
const {
  validateScopeDetails,
  normalizeNodes,
  normalizeEdges,
  createChartNotifications,
  isChartAvailable,
  getChartUnavailableMessage
} = require('../utils/chart/chartHelpers');



// Add this import at the top of flowchartController.js:
const { autoUpdateFlowchartStatus } = require('../utils/Workflow/workflow');
const {canManageFlowchart,canViewFlowchart, canAssignHeadToNode, canAccessModule, getNormalizedLevels} = require('../utils/Permissions/permissions')
 
// ============================================================================
// PERMISSION HELPERS
// ============================================================================

// Check if user can create/edit flowchart for a client
// const canManageFlowchart = async (user, clientId, flowchart = null) => {
//   // Super admin can manage all
//   if (user.userType === 'super_admin') {
//     return { allowed: true, reason: 'Super admin access' };
//   }

//   // Get client details
//   const client = await Client.findOne({ clientId });
//   if (!client) {
//     return { allowed: false, reason: 'Client not found' };
//   }

//   // Consultant Admin: Can manage if they created the lead
//   if (user.userType === 'consultant_admin') {
//     const createdBy = client.leadInfo?.createdBy;
//     if (createdBy && user._id && createdBy.toString() === user._id.toString()) {
//       return { allowed: true, reason: 'Consultant admin who created lead' };
//     }

//     // Also check if any consultant under them is assigned
//     const consultantsUnderAdmin = await User.find({
//       consultantAdminId: user.id,
//       userType: 'consultant'
//     }).select('_id');
//     const consultantIds = consultantsUnderAdmin.map(c => c._id.toString());
//     const assignedConsultantId = client.leadInfo?.assignedConsultantId;
//     if (assignedConsultantId && consultantIds.includes(assignedConsultantId.toString())) {
//       return { allowed: true, reason: 'Client assigned to consultant under this admin' };
//     }
//     return { allowed: false, reason: 'Not authorized for this client' };
//   }

//   // Consultant: Can manage if they are assigned to this client
//   if (user.userType === 'consultant') {
//     const assignedConsultantId = client.leadInfo?.assignedConsultantId;
//     if (assignedConsultantId && user.id && assignedConsultantId.toString() === user.id.toString()) {
//       return { allowed: true, reason: 'Assigned consultant' };
//     }
//     return { allowed: false, reason: 'Not assigned to this client' };
//   }

//   return { allowed: false, reason: 'Insufficient permissions' };
// };


// Check if user can view flowchart
// const canViewFlowchart = async (user, clientId) => {
//   // Super admin can view all
//   if (user.userType === 'super_admin') {
//     return { allowed: true, fullAccess: true };
//   }

//   // Check if user can manage (creators can always view)
//   const manageCheck = await canManageFlowchart(user, clientId);
//   if (manageCheck.allowed) {
//     return { allowed: true, fullAccess: true };
//   }
//   //  // Consultant Admin: view if any of their consultants is assigned to this client
//   // if (user.userType === 'consultant_admin') {
//   //   const client = await Client.findOne({ clientId }).select('leadInfo.assignedConsultantId');
//   //   if (client?.leadInfo?.assignedConsultantId) {
//   //     // get all consultants under this admin
//   //     const subCons = await User.find({
//   //       consultantAdminId: user.id,
//   //       userType: 'consultant'
//   //     }).select('_id');
//   //     const subIds = subCons.map(c => c._id.toString());
//   //     if (subIds.includes(client.leadInfo.assignedConsultantId.toString())) {
//   //       return { allowed: true, fullAccess: true };
//   //     }
//   //   }
//   // }

//   // // Consultant: view if they are the assigned consultant
//   // if (user.userType === 'consultant') {
//   //   const client = await Client.findOne({ clientId }).select('leadInfo.assignedConsultantId');
//   //   if (client?.leadInfo?.assignedConsultantId?.toString() === user.id.toString()) {
//   //     return { allowed: true, fullAccess: true };
//   //   }
//   // }
//   // Client admin can view their own flowchart
//   if (user.userType === 'client_admin' && user.clientId === clientId) {
//     return { allowed: true, fullAccess: true };
//   }

//   // Employee head can view with department/location restrictions
//   if (user.userType === 'client_employee_head' && user.clientId === clientId) {
//     return { 
//       allowed: true, 
//       fullAccess: false,
//       restrictions: {
//         department: user.department,
//         location: user.location
//       }
//     };
//   }

//   // Employees, auditors, viewers can view if they belong to the client
//   if (['employee', 'auditor', 'viewer'].includes(user.userType) && user.clientId === clientId) {
//     return { allowed: true, fullAccess: false };
//   }

//   return { allowed: false };
// };

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





// ============================================================================
// MAIN CONTROLLERS
// ============================================================================

// Create or Update Flowchart
// Create or Update Flowchart
const saveFlowchart = async (req, res) => {
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

    // 2) Verify the client actually exists
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: 'Client not found' });
    }

    // 3) Check flowchart availability based on assessment level (array-aware)
const levels = getNormalizedLevels(client); // e.g., ['organization','process'] etc.
if (!canAccessModule(client, 'organization')) {
  return res.status(403).json({
    message: 'Flowchart is not available for this client',
    reason: 'assessmentLevel does not include "organization"',
    assessmentLevel: levels,
    required: 'organization'
  });
}
// keep a normalized value for downstream usage
const assessmentLevel = levels;


    // 4) Auto-update client workflow status when consultant starts creating flowchart
    if (['consultant', 'consultant_admin'].includes(req.user.userType)) {
      await autoUpdateFlowchartStatus(clientId, userId);
    }

    // 5) Role check
    if (!['super_admin','consultant_admin','consultant'].includes(req.user.userType)) {
      return res.status(403).json({
        message: 'Only Super Admin, Consultant Admin, and Consultants can manage flowcharts'
      });
    }

    // 6) Permission check
    const perm = await canManageFlowchart(req.user, clientId);
    if (!perm.allowed) {
      return res.status(403).json({
        message: 'Permission denied',
        reason: perm.reason
      });
    }

    // 7) Normalize & validate nodes - flowchart always includes full scope details when available
    const normalizedNodes = normalizeNodes(flowchartData.nodes, assessmentLevel, 'flowchart');

    // 8) Normalize edges
    const normalizedEdges = normalizeEdges(flowchartData.edges);

    // 9) Create vs. Update
    let flowchart = await Flowchart.findOne({ clientId });
    let isNew = false;

    if (flowchart) {
      // UPDATE existing flowchart
      flowchart.nodes          = normalizedNodes;
      flowchart.edges          = normalizedEdges;
      flowchart.lastModifiedBy = userId;
      flowchart.version       += 1;
      await flowchart.save();
    } else {
      // CREATE new flowchart
      isNew = true;
      flowchart = new Flowchart({
        clientId,
        createdBy:      userId,
        creatorType:    req.user.userType,
        lastModifiedBy: userId,
        nodes:          normalizedNodes,
        edges:          normalizedEdges,
        assessmentLevel, // Store assessment level for reference
        version: 1
      });
      await flowchart.save();
    }
    
    // 10) Auto‐start flowchart status
    if (['consultant','consultant_admin'].includes(req.user.userType) && isNew) {
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

    // 11) Send notifications to all client_admins of this client
    await createChartNotifications(User, Notification, {
      clientId,
      userId,
      userType: req.user.userType,
      userName: req.user.userName,
      isNew,
      chartType: 'flowchart',
      chartId: flowchart._id
    });

    // 12) Prepare response
    const responseData = {
      message: isNew ? 'Flowchart created successfully' : 'Flowchart updated successfully',
      flowchartId: flowchart._id,
      version: flowchart.version,
      assessmentLevel: assessmentLevel
    };

   const hasOrg = Array.isArray(assessmentLevel) && assessmentLevel.includes('organization');
const hasProc = Array.isArray(assessmentLevel) && assessmentLevel.includes('process');

if (hasOrg && hasProc) {
  responseData.note = 'Flowchart contains full scope details. Process flowchart available with basic structure only.';
} else if (hasOrg && !hasProc) {
  responseData.note = 'Flowchart contains full scope details. Process flowchart not available for this assessment level.';
}

    // 13) Respond
    return res.status(isNew ? 201 : 200).json(responseData);

  } catch (error) {
    console.error('❌ Error saving flowchart:', error);

    // Handle Mongo duplicate-key
    if (error.code === 11000) {
      return res.status(400).json({
        message: 'Duplicate key error - check for duplicate identifiers',
        error:   error.message,
        details:'This might be caused by duplicate edge IDs or scope identifiers'
      });
    }

    return res.status(500).json({
      message: 'Failed to save flowchart',
      error:   error.message
    });
  }
};

// Get single Flowchart with proper permissions
// Get single Flowchart with proper permissions
const getFlowchart = async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!clientId) {
      return res.status(400).json({ message: 'clientId is required' });
    }

    // 1) Permission gate
    const permissionCheck = await canViewFlowchart(req.user, clientId);
    if (!permissionCheck.allowed) {
      return res.status(403).json({ message: 'You do not have permission to view this flowchart' });
    }

    // 2) Load flowchart
    const flowchart = await Flowchart.findOne({ clientId, isActive: true })
      .populate('createdBy', 'userName email userType')
      .populate('lastModifiedBy', 'userName email');

    if (!flowchart) {
      return res.status(404).json({ message: 'Flowchart not found' });
    }

    // 3) Assessment-level availability
   const client = await Client.findOne(
  { clientId },
  { 'submissionData.assessmentLevel': 1, _id: 0 }
).lean();

if (!client) return res.status(404).json({ message: 'Client not found' });

if (!canAccessModule(client, 'organization')) {
  return res.status(403).json({
    message: 'Flowchart is not available for this client',
    reason: 'assessmentLevel does not include "organization"',
    assessmentLevel: getNormalizedLevels(client),
    required: 'organization'
  });
}
    // 4) Filter nodes by role
    let filteredNodes = flowchart.nodes;

    // Employee Head: show only nodes explicitly assigned to this head (primary rule),
    // fallback to department/location match if assignment isn't set yet.
    if (req.user.userType === 'client_employee_head' && !permissionCheck.fullAccess) {
      const assigned = flowchart.nodes.filter(n =>
        n?.details?.employeeHeadId &&
        n.details.employeeHeadId.toString?.() === req.user.id
      );

      filteredNodes = assigned.length > 0
        ? assigned
        : flowchart.nodes.filter(n =>
            n?.details?.department === req.user.department ||
            n?.details?.location === req.user.location
          );
    }

    // Employee / Auditor / Viewer: same visibility, but hide sensitive details
    if (['employee', 'auditor', 'viewer'].includes(req.user.userType) && !permissionCheck.fullAccess) {
      filteredNodes = flowchart.nodes.map(node => {
        const base = typeof node.toObject === 'function' ? node.toObject() : node;
        const scope = Array.isArray(base?.details?.scopeDetails) ? base.details.scopeDetails : [];
        return {
          ...base,
          details: {
            ...base.details,
            // expose only non-sensitive fields per scope
            scopeDetails: scope.map(s => ({
              scopeIdentifier: s.scopeIdentifier,
              scopeType: s.scopeType,
              // keep your field naming consistent (inputType vs dataCollectionType)
              inputType: s.inputType ?? s.dataCollectionType
            }))
          }
        };
      });
    }

    // 5) Format nodes for React Flow
    const rfNodes = filteredNodes.map(n => ({
      id: n.id,
      data: {
        label: n.label,
        details: n.details
      },
      position: n.position,
      ...(n.parentNode ? { parentNode: n.parentNode } : {})
    }));

    // 6) Filter edges to only those connecting visible nodes
    const visibleIds = new Set(rfNodes.map(n => n.id));
    const rfEdges = flowchart.edges
      .filter(e => visibleIds.has(e.source) && visibleIds.has(e.target))
      .map(e => ({ id: e.id, source: e.source, target: e.target }));

    // 7) Response
    const response = {
      clientId: flowchart.clientId,
      createdBy: flowchart.createdBy,
      creatorType: flowchart.creatorType,
      lastModifiedBy: flowchart.lastModifiedBy,
      version: flowchart.version,
      createdAt: flowchart.createdAt,
      updatedAt: flowchart.updatedAt,
      nodes: rfNodes,
      edges: rfEdges,
      permissions: {
        canEdit: permissionCheck.fullAccess && ['super_admin', 'consultant_admin', 'consultant'].includes(req.user.userType),
        canDelete: permissionCheck.fullAccess && ['super_admin', 'consultant_admin', 'consultant'].includes(req.user.userType)
      }
    };

    return res.status(200).json(response);
  } catch (error) {
    console.error('Error fetching flowchart:', error);
    return res.status(500).json({ message: 'Failed to fetch flowchart', error: error.message });
  }
};

// Get All Flowcharts based on user hierarchy
const getAllFlowcharts = async (req, res) => {
  try {
    let query = { isActive: true };
    const { page = 1, limit = 10, search, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

    // Build query based on user type
    switch (req.user.userType) {
      case 'super_admin':
        // Super admin sees all flowcharts
        // No additional query filters needed
        break;

      case 'consultant_admin':
        // Get all consultants under this admin
        const consultantsUnderAdmin = await User.find({
          consultantAdminId: req.user.id,
          userType: 'consultant'
        }).select('_id');
        
        const consultantIds = consultantsUnderAdmin.map(c => c._id);
        
        // Get all clients created by this consultant admin or assigned to their consultants
        const clients = await Client.find({
          $or: [
            { 'leadInfo.createdBy': req.user.id },
            { 'leadInfo.assignedConsultantId': { $in: consultantIds } }
          ]
        }).select('clientId');
        
        const clientIds = clients.map(c => c.clientId);
        
        // Filter flowcharts by these client IDs
        query.clientId = { $in: clientIds };
        break;

      case 'consultant':
        // Get clients assigned to this consultant
        const assignedClients = await Client.find({
          'leadInfo.assignedConsultantId': req.user.id
        }).select('clientId');
        
        const assignedClientIds = assignedClients.map(c => c.clientId);
        
        // Filter flowcharts by assigned client IDs
        query.clientId = { $in: assignedClientIds };
        break;

      case 'client_admin':
        // Client admin can only see their own client's flowchart
        query.clientId = req.user.clientId;
        break;

      default:
        // Other user types shouldn't access this endpoint
        return res.status(403).json({ 
          message: 'You do not have permission to view flowcharts' 
        });
    }

    // Add search functionality
    if (search) {
      const searchRegex = { $regex: search, $options: 'i' };
      query.$or = [
        { clientId: searchRegex },
        { 'nodes.label': searchRegex }
      ];
    }

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sortOptions = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

    // Get total count
    const total = await Flowchart.countDocuments(query);

    // Fetch flowcharts with pagination
    const flowcharts = await Flowchart.find(query)
      .populate('createdBy', 'userName email userType')
      .populate('lastModifiedBy', 'userName email')
      .sort(sortOptions)
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    // Get client details for each flowchart
    const clientIds = [...new Set(flowcharts.map(f => f.clientId))];
    const clients = await Client.find({ 
      clientId: { $in: clientIds } 
    }).select('clientId leadInfo.companyName stage status');

    // Create client map for quick lookup
    const clientMap = {};
    clients.forEach(client => {
      clientMap[client.clientId] = {
        companyName: client.leadInfo.companyName,
        stage: client.stage,
        status: client.status
      };
    });

    // Format response with client details
    const formattedFlowcharts = flowcharts.map(flowchart => ({
      _id: flowchart._id,
      clientId: flowchart.clientId,
      clientDetails: clientMap[flowchart.clientId] || {},
      createdBy: flowchart.createdBy,
      creatorType: flowchart.creatorType,
      lastModifiedBy: flowchart.lastModifiedBy,
      version: flowchart.version,
      nodeCount: flowchart.nodes.length,
      edgeCount: flowchart.edges.length,
      scopeSummary: {
        'Scope 1': flowchart.nodes.reduce((count, node) => 
          count + node.details.scopeDetails.filter(s => s.scopeType === 'Scope 1').length, 0),
        'Scope 2': flowchart.nodes.reduce((count, node) => 
          count + node.details.scopeDetails.filter(s => s.scopeType === 'Scope 2').length, 0),
        'Scope 3': flowchart.nodes.reduce((count, node) => 
          count + node.details.scopeDetails.filter(s => s.scopeType === 'Scope 3').length, 0)
      },
      createdAt: flowchart.createdAt,
      updatedAt: flowchart.updatedAt
    }));

    // Response
    res.status(200).json({
      success: true,
      message: 'Flowcharts fetched successfully',
      data: {
        flowcharts: formattedFlowcharts,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit)),
          hasNextPage: page < Math.ceil(total / parseInt(limit)),
          hasPrevPage: page > 1
        }
      }
    });

  } catch (error) {
    console.error('Error fetching all flowcharts:', error);
    res.status(500).json({ 
      message: 'Failed to fetch flowcharts', 
      error: error.message 
    });
  }
};

// Delete Flowchart (soft delete)
// Delete Flowchart (soft delete)
const deleteFlowchart = async (req, res) => {
  try {
    const { clientId } = req.params;

    // Only super_admin, consultant_admin, consultant
    if (!['super_admin','consultant_admin','consultant'].includes(req.user.userType)) {
      return res.status(403).json({ 
        message: 'Only Super Admin, Consultant Admin, and Consultants can delete flowcharts' 
      });
    }

    // Permission check
    const perm = await canManageFlowchart(req.user, clientId);
    if (!perm.allowed) {
      return res.status(403).json({ 
        message: 'Permission denied', 
        reason: perm.reason 
      });
    }

    // Find the active flowchart
    const flowchart = await Flowchart.findOne({ clientId, isActive: true });
    if (!flowchart) {
      return res.status(404).json({ message: 'Flowchart not found' });
    }

    // Soft delete
    flowchart.isActive       = false;
    flowchart.lastModifiedBy = req.user._id;
    await flowchart.save();

    // Notify all client_admins for this client
    const clientAdmins = await User.find({ 
      userType: 'client_admin', 
      clientId 
    });
    for (const admin of clientAdmins) {
      await Notification.create({
        title:           `Flowchart Deleted: ${clientId}`,
        message:         `The flowchart for client ${clientId} was deleted by ${req.user.userName}.`,
        priority:        'high',
        createdBy:       req.user._id,
        creatorType:     req.user.userType,
        targetUsers:     [admin._id],
        targetClients:   [clientId],
        status:          'published',
        publishedAt:     new Date(),
        isSystemNotification: true,
        systemAction:    'flowchart_deleted',
        relatedEntity:   { type: 'flowchart', id: flowchart._id }
      });
    }

    console.log(`✅ Flowchart soft-deleted for ${clientId} by ${req.user.userName}`);
    return res.status(200).json({ message: 'Flowchart deleted successfully' });
  } catch (error) {
    console.error('Error deleting flowchart:', error);
    return res.status(500).json({ 
      message: 'Failed to delete flowchart', 
      error: error.message 
    });
  }
};
// Delete specific node in flowchart
const deleteFlowchartNode = async (req, res) => {
  try {
    const { clientId, nodeId } = req.params;

    // Permission check
    const perm = await canManageFlowchart(req.user, clientId);
    if (!perm.allowed) {
      return res.status(403).json({ 
        message: 'Permission denied', 
        reason: perm.reason 
      });
    }

    // Find active flowchart
    const flowchart = await Flowchart.findOne({ clientId, isActive: true });
    if (!flowchart) {
      return res.status(404).json({ message: 'Flowchart not found' });
    }

    // Locate node
    const nodeIndex = flowchart.nodes.findIndex(n => n.id === nodeId);
    if (nodeIndex === -1) {
      return res.status(404).json({ message: 'Node not found' });
    }

    // Remove node and any edges tied to it
    flowchart.nodes.splice(nodeIndex, 1);
    flowchart.edges = flowchart.edges.filter(
      e => e.source !== nodeId && e.target !== nodeId
    );

    flowchart.lastModifiedBy = req.user.id;
    flowchart.version += 1;
    await flowchart.save();

    res.status(200).json({ message: 'Node deleted successfully' });
  } catch (error) {
    console.error('Error deleting node:', error);
    res.status(500).json({ 
      message: 'Failed to delete node', 
      error: error.message 
    });
  }
};

// Restore Flowchart
// Restore soft-deleted flowchart, with conflict check
const restoreFlowchart = async (req, res) => {
  try {
    const { clientId } = req.params;

    // Only super_admin, consultant_admin, consultant
    if (!['super_admin','consultant_admin','consultant'].includes(req.user.userType)) {
      return res.status(403).json({ 
        message: 'Only Super Admin, Consultant Admin, and Consultants can restore flowcharts' 
      });
    }

    // Permission check
    const perm = await canManageFlowchart(req.user, clientId);
    if (!perm.allowed) {
      return res.status(403).json({ 
        message: 'Permission denied', 
        reason: perm.reason 
      });
    }

    // Conflict: if there's already an active flowchart for this client
    const existingActive = await Flowchart.findOne({ clientId, isActive: true });
    if (existingActive) {
      return res.status(409).json({
        message: 'Conflict: an active flowchart already exists for this client'
      });
    }

    // Find the soft-deleted flowchart
    const flowchart = await Flowchart.findOne({ clientId, isActive: false });
    if (!flowchart) {
      return res.status(404).json({ message: 'No deleted flowchart to restore' });
    }

    // Restore
    flowchart.isActive       = true;
    flowchart.lastModifiedBy = req.user.id;
    flowchart.version       += 1;
    await flowchart.save();

    res.status(200).json({ 
      message: 'Flowchart restored successfully' 
    });

  } catch (error) {
    console.error('Error restoring flowchart:', error);
    res.status(500).json({ 
      message: 'Failed to restore flowchart', 
      error: error.message 
    });
  }
};


// Get Flowchart Summary (for dashboards) - Supports both consolidated and single client
const getFlowchartSummary = async (req, res) => {
  try {
    const { clientId } = req.params;
    
    // Check if this is a request for consolidated summary
    // This handles both /summary route and cases where clientId might be undefined
    if (!clientId || clientId === 'summary') {
      return getConsolidatedSummary(req, res);
    }
    
    // Otherwise, return single client summary
    return getSingleClientSummary(req, res, clientId);
    
  } catch (error) {
    console.error('Error getting flowchart summary:', error);
    res.status(500).json({ 
      message: 'Failed to get summary', 
      error: error.message 
    });
  }
};

// Helper function for single client summary
const getSingleClientSummary = async (req, res, clientId) => {
  const permissionCheck = await canViewFlowchart(req.user, clientId);
  if (!permissionCheck.allowed) {
    return res.status(403).json({ 
      message: 'Permission denied' 
    });
  }

  const flowchart = await Flowchart.findOne({ clientId, isActive: true });
  if (!flowchart) {
    return res.status(404).json({ message: 'Flowchart not found' });
  }

  // Get client details
  const client = await Client.findOne({ clientId })
    .populate('leadInfo.createdBy', 'userName userType')
    .populate('leadInfo.assignedConsultantId', 'userName');

  // Calculate summary
  const summary = {
    clientId: flowchart.clientId,
    clientName: client?.leadInfo?.companyName || 'Unknown',
    totalNodes: flowchart.nodes.length,
    totalEdges: flowchart.edges.length,
    nodesByDepartment: {},
    nodesByLocation: {},
    scopesSummary: {
      'Scope 1': 0,
      'Scope 2': 0,
      'Scope 3': 0
    },
    dataCollectionMethods: {
      manual: 0,
      IOT: 0,
      API: 0
    },
    emissionFactors: {
      IPCC: 0,
      DEFRA: 0,
      EPA: 0,
      EmissionFactorHub: 0,
      Custom: 0
    },
    createdAt: flowchart.createdAt,
    updatedAt: flowchart.updatedAt,
    version: flowchart.version
  };

  // Add creator info for super admin
  if (req.user.userType === 'super_admin') {
    summary.createdBy = {
      userName: client?.leadInfo?.createdBy?.userName,
      userType: client?.leadInfo?.createdBy?.userType
    };
    summary.assignedConsultant = client?.leadInfo?.assignedConsultantId?.userName;
  }

  // Apply restrictions for employee heads
  let nodesToAnalyze = flowchart.nodes;
  if (req.user.userType === 'client_employee_head' && !permissionCheck.fullAccess) {
    nodesToAnalyze = flowchart.nodes.filter(node => {
      return node.details.department === req.user.department ||
             node.details.location === req.user.location;
    });
  }

  nodesToAnalyze.forEach(node => {
    // Count by department
    if (node.details.department) {
      summary.nodesByDepartment[node.details.department] = 
        (summary.nodesByDepartment[node.details.department] || 0) + 1;
    }

    // Count by location
    if (node.details.location) {
      summary.nodesByLocation[node.details.location] = 
        (summary.nodesByLocation[node.details.location] || 0) + 1;
    }

    // Count scopes and collection methods
    node.details.scopeDetails.forEach(scope => {
      summary.scopesSummary[scope.scopeType]++;
      summary.dataCollectionMethods[scope.inputType]++; // Fixed: was scope.dataCollectionType
      
      // Count emission factors for Scope 1
      if (scope.scopeType === 'Scope 1' && scope.emissionFactor) {
        summary.emissionFactors[scope.emissionFactor]++;
      }
    });
  });

  res.status(200).json({
    success: true,
    data: summary
  });
};

// Helper function for consolidated summary
const getConsolidatedSummary = async (req, res) => {
  let query = { isActive: true };
  let clientQuery = {};

  // Build query based on user type
  switch (req.user.userType) {
    case 'super_admin':
      // Super admin sees all flowcharts
      break;

    case 'consultant_admin':
      // Get all consultants under this admin
      const consultantsUnderAdmin = await User.find({
        consultantAdminId: req.user._id,
        userType: 'consultant'
      }).select('_id');
      
      const consultantIds = consultantsUnderAdmin.map(c => c._id);
      
      // Get all clients created by this consultant admin or assigned to their consultants
      clientQuery = {
        $or: [
          { 'leadInfo.createdBy': req.user._id },
          { 'leadInfo.assignedConsultantId': { $in: consultantIds } }
        ]
      };
      break;

    case 'consultant':
      // Get clients assigned to this consultant
      clientQuery = {
        'leadInfo.assignedConsultantId': req.user._id
      };
      break;

    default:
      return res.status(403).json({ 
        message: 'You do not have permission to view consolidated summary' 
      });
  }

  // Get eligible clients
  const clients = await Client.find(clientQuery)
    .populate('leadInfo.createdBy', 'userName userType')
    .populate('leadInfo.assignedConsultantId', 'userName');
  
  const clientIds = clients.map(c => c.clientId);
  
  // Update query for flowcharts
  if (req.user.userType !== 'super_admin') {
    query.clientId = { $in: clientIds };
  }

  // Fetch all accessible flowcharts
  const flowcharts = await Flowchart.find(query)
    .populate('createdBy', 'userName userType')
    .populate('lastModifiedBy', 'userName');

  // Create client map for quick lookup
  const clientMap = {};
  clients.forEach(client => {
    clientMap[client.clientId] = client;
  });

  // Initialize consolidated summary
  const consolidatedSummary = {
    totalFlowcharts: flowcharts.length,
    flowchartsByClient: []
  };

  // Process each flowchart
  flowcharts.forEach(flowchart => {
    const client = clientMap[flowchart.clientId];
    
    // Create client-specific summary with all details
    const clientSummary = {
      clientId: flowchart.clientId,
      clientName: client?.leadInfo?.companyName || 'Unknown',
      totalNodes: flowchart.nodes.length,
      totalEdges: flowchart.edges.length,
      nodesByDepartment: {},
      nodesByLocation: {},
      scopesSummary: {
        'Scope 1': 0,
        'Scope 2': 0,
        'Scope 3': 0
      },
      dataCollectionMethods: {
        manual: 0,
        IOT: 0,
        API: 0
      },
      emissionFactors: {
        IPCC: 0,
        DEFRA: 0,
        EPA: 0,
        EmissionFactorHub: 0,
        Custom: 0
      },
      createdAt: flowchart.createdAt,
      updatedAt: flowchart.updatedAt,
      version: flowchart.version
    };

    // Add creator info for super admin
    if (req.user.userType === 'super_admin') {
      clientSummary.createdBy = {
        userName: client?.leadInfo?.createdBy?.userName,
        userType: client?.leadInfo?.createdBy?.userType
      };
      clientSummary.assignedConsultant = client?.leadInfo?.assignedConsultantId?.userName;
    }

    // Process nodes for this specific flowchart
    flowchart.nodes.forEach(node => {
      // Count by department
      if (node.details.department) {
        clientSummary.nodesByDepartment[node.details.department] = 
          (clientSummary.nodesByDepartment[node.details.department] || 0) + 1;
      }

      // Count by location
      if (node.details.location) {
        clientSummary.nodesByLocation[node.details.location] = 
          (clientSummary.nodesByLocation[node.details.location] || 0) + 1;
      }

      // Count scopes and collection methods
      node.details.scopeDetails.forEach(scope => {
        clientSummary.scopesSummary[scope.scopeType]++;
        clientSummary.dataCollectionMethods[scope.inputType]++;
        
        // Count emission factors for Scope 1
        if (scope.scopeType === 'Scope 1' && scope.emissionFactor) {
          clientSummary.emissionFactors[scope.emissionFactor]++;
        }
      });
    });

    consolidatedSummary.flowchartsByClient.push(clientSummary);
  });

  // Optionally add overall statistics
  if (flowcharts.length > 0) {
    // Calculate overall totals
    let overallTotals = {
      totalNodes: 0,
      totalEdges: 0,
      totalScopes: {
        'Scope 1': 0,
        'Scope 2': 0,
        'Scope 3': 0
      }
    };

    consolidatedSummary.flowchartsByClient.forEach(client => {
      overallTotals.totalNodes += client.totalNodes;
      overallTotals.totalEdges += client.totalEdges;
      overallTotals.totalScopes['Scope 1'] += client.scopesSummary['Scope 1'];
      overallTotals.totalScopes['Scope 2'] += client.scopesSummary['Scope 2'];
      overallTotals.totalScopes['Scope 3'] += client.scopesSummary['Scope 3'];
    });

    consolidatedSummary.overallStatistics = {
      averageNodesPerFlowchart: Math.round(overallTotals.totalNodes / flowcharts.length),
      averageEdgesPerFlowchart: Math.round(overallTotals.totalEdges / flowcharts.length),
      totalScopes: overallTotals.totalScopes
    };
  }

  res.status(200).json({
    success: true,
    data: consolidatedSummary
  });
};





// In the updateFlowchartNode function, ensure custom emission factors are handled
// This is a modification to the existing updateFlowchartNode function

const numericOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
};

const normalizeCustomEF = (src = {}) => {
  // Accept both camel and all-caps variants you used across payloads
  return {
    // generic factor(s)
    industryAverageEmissionFactor: numericOrNull(src.industryAverageEmissionFactor),

    // gases & GWPs used across your examples
    CO2:          numericOrNull(src.CO2),
    CH4:          numericOrNull(src.CH4),
    N2O:          numericOrNull(src.N2O),
    CO2e:         numericOrNull(src.CO2e),

    CO2_gwp:      numericOrNull(src.CO2_gwp),
    CH4_gwp:      numericOrNull(src.CH4_gwp),
    N2O_gwp:      numericOrNull(src.N2O_gwp),

    // refrigerant/fugitive/fuel special cases seen in your data
    Gwp_refrigerant:          numericOrNull(src.Gwp_refrigerant ?? src.GWP_refrigerant),
    GWP_fugitiveEmission:     numericOrNull(src.GWP_fugitiveEmission),
    EmissionFactorFugitiveCH4Leak:       numericOrNull(src.EmissionFactorFugitiveCH4Leak),
    EmissionFactorFugitiveCH4Component:  numericOrNull(src.EmissionFactorFugitiveCH4Component),
    GWP_CH4_leak:             numericOrNull(src.GWP_CH4_leak),
    GWP_CH4_Component:        numericOrNull(src.GWP_CH4_Component),
    GWP_SF6:                  numericOrNull(src.GWP_SF6),
    CO2e_gwp:                numericOrNull(src.CO2e_gwp),
    unit:                    src.unit ?? null,

    // process/stoi/efficiency & misc fields
    stoichiometicFactor: numericOrNull(src.stoichiometicFactor),
    conversionEfficiency: numericOrNull(src.conversionEfficiency),
    leakageRate:         numericOrNull(src.leakageRate),
    chargeType:          src.chargeType ?? null,
    BuildingTotalS1_S2:  numericOrNull(src.BuildingTotalS1_S2)
  };
};

const mergeEmissionFactorValues = (prevEFV = {}, incomingEFV = {}, finalCustomEF = null) => {
  // Shallow-merge each block; only overwrite if provided
  const merged = {
    ...prevEFV,
    ...incomingEFV
  };

  if (finalCustomEF) {
    merged.customEmissionFactor = finalCustomEF;
  } else if (incomingEFV && incomingEFV.customEmissionFactor) {
    merged.customEmissionFactor = incomingEFV.customEmissionFactor;
  }

  // keep/refresh lastUpdated if any EF block changed
  merged.lastUpdated = new Date();
  return merged;
};

// --- main controller --- //
const updateFlowchartNode = async (req, res) => {
  try {
    const { clientId, nodeId } = req.params;
    const userId = req.user?._id || req.user?.id;

    // 1) Load active flowchart
    const flowchart = await Flowchart.findOne({ clientId, isActive: true });
    if (!flowchart) {
      return res.status(404).json({ message: 'Flowchart not found' });
    }

    // 2) Find the node to update
    const nodeIndex = flowchart.nodes.findIndex(n => n.id === nodeId);
    if (nodeIndex === -1) {
      return res.status(404).json({ message: 'Node not found' });
    }

    // allow partial updates – same as before
    const incomingNode = req.body?.nodeData || req.body || {};
    const existingNode = flowchart.nodes[nodeIndex].toObject
      ? flowchart.nodes[nodeIndex].toObject()
      : flowchart.nodes[nodeIndex];

    // ──────────────────────────────────────────────────────────────
    // Helpers (EF merge + CEF normalization)
    // ──────────────────────────────────────────────────────────────
    const normalizeCustomEF = (cef = {}) => {
      if (!cef || typeof cef !== 'object') return {};
      return { ...cef }; // keep your structure; you already normalize in chartHelpers
    };

    const mergeEmissionFactorValues = (prevVals = {}, incVals = {}, normalizedCEF = null) => {
      const out = {
        defraData: { ...(prevVals.defraData || {}), ...(incVals.defraData || {}) },
        ipccData: { ...(prevVals.ipccData || {}), ...(incVals.ipccData || {}) },
        epaData: { ...(prevVals.epaData || {}), ...(incVals.epaData || {}) },
        countryData: { ...(prevVals.countryData || {}), ...(incVals.countryData || {}) },
        emissionFactorHubData: { ...(prevVals.emissionFactorHubData || {}), ...(incVals.emissionFactorHubData || {}) },
        customEmissionFactor: {
          ...(prevVals.customEmissionFactor || {}),
          ...((incVals && incVals.customEmissionFactor) || {})
        },
        dataSource: incVals?.dataSource !== undefined ? incVals.dataSource : (prevVals.dataSource || undefined),
        lastUpdated: new Date()
      };
      if (normalizedCEF) out.customEmissionFactor = normalizedCEF;
      return out;
    };

    // ──────────────────────────────────────────────────────────────
    // 3) Merge node-level props (label, position, etc.)
    // ──────────────────────────────────────────────────────────────
    const mergedNode = {
      ...existingNode,
      ...incomingNode,
      id: nodeId,
      details: {
        ...existingNode.details,
        ...incomingNode.details
      }
    };

    // ──────────────────────────────────────────────────────────────
    // 4) Merge scopeDetails with RENAME SUPPORT
    // ──────────────────────────────────────────────────────────────
    const prevScopes = Array.isArray(existingNode.details?.scopeDetails) ? existingNode.details.scopeDetails : [];
    const incScopes  = Array.isArray(incomingNode.details?.scopeDetails) ? incomingNode.details.scopeDetails : [];

    // Ensure every existing scope has a stable scopeUid (if older records predate this)
    for (const s of prevScopes) {
      if (!s.scopeUid) s.scopeUid = s.scopeUid || s.uid || s._id || require('uuid').v4();
    }

    if (incScopes.length > 0) {
      // Build indices for fast matching
      const prevByUid  = new Map(prevScopes.map(s => [(s.scopeUid || s._id || s.scopeIdentifier), s]));
      const prevByName = new Map(prevScopes.map(s => [s.scopeIdentifier, s]));

      const consumed = new Set(); // track matched prev scopes
      const mergedScopes = [];

      const pickExistingFor = (inc) => {
        // 1) match by UID
        if (inc.scopeUid && prevByUid.has(inc.scopeUid)) return prevByUid.get(inc.scopeUid);

        // 2) match by NEW name (if someone sends the same name again)
        if (inc.scopeIdentifier && prevByName.has(inc.scopeIdentifier)) return prevByName.get(inc.scopeIdentifier);

        // 3) match by explicit old name fields if client sends them
        const oldKeys = ['previousScopeIdentifier', 'oldScopeIdentifier', 'originalScopeIdentifier'];
        for (const k of oldKeys) {
          const oldName = inc?.[k];
          if (oldName && prevByName.has(oldName)) return prevByName.get(oldName);
        }

        // 4) heuristic: same type + (categoryName + activity) combo not yet consumed
        if (inc.scopeType) {
          const cand = prevScopes.find(s =>
            !consumed.has(s) &&
            s.scopeType === inc.scopeType &&
            (s.categoryName || '') === (inc.categoryName || '') &&
            (s.activity || '') === (inc.activity || '')
          );
          if (cand) return cand;
        }

        return null;
      };

      for (const incRaw of incScopes) {
        // carry forward uid if provided; assign if missing
        const inc = { ...incRaw };
        if (!inc.scopeUid) inc.scopeUid = inc.scopeUid || inc.uid || inc._id || require('uuid').v4();

        const prev = pickExistingFor(inc) || {};
        if (prev && prev.scopeUid) consumed.add(prev);

        // Determine final emissionFactor (prefer incoming)
        const finalEmissionFactor = inc.emissionFactor ?? prev.emissionFactor ?? '';

        // Accept custom EF from either location (your earlier fix)
        const incomingCEF =
          inc?.emissionFactorValues?.customEmissionFactor
          ?? inc?.customEmissionFactor
          ?? prev?.emissionFactorValues?.customEmissionFactor
          ?? prev?.customEmissionFactor
          ?? null;

        const normalizedCEF =
          finalEmissionFactor === 'Custom'
            ? normalizeCustomEF(incomingCEF || {})
            : null;

        const mergedEFV = mergeEmissionFactorValues(
          prev.emissionFactorValues || {},
          inc.emissionFactorValues || {},
          normalizedCEF
        );

        const finalScope = {
          ...prev,
          ...inc,
          scopeUid: inc.scopeUid || prev.scopeUid, // ensure stable UID
          scopeIdentifier: inc.scopeIdentifier || prev.scopeIdentifier, // if rename, new name wins
          emissionFactor: finalEmissionFactor,
          emissionFactorValues: mergedEFV
        };

        if (finalEmissionFactor === 'Custom') {
          finalScope.customEmissionFactor = normalizedCEF;
        } else if ('customEmissionFactor' in finalScope) {
          finalScope.customEmissionFactor = prev.customEmissionFactor || null;
        }

        mergedScopes.push(finalScope);
      }

      // carry over any untouched previous scopes
      for (const leftover of prevScopes) {
        if (!consumed.has(leftover) && !mergedScopes.find(s => s.scopeUid === leftover.scopeUid)) {
          mergedScopes.push(leftover);
        }
      }

      // ✅ prevent duplicate names after rename collisions
      const nameSeen = new Set();
      for (const s of mergedScopes) {
        if (!s.scopeIdentifier || nameSeen.has(s.scopeIdentifier)) {
          return res.status(400).json({
            message: `Duplicate or missing scopeIdentifier "${s.scopeIdentifier || '(empty)'}" after merge. Please use unique names.`
          });
        }
        nameSeen.add(s.scopeIdentifier);
      }

      mergedNode.details.scopeDetails = mergedScopes;
    }

    // 5) Persist
    flowchart.nodes[nodeIndex] = mergedNode;
    flowchart.markModified('nodes'); // 👈 ensure Mongoose tracks deep changes
    flowchart.lastModifiedBy = userId;
    flowchart.version = (flowchart.version || 0) + 1;

    await flowchart.save();

    return res.status(200).json({
      message: 'Node updated successfully',
      node: flowchart.nodes[nodeIndex]
    });
  } catch (error) {
    console.error('Error updating node:', error);
    return res.status(500).json({
      message: 'Failed to update node',
      error: error.message
    });
  }
};
const assignOrUnassignEmployeeHeadToNode = async (req, res) => {
  try {
    const { clientId, nodeId } = req.params;
    const { employeeHeadId } = req.body;

    // Permission check
    const permissionCheck = await canAssignHeadToNode(req.user, clientId);
    if (!permissionCheck.allowed) {
      return res.status(403).json({ 
        message: 'Permission denied', 
        reason: permissionCheck.reason 
      });
    }

    if (req.user.userType !== 'client_admin' && !permissionCheck.allowed) {
      return res.status(403).json({ 
        message: 'Only client admins or authorized consultants can assign/unassign employee heads.' 
      });
    }

    // Find the flowchart
    const flowchart = await Flowchart.findOne({ clientId, isActive: true });
    if (!flowchart) {
      return res.status(404).json({ message: 'Active flowchart not found for this client.' });
    }

    // Find the node
    const node = flowchart.nodes.find(n => n.id === nodeId);
    if (!node) {
      return res.status(404).json({ message: 'Node not found in the flowchart.' });
    }

    // If employeeHeadId is provided: ASSIGN
    if (employeeHeadId) {
      const employeeHead = await User.findOne({ 
        _id: employeeHeadId, 
        userType: 'client_employee_head', 
        clientId 
      });

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

    // Else: UNASSIGN
    if (!node.details.employeeHeadId) {
      return res.status(400).json({ message: 'No employee head is currently assigned to this node.' });
    }

    node.details.employeeHeadId = null;

    await flowchart.save();

    return res.status(200).json({
      message: 'Employee head unassigned from node successfully.',
      nodeId: node.id
    });

  } catch (error) {
    console.error('Error assigning/unassigning employee head to node:', error);
    res.status(500).json({ 
      message: 'Failed to assign/unassign employee head to node.', 
      error: error.message 
    });
  }
};


module.exports = {
  saveFlowchart,
  getFlowchart,
  getAllFlowcharts,
  deleteFlowchart,
  deleteFlowchartNode,
  restoreFlowchart,
  getFlowchartSummary,
  getConsolidatedSummary,
  updateFlowchartNode,
  assignOrUnassignEmployeeHeadToNode,
};