// controllers/processflowController.js
const ProcessFlowchart = require('../../models/Organization/ProcessFlowchart');
const Client = require('../../models/CMS/Client');
const User = require('../../models/User');
const mongoose = require('mongoose');
const Notification = require('../../models/Notification/Notification')

const { v4: uuidv4 } = require('uuid');

// Import helper functions
const {
  validateScopeDetails,
  normalizeNodes,
  normalizeEdges,
  createChartNotifications,
  isChartAvailable,
  getChartUnavailableMessage,
  addCEFCommentsToNodes,
   ensureCEFComments,
    numOrNull
} = require('../../utils/chart/chartHelpers');


// Import existing permission and workflow functions
const {autoUpdateProcessFlowchartStatus}  = require('../../utils/Workflow/workflow');
const {canManageProcessFlowchart, canAssignHeadToNode, getNormalizedLevels, canAccessProcess} = require('../../utils/Permissions/permissions');

const {
  validateAllocations,
  buildAllocationIndex,
  getAllocationSummary,
  formatValidationError
} = require('../../utils/allocation/allocationHelpers');

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

    // 👉 Sandbox flags
    const isSandboxClient = client.sandbox === true;
    const isSandboxUser   = req.user.sandbox === true;

    // ❗ For NON-sandbox clients we keep the strict rule:
    //    process flowcharts can only be created for active clients.
    // ✅ For sandbox clients we SKIP this stage check so that you can test before "active".
    if (!isSandboxClient && client.stage !== 'active') {
      return res.status(400).json({ 
        message: 'Process flowcharts can only be created for active clients' 
      });
    }

    // 3) Check process flowchart availability (array-aware)
    const normLevels = getNormalizedLevels(client);  // ['process', ...] as applicable

    // ❗ For NON-sandbox clients, still enforce assessmentLevel.
    // ✅ For sandbox clients, allow even if assessmentLevel doesn't yet include 'process'.
    if (!isSandboxClient && !canAccessProcess(client)) {
      return res.status(403).json({
        message: 'Process flowchart is not available for this client',
        reason: 'assessmentLevel does not include "process"',
        assessmentLevel: normLevels,
        required: 'process'
      });
    }
    // keep a normalized value for downstream usage
    const assessmentLevel = normLevels;

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
    
    // Add CEF comments to nodes
    const normalizedNodesWithComments = addCEFCommentsToNodes(normalizedNodes);

    // 7) Normalize edges - The schema allows for many edges per node.
    const normalizedEdges = normalizeEdges(flowchartData.edges);

    // ============================================================================
    // 🆕 VALIDATE ALLOCATION PERCENTAGES
    // ============================================================================
    // When scopeIdentifiers are shared across multiple nodes, their allocations
    // must sum to 100%. This validation ensures data integrity and prevents
    // double-counting of emissions in processEmissionSummary.
    //
    // RULES:
    // - If scopeIdentifier appears in ONLY ONE node: allocationPct defaults to 100
    // - If scopeIdentifier appears in MULTIPLE nodes: sum must equal 100% (±0.01%)
    // ============================================================================
    const allocationValidation = validateAllocations(normalizedNodesWithComments, {
      includeFromOtherChart: false,  // Exclude scopes imported from organization flowchart
      includeDeleted: false          // Exclude soft-deleted scopes
    });

    if (!allocationValidation.isValid) {
      const errorResponse = formatValidationError(allocationValidation);
      return res.status(400).json({
        message: 'Allocation validation failed',
        code: 'ALLOCATION_VALIDATION_FAILED',
        details: errorResponse,
        hint: 'When a scopeIdentifier appears in multiple nodes, the sum of allocationPct across all nodes must equal 100%',
        affectedScopeIdentifiers: allocationValidation.errors.map(e => ({
          scopeIdentifier: e.scopeIdentifier,
          currentSum: e.currentSum,
          expectedSum: 100,
          nodes: e.entries.map(en => ({
            nodeId: en.nodeId,
            nodeLabel: en.nodeLabel,
            allocationPct: en.allocationPct
          }))
        }))
      });
    }

    // Log warnings but allow save to proceed
    if (allocationValidation.warnings.length > 0) {
      console.warn('⚠️ Allocation warnings for client', clientId, ':', allocationValidation.warnings);
    }

    // ============================================================================
    // 8) Find existing or create new
    // ============================================================================
    let processFlowchart = await ProcessFlowchart.findOne({ 
      clientId, 
      isDeleted: false 
    });

    let isNew = false;

    if (processFlowchart) {
      // Update existing
      // 🆕 Use normalizedNodesWithComments (includes allocation data)
      processFlowchart.nodes = normalizedNodesWithComments;
      processFlowchart.edges = normalizedEdges;
      processFlowchart.lastModifiedBy = userId;
      processFlowchart.version = (processFlowchart.version || 0) + 1;
    } else {
      // Create new
      isNew = true;
      processFlowchart = new ProcessFlowchart({
        clientId,
        // 🆕 Use normalizedNodesWithComments (includes allocation data)
        nodes: normalizedNodesWithComments,
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

    const hasOrg  = Array.isArray(assessmentLevel) && assessmentLevel.includes('organization');
    const hasProc = Array.isArray(assessmentLevel) && assessmentLevel.includes('process');

    if (hasProc && !hasOrg) {
      responseData.hasFullScopeDetails = true;
      responseData.message = 'Process flowchart saved with complete scope details (flowchart not available for this assessment level).';
    } else if (hasProc && hasOrg) {
      responseData.hasFullScopeDetails = false;
      responseData.message = 'Process flowchart saved with basic details only (full scope details available in the main flowchart).';
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


// -------------------------------------------------------
// Normalizer - same behaviour as flowchartController
// -------------------------------------------------------
function extractAssessmentLevels(client) {
  if (!client) return [];

  const raw =
    client?.submissionData?.assessmentLevel?.length
      ? client.submissionData.assessmentLevel
      : client?.assessmentLevel?.length
        ? client.assessmentLevel
        : client?.projectProfile?.assessmentLevel
          ? client.projectProfile.assessmentLevel
          : client?.organizationalOverview?.assessmentLevel
            ? client.organizationalOverview.assessmentLevel
            : [];

  const arr = Array.isArray(raw) ? raw : [raw];

  return arr
    .map(v => String(v || '').trim().toLowerCase())
    .flatMap(v => {
      if (v === 'both') return ['organization', 'process'];
      if (v === 'organisation') return ['organization'];
      return [v];
    })
    .filter(Boolean);
}

function includesProcess(levels) {
  return levels.includes('process');
}

// -------------------------------------------------------
// FINAL FIXED getProcessFlowchart
// -------------------------------------------------------
const getProcessFlowchart = async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!clientId) {
      return res.status(400).json({ message: "clientId is required" });
    }

    // ---------------- PERMISSIONS -----------------------
    const user = req.user;
    const userType = user.userType;
    const userClientId = user.clientId || user.client_id;
    const userId = String(user._id || user.id || "");

    let allowed = false;
    let fullAccess = false;

    if (userType === "super_admin") {
      allowed = true;
      fullAccess = true;
    } else if (["consultant_admin", "consultant"].includes(userType)) {
      const can = await canManageProcessFlowchart(user, clientId);
      allowed = !!can.allowed;
      fullAccess = !!can.allowed;
    } else if (userType === "client_admin") {
      allowed = userClientId === clientId;
      fullAccess = allowed;
    } else if (["client_employee_head", "employee", "auditor", "viewer"].includes(userType)) {
      allowed = userClientId === clientId;
      fullAccess = false;
    }

    if (!allowed) {
      return res.status(403).json({ message: "Not allowed for this flowchart" });
    }

    // ---------------- LOAD FLOWCHART --------------------
    const processFlowchart = await ProcessFlowchart.findOne({
      clientId,
      isDeleted: false
    })
      .populate("createdBy", "userName email")
      .populate("lastModifiedBy", "userName email");

    if (!processFlowchart) {
      return res.status(404).json({ message: "Process flowchart not found" });
    }

    // ---------------- LOAD CLIENT + ASSESSMENT LEVEL ----
    const client = await Client.findOne({ clientId }).lean();
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    const effectiveLevels = extractAssessmentLevels(client);

    console.log("DEBUG EFFECTIVE ASSESSMENT LEVELS =", effectiveLevels);

    if (!includesProcess(effectiveLevels)) {
      return res.status(403).json({
        message: "Process flowchart is not available for this client",
        reason: 'assessmentLevel does not include "process"',
        assessmentLevel: effectiveLevels,
      });
    }

    // ---------------- FILTER NODES -----------------------
    const nodes = Array.isArray(processFlowchart.nodes)
      ? processFlowchart.nodes
      : [];

    let filteredNodes = nodes;

    // Safe node (strip sensitive fields)
    const safeNode = (node) => {
      const base = node.toObject ? node.toObject() : node;
      const scopes = (base.details?.scopeDetails || []).filter(s => !s.isDeleted);

      return {
        ...base,
        details: {
          ...base.details,
          scopeDetails: scopes.map(s => ({
            scopeIdentifier: s.scopeIdentifier,
            scopeType: s.scopeType,
            inputType: s.inputType || s.dataCollectionType,
          })),
          emissionFactors: undefined,
          gwp: undefined,
          calculations: undefined,
          formulas: undefined,
        }
      };
    };

    if (!fullAccess) {
      if (userType === "client_employee_head") {
        const assigned = nodes.filter(
          n => String(n.details?.employeeHeadId || '') === userId
        );

        const fallback = nodes.filter(
          n =>
            n.details?.department === user.department ||
            n.details?.location === user.location
        );

        filteredNodes = assigned.length ? assigned : fallback;
      }

      if (userType === "employee") {
        filteredNodes = nodes.reduce((acc, node) => {
          const base = node.toObject ? node.toObject() : node;
          const scopes = base.details?.scopeDetails || [];

          const assignedScopes = scopes.filter(s =>
            (s.assignedEmployees || []).map(x => String(x)).includes(userId)
          );

          if (assignedScopes.length > 0) {
            acc.push({
              ...base,
              details: { ...base.details, scopeDetails: assignedScopes }
            });
          }

          return acc;
        }, []);
      }

      if (["auditor", "viewer"].includes(userType)) {
        filteredNodes = nodes.map(safeNode);
      }
    }

    // ---------------- FILTER EDGES -----------------------
    const getNodeId = (n) =>
      n.id || (n._id && n._id.toString()) || n.data?.id;

    const visible = new Set(filteredNodes.map(getNodeId).filter(Boolean));

    const filteredEdges = (processFlowchart.edges || []).filter(
      e => visible.has(e.source) && visible.has(e.target)
    );

    // ---------------- RETURN -----------------------------
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

  } catch (err) {
    console.error("PROCESS FLOWCHART ERROR:", err);
    return res.status(500).json({ message: "Failed to fetch process flowchart", error: err.message });
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

/**
 * ============================================================================
 * READY-TO-COPY: Updated updateProcessFlowchartNode Function
 * ============================================================================
 * 
 * Replace the existing updateProcessFlowchartNode function in:
 * controllers/Organization/processflowController.js
 * 
 * ALSO ADD this import at the top of the file (after other imports):
 * 
 * const {
 *   validateAllocations,
 *   buildAllocationIndex,
 *   getAllocationSummary,
 *   formatValidationError
 * } = require('../../utils/allocation/allocationHelpers');
 * 
 * ============================================================================
 */

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

    // Load the active (non-deleted) process flowchart
    const processFlowchart = await ProcessFlowchart.findOne({ clientId, isDeleted: false });
    if (!processFlowchart) {
      return res.status(404).json({ message: 'Process flowchart not found' });
    }

    // Locate node
    const nodeIndex = processFlowchart.nodes.findIndex(n => n.id === nodeId);
    if (nodeIndex === -1) {
      return res.status(404).json({ message: 'Node not found' });
    }

    // Plain object of existing node
    const existingNode = (typeof processFlowchart.nodes[nodeIndex].toObject === 'function')
      ? processFlowchart.nodes[nodeIndex].toObject()
      : JSON.parse(JSON.stringify(processFlowchart.nodes[nodeIndex] || {}));

    // ──────────────────────────────────────────────────────────────
    // Helpers
    // ──────────────────────────────────────────────────────────────
    const shallowMerge = (base, patch) => {
      const out = { ...base };
      if (patch && typeof patch === 'object') {
        for (const k of Object.keys(patch)) {
          if (patch[k] !== undefined) out[k] = patch[k];
        }
      }
      return out;
    };

    const numOrNull = (v) => {
      if (v === undefined || v === null || v === '') return null;
      const n = Number(v);
      return Number.isNaN(n) ? null : n;
    };

    const normalizeCustomEF = (cef = {}) => {
      if (!cef || typeof cef !== 'object') return {};
      return { ...cef };
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
      // Prefer incoming EF type
      const finalEF = incomingScope.emissionFactor ?? existingScope.emissionFactor ?? '';

      // Prefer incoming custom EF from nested first, then top-level
      const incomingCEF =
        incomingScope?.emissionFactorValues?.customEmissionFactor
        ?? incomingScope?.customEmissionFactor
        ?? existingScope?.emissionFactorValues?.customEmissionFactor
        ?? existingScope?.customEmissionFactor
        ?? null;

      const normalizedCEF = finalEF === 'Custom' ? normalizeCustomEF(incomingCEF || {}) : null;

      // Merge non-EF fields (without blowing away nested EF blocks)
      const mergedTop = {
        ...existingScope,
        ...Object.fromEntries(
          Object.entries(incomingScope).filter(([k, v]) => k !== 'emissionFactorValues' && v !== undefined)
        ),
        emissionFactor: finalEF
      };

      // Merge EF blocks
      const existingEFVals = existingScope.emissionFactorValues || {};
      const incomingEFVals = incomingScope.emissionFactorValues || {};
      mergedTop.emissionFactorValues = mergeEFBlocks(finalEF, existingEFVals, incomingEFVals, incomingScope);
      if (normalizedCEF) mergedTop.emissionFactorValues.customEmissionFactor = normalizedCEF;

      // Mirror custom EF at top-level for backward compatibility
      if (finalEF === 'Custom') {
        mergedTop.customEmissionFactor = normalizedCEF;
      } else if ('customEmissionFactor' in mergedTop) {
        mergedTop.customEmissionFactor = existingScope.customEmissionFactor || null;
      }

      // Ensure presence of CEF comment siblings (if you added that helper earlier)
      if (finalEF === 'Custom') {
        mergedTop.emissionFactorValues.customEmissionFactor =
          ensureCEFComments(mergedTop.emissionFactorValues.customEmissionFactor || {});
        mergedTop.customEmissionFactor =
          ensureCEFComments(mergedTop.customEmissionFactor || {});
      }

      // Carry UAD / UEF if present
      if (incomingScope.UAD !== undefined) mergedTop.UAD = incomingScope.UAD;
      if (incomingScope.UEF !== undefined) mergedTop.UEF = incomingScope.UEF;

      // ──────────────────────────────────────────────────────────────
      // 🆕 PRESERVE ALLOCATION PERCENTAGE
      // ──────────────────────────────────────────────────────────────
      // If incoming has allocationPct, use it; otherwise keep existing
      if (incomingScope.allocationPct !== undefined) {
        mergedTop.allocationPct = incomingScope.allocationPct;
      } else if (existingScope.allocationPct !== undefined) {
        mergedTop.allocationPct = existingScope.allocationPct;
      }
      // Note: If neither has it, the schema default (100) will be used

      // ── Merge customValues (optional) ─────────────────────────────
      const incCV  = incomingScope.customValues || incomingScope.customValue || {};
      const prevCV = existingScope.customValues || {};
      const mergedCV = {
        assetLifetime:        numOrNull( incCV.assetLifetime ?? incCV.AssetLifeTime ?? incCV.AssestLifeTime ?? incCV.assetLifeTime ?? prevCV.assetLifetime ?? null ),
        TDLossFactor:         numOrNull( incCV.TDLossFactor ?? incCV['T&DLossFactor'] ?? incCV.TAndDLossFactor ?? prevCV.TDLossFactor ?? null ),
        defaultRecyclingRate: numOrNull( incCV.defaultRecyclingRate ?? incCV.defaultRecylingRate ?? incCV.defaultRecycleRate ?? prevCV.defaultRecyclingRate ?? null ),
        equitySharePercentage: numOrNull( incCV.equitySharePercentage ?? incCV.EquitySharePercentage ?? prevCV.equitySharePercentage ?? null ),
        averageLifetimeEnergyConsumption: numOrNull( incCV.averageLifetimeEnergyConsumption ?? incCV.AverageLifetimeEnergyConsumption ?? prevCV.averageLifetimeEnergyConsumption ?? null ),
        usePattern: numOrNull( incCV.usePattern ?? incCV.UsePattern ?? prevCV.usePattern ?? null ),
        energyEfficiency: numOrNull( incCV.energyEfficiency ?? incCV.EnergyEfficiency ?? prevCV.energyEfficiency ?? null ),
        toIncineration:    numOrNull( incCV.toIncineration ?? incCV.ToIncineration ?? prevCV.toIncineration ?? null ),
        toLandfill:        numOrNull( incCV.toLandfill ?? incCV.ToLandfill ?? prevCV.toLandfill ?? null ),
        toDisposal:       numOrNull( incCV.toDisposal ?? incCV.ToRecycling ?? prevCV.toDisposal ?? null ),          
      };
      if (
        mergedCV.assetLifetime != null ||
        mergedCV.TDLossFactor != null ||
        mergedCV.defaultRecyclingRate != null ||
        mergedCV.equitySharePercentage != null ||
        mergedCV.averageLifetimeEnergyConsumption != null ||
        mergedCV.usePattern != null ||
        mergedCV.energyEfficiency != null ||
        mergedCV.toIncineration != null ||
        mergedCV.toLandfill != null ||
        mergedCV.toDisposal != null
      ) {
        mergedTop.customValues = mergedCV;
      }

      return mergedTop;
    };

    // ──────────────────────────────────────────────────────────────
    // Merge node shallow props
    // ──────────────────────────────────────────────────────────────
    const mergedNode = {
      ...existingNode,
      ...(nodeData && typeof nodeData === 'object' ? nodeData : {}),
      id: nodeId
    };

    // Merge details shallowly
    mergedNode.details = shallowMerge(existingNode.details || {}, (nodeData && nodeData.details) || {});

    // ──────────────────────────────────────────────────────────────
    // ScopeDetails merge with RENAME SUPPORT
    // ──────────────────────────────────────────────────────────────
    const incomingScopes = (nodeData && nodeData.details && Array.isArray(nodeData.details.scopeDetails))
      ? nodeData.details.scopeDetails
      : null;

    if (incomingScopes) {
      const prevScopes = Array.isArray(existingNode.details?.scopeDetails) ? existingNode.details.scopeDetails : [];

      // Ensure stable UID on existing scopes
      for (const s of prevScopes) {
        if (!s.scopeUid) s.scopeUid = s.scopeUid || s.uid || s._id || uuidv4();
      }

      // Indexes for matching
      const prevByUid  = new Map(prevScopes.map(s => [(s.scopeUid || s._id || s.scopeIdentifier), s]));
      const prevByName = new Map(prevScopes.map(s => [s.scopeIdentifier, s]));
      const consumed   = new Set();

      const pickExistingFor = (inc) => {
        // 1) by stable UID
        if (inc.scopeUid && prevByUid.has(inc.scopeUid)) return prevByUid.get(inc.scopeUid);

        // 2) by new name (post-rename or unchanged)
        if (inc.scopeIdentifier && prevByName.has(inc.scopeIdentifier)) return prevByName.get(inc.scopeIdentifier);

        // 3) by any provided previous/old/original name
        for (const k of ['previousScopeIdentifier', 'oldScopeIdentifier', 'originalScopeIdentifier']) {
          const oldName = inc?.[k];
          if (oldName && prevByName.has(oldName)) return prevByName.get(oldName);
        }

        // 4) heuristic: same type + category + activity (unconsumed)
        const cand = prevScopes.find(s =>
          !consumed.has(s) &&
          (s.scopeType || '') === (inc.scopeType || '') &&
          (s.categoryName || '') === (inc.categoryName || '') &&
          (s.activity || '') === (inc.activity || '')
        );
        return cand || null;
      };

      const mergedScopes = [];

      for (const incRaw of incomingScopes) {
        const inc = { ...incRaw };
        // ensure a scopeUid on incoming
        if (!inc.scopeUid) inc.scopeUid = inc.scopeUid || inc.uid || inc._id || uuidv4();

        const prev = pickExistingFor(inc) || {};
        if (prev && prev.scopeUid) consumed.add(prev);

        const finalScope = mergeScopeDetail(prev, inc);

        // Ensure stable identity & final name (new name wins on rename)
        finalScope.scopeUid = inc.scopeUid || prev.scopeUid || uuidv4();
        finalScope.scopeIdentifier = inc.scopeIdentifier || prev.scopeIdentifier || '';

        mergedScopes.push(finalScope);
      }

      // Carry forward any untouched previous scopes
      for (const leftover of prevScopes) {
        if (!consumed.has(leftover) && !mergedScopes.find(s => s.scopeUid === leftover.scopeUid)) {
          mergedScopes.push(leftover);
        }
      }

      // Validate duplicate/missing names after merge
      const nameSeen = new Set();
      for (const s of mergedScopes) {
        const name = (s.scopeIdentifier || '').trim();
        if (!name || nameSeen.has(name)) {
          return res.status(400).json({
            message: `Duplicate or missing scopeIdentifier "${name || '(empty)'}" after merge. Please ensure unique, non-empty names.`
          });
        }
        nameSeen.add(name);
      }

      mergedNode.details.scopeDetails = mergedScopes;
    }

    // ============================================================================
    // 🆕 VALIDATE ALLOCATION PERCENTAGES BEFORE SAVE
    // ============================================================================
    // When a scopeIdentifier appears in multiple nodes, the sum of allocationPct
    // across all nodes must equal 100% (with ±0.01% tolerance for rounding).
    // 
    // This validation ensures:
    // - No double-counting of emissions
    // - Proper split of emissions across nodes sharing a scopeIdentifier
    // - Clear error messages when allocations are invalid
    // ============================================================================
    
    // Update the node in the array first (so validation sees the updated state)
    processFlowchart.nodes[nodeIndex] = mergedNode;
    
    // Import validation function (ensure this is imported at top of file)
    // const { validateAllocations, formatValidationError } = require('../../utils/allocation/allocationHelpers');
    
    const allocationValidation = validateAllocations(processFlowchart.nodes, {
      includeFromOtherChart: false,  // Exclude scopes imported from organization flowchart
      includeDeleted: false          // Exclude soft-deleted scopes
    });

    if (!allocationValidation.isValid) {
      const errorResponse = formatValidationError(allocationValidation);
      return res.status(400).json({
        message: 'Allocation validation failed',
        code: 'ALLOCATION_VALIDATION_FAILED',
        details: errorResponse,
        hint: 'When a scopeIdentifier appears in multiple nodes, the sum of allocationPct across all nodes must equal 100%',
        affectedScopeIdentifiers: allocationValidation.errors.map(e => ({
          scopeIdentifier: e.scopeIdentifier,
          currentSum: e.currentSum,
          nodes: e.entries.map(en => ({
            nodeId: en.nodeId,
            nodeLabel: en.nodeLabel,
            allocationPct: en.allocationPct
          }))
        }))
      });
    }

    // Log warnings but allow save to proceed
    if (allocationValidation.warnings.length > 0) {
      console.warn('⚠️ Allocation warnings for client', clientId, ':', allocationValidation.warnings);
    }

    // ============================================================================
    // SAVE TO DATABASE
    // ============================================================================
    processFlowchart.markModified('nodes'); // ensure Mongoose tracks deep nested changes
    processFlowchart.lastModifiedBy = req.user?._id || req.user?.id || null;

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

// Assign employees to a scope of a PROCESS node (Employee Head only)
const assignScopeToProcessNode = async (req, res) => {
  try {
    // 1) Guard: only Employee Heads can assign scopes
    if (req.user.userType !== 'client_employee_head') {
      return res.status(403).json({
        message: 'Only Employee Heads can assign employees to scopes'
      });
    }

    const { clientId, nodeId } = req.params;
    const { scopeIdentifier, employeeIds } = req.body;

    // 2) Validate input
    if (!clientId || !nodeId || !scopeIdentifier || !Array.isArray(employeeIds)) {
      return res.status(400).json({
        message: 'clientId, nodeId, scopeIdentifier and employeeIds[] are required'
      });
    }
    if (employeeIds.length === 0) {
      return res.status(400).json({ message: 'At least one employee must be assigned' });
    }

    // 3) Same-org check
    if (String(req.user.clientId) !== String(clientId)) {
      return res.status(403).json({ message: 'You can only assign within your organization' });
    }

    // 4) Load the specific node from PROCESS flowchart
    const flow = await ProcessFlowchart.findOne(
      { clientId, 'nodes.id': nodeId, isDeleted: false },
      { 'nodes.$': 1 }
    );

    if (!flow || !flow.nodes || flow.nodes.length === 0) {
      return res.status(404).json({ message: 'Process flowchart or node not found' });
    }

    const node = flow.nodes[0];

    // 5) Verify this head is assigned to this PROCESS node
    const assignedHeadId = node?.details?.employeeHeadId ? String(node.details.employeeHeadId) : null;
    const currentUserId  = req.user.id ? String(req.user.id) : (req.user._id ? String(req.user._id) : null);

    if (!assignedHeadId || assignedHeadId !== currentUserId) {
      return res.status(403).json({
        message: 'You are not authorized to manage this node. Only the assigned Employee Head can assign scopes.'
      });
    }

    // 6) Locate the specific scope
    const scope = (node.details?.scopeDetails || []).find(s => s.scopeIdentifier === scopeIdentifier);
    if (!scope) {
      return res.status(404).json({ message: `Scope detail '${scopeIdentifier}' not found in this node` });
    }

    // 7) Validate employee IDs (must be active employees of this client)
    const employees = await User.find({
      _id: { $in: employeeIds },
      userType: 'employee',
      clientId,
      isActive: true
    });

    if (employees.length !== employeeIds.length) {
      return res.status(400).json({ message: 'One or more employees not found or not in your organization' });
    }

    // 8) Remove any existing occurrences for these employees in this scope
    await ProcessFlowchart.updateOne(
      { clientId, 'nodes.id': nodeId },
      {
        $pull: {
          'nodes.$[n].details.scopeDetails.$[s].assignedEmployees': { $in: employeeIds }
        }
      },
      {
        arrayFilters: [{ 'n.id': nodeId }, { 's.scopeIdentifier': scopeIdentifier }]
      }
    );

    // 9) Add them back (unique) + set metadata
    const upd = await ProcessFlowchart.updateOne(
      { clientId, 'nodes.id': nodeId },
      {
        $addToSet: {
          'nodes.$[n].details.scopeDetails.$[s].assignedEmployees': { $each: employeeIds }
        },
        $set: {
          'nodes.$[n].details.scopeDetails.$[s].lastAssignedAt': new Date(),
          'nodes.$[n].details.scopeDetails.$[s].assignedBy': req.user._id
        }
      },
      {
        arrayFilters: [{ 'n.id': nodeId }, { 's.scopeIdentifier': scopeIdentifier }]
      }
    );

    if (upd.modifiedCount === 0) {
      return res.status(500).json({ message: 'Failed to update process flowchart scope assignments' });
    }

    // 10) Update employee documents (mirror of Flowchart assigner)
    const scopeAssignment = {
      nodeId,
      nodeLabel: node.label,
      nodeType:   node.details?.nodeType || 'unknown',
      department: node.details?.department || 'unknown',
      location:   node.details?.location || 'unknown',
      scopeIdentifier,
      scopeType:  scope.scopeType,
      inputType:  scope.inputType,
      assignedAt: new Date(),
      assignedBy: req.user._id
    };

    await User.updateMany(
      { _id: { $in: employeeIds } },
      {
        $set: { employeeHeadId: req.user._id },
        $addToSet: { assignedModules: JSON.stringify(scopeAssignment) }
      }
    );

    // Prepare response
    return res.status(200).json({
      message: 'Employees successfully assigned to scope',
      assignment: {
        scope: {
          identifier: scopeIdentifier,
          type: scope.scopeType,
          inputType: scope.inputType
        },
        node: {
          id: nodeId,
          label: node.label,
          department: node.details?.department,
          location: node.details?.location
        },
        employees: employees.map(e => ({ id: e._id, name: e.userName, email: e.email })),
        assignedBy: req.user.userName,
        assignedAt: new Date()
      }
    });
  } catch (error) {
    console.error('❌ Error in assignScopeToProcessNode:', error);
    return res.status(500).json({
      message: 'Error assigning employees to scope (process flowchart)',
      error: error.message
    });
  }
};


// Remove employees from a PROCESS node scope (Employee Head only)
const removeAssignmentProcess = async (req, res) => {
  try {
    // 1) Only Employee Heads can remove employees from scopes
    if (req.user.userType !== 'client_employee_head') {
      return res.status(403).json({
        message: 'Only Employee Heads can remove employees from scopes (process flowchart)'
      });
    }

    const { clientId, nodeId } = req.params;
    const { scopeIdentifier, employeeIds } = req.body;

    // 2) Validate input
    if (!clientId || !nodeId || !scopeIdentifier || !Array.isArray(employeeIds)) {
      return res.status(400).json({
        message: 'clientId, nodeId, scopeIdentifier and employeeIds[] are required'
      });
    }

    if (employeeIds.length === 0) {
      return res.status(400).json({
        message: 'At least one employee must be provided to remove'
      });
    }

    // 3) Same-organization check
    if (String(req.user.clientId) !== String(clientId)) {
      return res.status(403).json({
        message: 'You can only manage assignments within your organization'
      });
    }

    // 4) Load the specific node from PROCESS flowchart
    const flow = await ProcessFlowchart.findOne(
      { clientId, 'nodes.id': nodeId, isDeleted: false },
      { 'nodes.$': 1 }
    );

    if (!flow || !flow.nodes || flow.nodes.length === 0) {
      return res.status(404).json({ message: 'Process flowchart or node not found' });
    }

    const node = flow.nodes[0];

    // 5) Verify this Employee Head is assigned to this PROCESS node
    const assignedHeadId = node?.details?.employeeHeadId
      ? String(node.details.employeeHeadId)
      : null;
    const currentUserId = req.user.id
      ? String(req.user.id)
      : (req.user._id ? String(req.user._id) : null);

    if (!assignedHeadId || assignedHeadId !== currentUserId) {
      return res.status(403).json({
        message:
          'You are not authorized to manage this node. Only the assigned Employee Head can remove scope assignments.'
      });
    }

    // 6) Locate the specific scope
    const scope = (node.details?.scopeDetails || []).find(
      s => s.scopeIdentifier === scopeIdentifier
    );
    if (!scope) {
      return res.status(404).json({
        message: `Scope detail '${scopeIdentifier}' not found in this node`
      });
    }

    // 7) Remove employees from this scope's assignedEmployees
    await ProcessFlowchart.updateOne(
      { clientId, 'nodes.id': nodeId },
      {
        $pull: {
          'nodes.$[n].details.scopeDetails.$[s].assignedEmployees': {
            $in: employeeIds
          }
        }
      },
      {
        arrayFilters: [
          { 'n.id': nodeId },
          { 's.scopeIdentifier': scopeIdentifier }
        ]
      }
    );

    // 8) Remove the assignment records from each employee's assignedModules
    await User.updateMany(
      { _id: { $in: employeeIds } },
      {
        $pull: {
          assignedModules: {
            // same pattern as removeAssignment in userController
            $regex: `.*"nodeId":"${nodeId}".*"scopeIdentifier":"${scopeIdentifier}".*`
          }
        }
      }
    );

    return res.status(200).json({
      message: 'Employees removed from process scope successfully',
      node: {
        id: nodeId,
        label: node.label,
        department: node.details?.department,
        location: node.details?.location
      },
      scope: {
        scopeIdentifier,
        scopeType: scope.scopeType,
        inputType: scope.inputType
      },
      removedEmployees: employeeIds
    });
  } catch (error) {
    console.error('❌ Error in removeAssignmentProcess:', error);
    return res.status(500).json({
      message: 'Error removing employees from scope (process flowchart)',
      error: error.message
    });
  }
};



function findScopeIndex(scopes, { scopeUid, scopeIdentifier }) {
  if (!Array.isArray(scopes)) return -1;
  return scopes.findIndex(s =>
    (scopeUid && (String(s.scopeUid) === String(scopeUid) || String(s._id) === String(scopeUid))) ||
    (scopeIdentifier && s.scopeIdentifier === scopeIdentifier)
  );
}



const hardDeleteProcessScopeDetail = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;
    const { scopeUid } = req.query || {};

    const canManage = await canManageProcessFlowchart(req.user, clientId);
    if (!canManage) return res.status(403).json({ message: 'Permission denied' });

    const pf = await ProcessFlowchart.findOne({ clientId, isDeleted: false });
    if (!pf) return res.status(404).json({ message: 'Process flowchart not found' });

    const node = pf.nodes.find(n => n.id === nodeId);
    if (!node) return res.status(404).json({ message: 'Node not found' });

    const scopes = node?.details?.scopeDetails || [];
    const idx = findScopeIndex(scopes, { scopeUid, scopeIdentifier });
    if (idx === -1) return res.status(404).json({ message: 'Scope detail not found' });

    const removed = scopes.splice(idx, 1)[0];

    pf.markModified('nodes');
    pf.version = (pf.version || 0) + 1;
    pf.lastModifiedBy = req.user._id || req.user.id;
    await pf.save();

    res.status(200).json({
      message: 'Scope detail permanently deleted (process)',
      nodeId,
      scope: {
        scopeIdentifier: removed?.scopeIdentifier,
        scopeUid: removed?.scopeUid || removed?._id
      }
    });
  } catch (err) {
    console.error('hardDeleteProcessScopeDetail error:', err);
    res.status(500).json({ message: 'Failed to delete scope detail', error: err.message });
  }
};


/**
 * GET /api/process-flowchart/:clientId/allocations
 * 
 * Returns a summary of all scopeIdentifier allocations in the ProcessFlowchart.
 * Useful for debugging and displaying allocation information in the UI.
 */
const getAllocations = async (req, res) => {
  try {
    const { clientId } = req.params;
    
    // Permission check
    const ProcessFlowchart = require('../../models/Organization/ProcessFlowchart');
    const { canAccessProcess, getNormalizedLevels } = require('../../utils/Permissions/permissions');
    const Client = require('../../models/CMS/Client');
    
    const client = await Client.findOne({ clientId }).lean();
    if (!client) {
      return res.status(404).json({ message: 'Client not found' });
    }
    
    const levels = getNormalizedLevels(client);
    if (!canAccessProcess(client)) {
      return res.status(403).json({
        message: 'Process flowchart is not available for this client',
        assessmentLevel: levels
      });
    }
    
    // Load ProcessFlowchart
    const processFlowchart = await ProcessFlowchart.findOne({
      clientId,
      isDeleted: false
    }).lean();
    
    if (!processFlowchart) {
      return res.status(404).json({ message: 'Process flowchart not found' });
    }
    
    // Import helpers
    const { buildAllocationIndex, getAllocationSummary, validateAllocationIndex } = require('../../utils/allocation/allocationHelpers');
    
    // Build allocation index and summary
    const allocationIndex = buildAllocationIndex(processFlowchart, {
      includeFromOtherChart: false,
      includeDeleted: false
    });
    
    const summary = getAllocationSummary(allocationIndex);
    const validation = validateAllocationIndex(allocationIndex);
    
    return res.status(200).json({
      success: true,
      clientId,
      allocations: summary,
      validation: {
        isValid: validation.isValid,
        errorCount: validation.errors.length,
        warningCount: validation.warnings.length,
        errors: validation.errors,
        warnings: validation.warnings
      }
    });
    
  } catch (error) {
    console.error('Get allocations error:', error);
    return res.status(500).json({
      message: 'Failed to get allocations',
      error: error.message
    });
  }
};

/**
 * PATCH /api/process-flowchart/:clientId/allocations
 * 
 * Update allocation percentages for one or more scopeIdentifiers.
 * 
 * Request body:
 * {
 *   "allocations": [
 *     {
 *       "scopeIdentifier": "Electricity_Main",
 *       "nodeAllocations": [
 *         { "nodeId": "node-1", "allocationPct": 30 },
 *         { "nodeId": "node-2", "allocationPct": 70 }
 *       ]
 *     }
 *   ]
 * }
 */
const updateAllocations = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { allocations } = req.body;
    
    if (!allocations || !Array.isArray(allocations) || allocations.length === 0) {
      return res.status(400).json({
        message: 'Request body must contain an "allocations" array'
      });
    }
    
    // Permission check
    const ProcessFlowchart = require('../../models/Organization/ProcessFlowchart');
    const { canManageProcessFlowchart } = require('../../utils/Permissions/permissions');
    
    const canManage = await canManageProcessFlowchart(req.user, clientId);
    if (!canManage) {
      return res.status(403).json({
        message: 'You do not have permission to manage this process flowchart'
      });
    }
    
    // Load ProcessFlowchart
    const processFlowchart = await ProcessFlowchart.findOne({
      clientId,
      isDeleted: false
    });
    
    if (!processFlowchart) {
      return res.status(404).json({ message: 'Process flowchart not found' });
    }
    
    // Validate each allocation update
    const updateErrors = [];
    const updates = [];
    
    for (const alloc of allocations) {
      const { scopeIdentifier, nodeAllocations } = alloc;
      
      if (!scopeIdentifier || !nodeAllocations || !Array.isArray(nodeAllocations)) {
        updateErrors.push({
          scopeIdentifier: scopeIdentifier || 'UNKNOWN',
          error: 'Invalid allocation format: must have scopeIdentifier and nodeAllocations array'
        });
        continue;
      }
      
      // Validate sum = 100
      const sum = nodeAllocations.reduce((s, na) => s + (na.allocationPct || 0), 0);
      if (Math.abs(sum - 100) > 0.01) {
        updateErrors.push({
          scopeIdentifier,
          error: `Allocations must sum to 100%, got ${sum.toFixed(2)}%`,
          nodeAllocations
        });
        continue;
      }
      
      // Validate each node allocation
      for (const na of nodeAllocations) {
        if (!na.nodeId) {
          updateErrors.push({
            scopeIdentifier,
            error: 'Each nodeAllocation must have a nodeId'
          });
          continue;
        }
        
        if (na.allocationPct < 0 || na.allocationPct > 100) {
          updateErrors.push({
            scopeIdentifier,
            nodeId: na.nodeId,
            error: `allocationPct must be between 0 and 100, got ${na.allocationPct}`
          });
          continue;
        }
        
        updates.push({
          scopeIdentifier,
          nodeId: na.nodeId,
          allocationPct: na.allocationPct
        });
      }
    }
    
    if (updateErrors.length > 0) {
      return res.status(400).json({
        message: 'Allocation validation errors',
        errors: updateErrors
      });
    }
    
    // Apply updates
    let updatedCount = 0;
    
    for (const update of updates) {
      for (const node of processFlowchart.nodes) {
        if (node.id !== update.nodeId) continue;
        
        const scopeDetails = node.details?.scopeDetails || [];
        for (const scope of scopeDetails) {
          if (scope.scopeIdentifier === update.scopeIdentifier && !scope.isDeleted) {
            scope.allocationPct = update.allocationPct;
            updatedCount++;
          }
        }
      }
    }
    
    // Mark as modified and save
    processFlowchart.markModified('nodes');
    processFlowchart.lastModifiedBy = req.user._id || req.user.id;
    await processFlowchart.save();
    
    // Import helpers for response
    const { buildAllocationIndex, getAllocationSummary, validateAllocationIndex } = require('../../utils/allocation/allocationHelpers');
    
    const allocationIndex = buildAllocationIndex(processFlowchart, {
      includeFromOtherChart: false,
      includeDeleted: false
    });
    
    const summary = getAllocationSummary(allocationIndex);
    const validation = validateAllocationIndex(allocationIndex);
    
    return res.status(200).json({
      success: true,
      message: `Updated ${updatedCount} allocation(s)`,
      updatedCount,
      allocations: summary,
      validation: {
        isValid: validation.isValid,
        errorCount: validation.errors.length,
        warningCount: validation.warnings.length
      }
    });
    
  } catch (error) {
    console.error('Update allocations error:', error);
    return res.status(500).json({
      message: 'Failed to update allocations',
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
  assignOrUnassignEmployeeHeadToNode,
  assignScopeToProcessNode,
  removeAssignmentProcess,  
  hardDeleteProcessScopeDetail,
  getAllocations,
  updateAllocations  
};