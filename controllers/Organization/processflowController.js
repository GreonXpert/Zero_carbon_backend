// controllers/processflowController.js
const ProcessFlowchart = require('../../models/Organization/ProcessFlowchart');
const Client = require('../../models/CMS/Client');
const User = require('../../models/User');
const mongoose = require('mongoose');
const Notification = require('../../models/Notification/Notification')

const ProcessEmissionDataEntry = require('../../models/Organization/ProcessEmissionDataEntry');

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

// Audit log helpers for the process_flowchart module
const {
  logProcessFlowCreate,
  logProcessFlowUpdate,
  logProcessFlowDelete,
  logProcessFlowNodeAssign,
  logProcessFlowScopeAssign,
  logProcessFlowScopeUnassign,
  logProcessFlowAllocationUpdate,
  logProcessFlowEmissionFactorUpdate,
} = require('../../services/audit/processFlowchartAuditLog');

/**
 * Returns true if two emissionFactors arrays differ (by JSON comparison).
 */
const _pfEmissionFactorsChanged = (existingEFs = [], incomingEFs = []) =>
  JSON.stringify(existingEFs) !== JSON.stringify(incomingEFs);

/**
 * For an array of scopeDetail objects, detect Employee Commuting Tier 2 scopes
 * whose emissionFactors changed, append to their emissionFactorHistory, and
 * return a list of { scopeIdentifier, previousEFs, newEFs } for audit logging.
 */
const _pfDetectAndRecordEFChanges = (prevScopesArr, newScopesArr, changedByUserId) => {
  const efChanges = [];
  const prevMap = new Map((prevScopesArr || []).map(s => [s.scopeIdentifier, s]));

  for (const scope of (newScopesArr || [])) {
    const isECTier2 = (
      scope.scopeType === 'Scope 3' &&
      (scope.categoryName || '').toLowerCase() === 'employee commuting' &&
      scope.calculationModel === 'tier 2'
    );
    if (!isECTier2) continue;
    if (!Array.isArray(scope.employeeCommutingEmissionFactors)) continue;

    const prev = prevMap.get(scope.scopeIdentifier);
    const previousEFs = prev?.employeeCommutingEmissionFactors ?? [];
    const newEFs = scope.employeeCommutingEmissionFactors;

    if (_pfEmissionFactorsChanged(previousEFs, newEFs)) {
      scope.emissionFactorHistory = [
        ...(prev?.emissionFactorHistory ?? []),
        {
          previousEmissionFactors: previousEFs,
          newEmissionFactors: newEFs,
          changedAt: new Date(),
          changedBy: changedByUserId ?? null,
        },
      ];
      efChanges.push({ scopeIdentifier: scope.scopeIdentifier, previousEFs, newEFs });
    }
  }
  return efChanges;
};

   const {
     checkFlowchartQuota,
     getAssignedConsultantId,
     isQuotaSubject,
     getQuotaStatus,
   } = require('../../services/quota/quotaService');


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

    // ─────────────────────────────────────────────────────────
    // 5.5) QUOTA CHECK
    // ─────────────────────────────────────────────────────────
    if (isQuotaSubject(req.user.userType)) {
      const assignedConsultantId = await getAssignedConsultantId(clientId);

      if (!assignedConsultantId) {
        return res.status(403).json({
          success: false,
          message: 'This client does not have an assigned consultant. Assign a consultant first.',
          code: 'NO_ASSIGNED_CONSULTANT',
        });
      }

      const incomingNodes = Array.isArray(flowchartData.nodes) ? flowchartData.nodes : [];
      const countableNodes = incomingNodes.map((n) => ({
        details: {
          scopeDetails: (n.details?.scopeDetails || []).filter((s) => !s.isDeleted),
        },
      }));

      const quotaResult = await checkFlowchartQuota({
        clientId,
        consultantId: assignedConsultantId,
        nodes:        countableNodes,
        chartType:    'processFlowchart',
      });

      if (!quotaResult.allowed) {
        return res.status(422).json({
          success: false,
          message: 'Process flowchart creation quota exceeded.',
          code: 'QUOTA_EXCEEDED',
          quotaErrors: quotaResult.errors.map((e) => ({
            resource:  e.resource,
            limit:     e.limit,
            used:      e.used,
            remaining: e.remaining,
            attempted: e.newTotal,
            message:   e.message,
          })),
        });
      }
    }
    // ─────────────────────────────────────────────────────────

    // 6) Normalize nodes based on assessmentLevel
    const normalizedNodes = normalizeNodes(flowchartData.nodes, assessmentLevel, 'processFlowchart');
    
    // Add CEF comments to nodes
    const normalizedNodesWithComments = addCEFCommentsToNodes(normalizedNodes);

    // 7) Normalize edges - The schema allows for many edges per node.
    const normalizedEdges = normalizeEdges(flowchartData.edges);

    // ============================================================================
    // 🆕 VALIDATE ALLOCATION PERCENTAGES (COMPLETE FLOWCHART STATE)
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

      // ── EC Tier 2 EF change detection (per-node, per-scope) ───────────────
      const _savePFEFChanges = [];
      const _oldPFNodeMap = new Map((processFlowchart.nodes || []).map(n => [n.id, n]));
      for (const newNode of normalizedNodesWithComments) {
        const oldNode = _oldPFNodeMap.get(newNode.id);
        const oldScopes = oldNode?.details?.scopeDetails ?? [];
        const newScopes = newNode?.details?.scopeDetails ?? [];
        const changes = _pfDetectAndRecordEFChanges(oldScopes, newScopes, userId);
        for (const c of changes) {
          _savePFEFChanges.push({ nodeId: newNode.id, ...c });
        }
      }

      processFlowchart.nodes = normalizedNodesWithComments;
      processFlowchart.edges = normalizedEdges;
      processFlowchart.lastModifiedBy = userId;
      processFlowchart.version = (processFlowchart.version || 0) + 1;
    } else {
      // Create new
      isNew = true;
      processFlowchart = new ProcessFlowchart({
        clientId,
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

    // Audit log — fired after every successful DB write
    if (isNew) {
      await logProcessFlowCreate(req, processFlowchart);
    } else {
      await logProcessFlowUpdate(
        req,
        processFlowchart,
        `Process flowchart updated — client: ${clientId}, nodes: ${processFlowchart.nodes.length}, version: ${processFlowchart.version}`
      );
      // Fire per-scope EF audit logs (only for update path where _savePFEFChanges is defined)
      if (typeof _savePFEFChanges !== 'undefined') {
        for (const c of _savePFEFChanges) {
          await logProcessFlowEmissionFactorUpdate(req, processFlowchart, c.nodeId, c.scopeIdentifier, c.previousEFs, c.newEFs);
        }
      }
    }

    // 9) Auto-start flowchart status
    if (['consultant', 'consultant_admin'].includes(req.user.userType) && isNew) {
  await Client.findOneAndUpdate(
    {
      clientId,
      'workflowTracking': { $type: 'object' }   // ← guard
    },
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
      _id:processFlowchart._id,
      clientId: processFlowchart.clientId,
      nodes: processFlowchart.nodes,
      edges: processFlowchart.edges,
      assessmentLevel: assessmentLevel,
      version: processFlowchart.version,
      createdAt: processFlowchart.createdAt,
      updatedAt: processFlowchart.updatedAt
    };

    // 11.5) Attach quota info (supplemental; non-fatal if it fails)
    if (isQuotaSubject(req.user.userType)) {
      try {
        const assignedConsultantId = await getAssignedConsultantId(clientId);
        if (assignedConsultantId) {
          const quotaStatus = await getQuotaStatus(clientId, assignedConsultantId);
          const status = quotaStatus?.status || {};
          responseData.quota = {
            processFlowchartNodes:
              status.processFlowchartNodes ?? status.processNodes ?? status.processFlowNodes,
            processFlowchartScopeDetails:
              status.processFlowchartScopeDetails ?? status.processScopeDetails ?? status.processScopeDetails,
          };
        }
      } catch (_) {
        // Non-fatal: quota info is supplemental
      }
    }

    const hasOrg  = Array.isArray(assessmentLevel) && assessmentLevel.includes('organization');
    const hasProc = Array.isArray(assessmentLevel) && assessmentLevel.includes('process');

    if (hasProc && !hasOrg) {
      responseData.hasFullScopeDetails = true;
      responseData.message = 'Process flowchart saved with complete scope details (flowchart not available for this assessment level).';
    } else if (hasProc && hasOrg) {
      responseData.hasFullScopeDetails = false;
      responseData.message = 'Process flowchart saved with basic details only (full scope details available in the main flowchart).';
    }

    return res.status(isNew ? 201 : 200).json({ 
      message: isNew ? 'Process flowchart created successfully' : 'Process flowchart updated successfully',
      flowchart: responseData
    });

  } catch (error) {
    console.error('Save process flowchart error:', error);
    
    // ** UPDATED ERROR HANDLING **
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

    return res.status(500).json({ 
      message: 'Failed to save process flowchart', 
      error: error.message 
    });
  }
};

// ============================================================================
// UPDATED FUNCTION: addNodeToProcessFlowchart
// ============================================================================
// PATCH /api/processflow/:flowchartId/add-node
//
// Appends ONE or MANY nodes (and optional edges) to an existing
// ProcessFlowchart.  Increments version ONCE per request.
//
// ── Supported request body shapes ────────────────────────────────────────────
//
//  Single node (backward-compatible):
//  {
//    "node":  { ...NodeSchema object },
//    "edge":  { ...EdgeSchema object }   // optional
//  }
//
//  Multiple nodes (new):
//  {
//    "nodes": [ { ...NodeSchema }, { ...NodeSchema }, ... ],
//    "edges": [ { ...EdgeSchema }, { ...EdgeSchema }, ... ]   // optional
//  }
//
//  Rule: "nodes" array takes priority over singular "node" key.
//        "edges" array takes priority over singular "edge" key.
//
// ── ProcessFlowchart-specific notes ──────────────────────────────────────────
//  • EdgeSchema requires sourcePosition + targetPosition (validated here).
//  • Pre-save edge-connectivity hook: skipped ($locals.skipEdgeValidation=true)
//    when NO edges are supplied in the request so nodes can be wired later.
//    When edges ARE supplied the full hook runs to keep the chart consistent.
//  • allocationPct validation runs across the projected full node list.
//
// ── Success response (200) ────────────────────────────────────────────────────
//  {
//    "message":    "2 node(s) added successfully",
//    "flowchartId": "<mongo _id>",
//    "clientId":   "<clientId>",
//    "version":    4,
//    "totalNodes": 7,
//    "addedNodes": [ ...normalized node objects ],
//    "addedEdges": [ ...normalized edge objects ]   // [] when no edges sent
//  }
// ============================================================================

const addNodeToProcessFlowchart = async (req, res) => {
  try {
    const { flowchartId } = req.params;

    // ── 0) Auth guard ─────────────────────────────────────────────────────────
    if (!req.user || (!req.user._id && !req.user.id)) {
      return res.status(401).json({ message: 'Authentication required' });
    }
    const userId = req.user._id || req.user.id;

    // ── 1) Normalise input — accept both singular and plural keys ─────────────
    let rawNodes = [];
    if (Array.isArray(req.body.nodes) && req.body.nodes.length > 0) {
      rawNodes = req.body.nodes;
    } else if (
      req.body.node &&
      typeof req.body.node === 'object' &&
      !Array.isArray(req.body.node)
    ) {
      rawNodes = [req.body.node];
    }

    let rawEdges = [];
    if (Array.isArray(req.body.edges)) {
      rawEdges = req.body.edges;
    } else if (
      req.body.edge &&
      typeof req.body.edge === 'object' &&
      !Array.isArray(req.body.edge)
    ) {
      rawEdges = [req.body.edge];
    }

    if (rawNodes.length === 0) {
      return res.status(400).json({
        message:
          'Request body must include a "node" object or a "nodes" array with at least one entry'
      });
    }

    // ── 2) Per-node structural validation ─────────────────────────────────────
    for (let i = 0; i < rawNodes.length; i++) {
      const n   = rawNodes[i];
      const pfx = rawNodes.length > 1 ? `nodes[${i}]: ` : '';

      if (!n || typeof n !== 'object' || Array.isArray(n)) {
        return res.status(400).json({ message: `${pfx}each node must be a plain object` });
      }
      if (!n.id || typeof n.id !== 'string' || !n.id.trim()) {
        return res.status(400).json({
          message: `${pfx}node.id is required and must be a non-empty string`
        });
      }
      if (!n.label || typeof n.label !== 'string' || !n.label.trim()) {
        return res.status(400).json({
          message: `${pfx}node.label is required and must be a non-empty string`
        });
      }
      if (
        !n.position ||
        typeof n.position.x !== 'number' ||
        typeof n.position.y !== 'number'
      ) {
        return res.status(400).json({
          message: `${pfx}node.position with numeric x and y coordinates is required`
        });
      }
    }

    // Duplicate ids within the request payload itself
    const incomingNodeIds  = rawNodes.map(n => n.id.trim());
    const incomingNodeIdSet = new Set(incomingNodeIds);
    if (incomingNodeIdSet.size !== incomingNodeIds.length) {
      return res.status(400).json({
        message:
          'Duplicate node ids found within the request payload. Each node must have a unique id.'
      });
    }

    // ── 3) Load ProcessFlowchart ──────────────────────────────────────────────
    if (!mongoose.Types.ObjectId.isValid(flowchartId)) {
      return res.status(400).json({ message: 'Invalid flowchartId format' });
    }

    const processFlowchart = await ProcessFlowchart.findById(flowchartId);
    if (!processFlowchart) {
      return res.status(404).json({ message: 'Process flowchart not found' });
    }
    if (processFlowchart.isDeleted) {
      return res.status(409).json({
        message: 'Cannot add nodes to a deleted process flowchart'
      });
    }

    const { clientId } = processFlowchart;

    // ── 4) Permission check ───────────────────────────────────────────────────
    const canManage = await canManageProcessFlowchart(req.user, clientId);
    if (!canManage) {
      return res.status(403).json({
        message: 'You do not have permission to update this process flowchart'
      });
    }

    // ── 5) Duplicate node-id guard (against existing DB nodes) ───────────────
    const existingNodeIds = new Set(processFlowchart.nodes.map(n => n.id));
    const duplicates      = incomingNodeIds.filter(id => existingNodeIds.has(id));
    if (duplicates.length > 0) {
      return res.status(409).json({
        message: `Node id(s) already exist in this process flowchart: ${duplicates.join(', ')}. Use unique ids.`,
        code:         'DUPLICATE_NODE_ID',
        duplicateIds: duplicates
      });
    }

    // ── 6) Validate edges ─────────────────────────────────────────────────────
    // Full projected node-id set so edges can reference nodes in the same request.
    const allNodeIds      = new Set([...existingNodeIds, ...incomingNodeIdSet]);
    const normalizedEdges = [];

    if (rawEdges.length > 0) {
      const existingEdgeIds = new Set(processFlowchart.edges.map(e => e.id));
      const seenInPayload   = new Set();

      for (let i = 0; i < rawEdges.length; i++) {
        const e   = rawEdges[i];
        const pfx = rawEdges.length > 1 ? `edges[${i}]: ` : '';

        if (!e || typeof e !== 'object') {
          return res.status(400).json({
            message: `${pfx}each edge must be a plain object`
          });
        }
        if (!e.id || !e.source || !e.target) {
          return res.status(400).json({
            message: `${pfx}edge must include id, source, and target fields`
          });
        }
        // ProcessFlowchart EdgeSchema requires sourcePosition + targetPosition
        if (!e.sourcePosition || !e.targetPosition) {
          return res.status(400).json({
            message: `${pfx}edge must include sourcePosition and targetPosition for process flowcharts`
          });
        }
        if (existingEdgeIds.has(e.id)) {
          return res.status(409).json({
            message: `${pfx}edge id "${e.id}" already exists in this flowchart. Use a unique id.`,
            code: 'DUPLICATE_EDGE_ID'
          });
        }
        if (seenInPayload.has(e.id)) {
          return res.status(400).json({
            message: `Duplicate edge id "${e.id}" found within the request payload.`
          });
        }
        seenInPayload.add(e.id);

        if (!allNodeIds.has(e.source)) {
          return res.status(400).json({
            message: `${pfx}edge source "${e.source}" does not match any node in this flowchart`
          });
        }
        if (!allNodeIds.has(e.target)) {
          return res.status(400).json({
            message: `${pfx}edge target "${e.target}" does not match any node in this flowchart`
          });
        }

        normalizedEdges.push({
          id:             e.id,
          source:         e.source,
          target:         e.target,
          sourcePosition: e.sourcePosition,
          targetPosition: e.targetPosition
        });
      }
    }

    // ── 7) Normalise all incoming nodes via shared helpers ────────────────────
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: 'Associated client not found' });
    }
    const assessmentLevel = getNormalizedLevels(client);

    const normalizedNodes = addCEFCommentsToNodes(
      normalizeNodes(rawNodes, assessmentLevel, 'processFlowchart')
    );

    // ── 8) Allocation validation across projected full node list ──────────────
    // Run only when at least one incoming scope carries allocation data OR has
    // any scopeDetails at all (mirrors saveProcessFlowchart behaviour).
    const anyIncomingScopes = normalizedNodes.some(
      n => (n.details?.scopeDetails || []).length > 0
    );

    if (anyIncomingScopes) {
      const projectedNodes = [
        ...processFlowchart.nodes.map(n =>
          typeof n.toObject === 'function' ? n.toObject() : n
        ),
        ...normalizedNodes
      ];

      const allocationValidation = validateAllocations(projectedNodes, {
        includeFromOtherChart: false,
        includeDeleted:        false
      });

      if (!allocationValidation.isValid) {
        const errorResponse = formatValidationError(allocationValidation);
        return res.status(400).json({
          message: 'Allocation validation failed for the incoming node(s)',
          code:    'ALLOCATION_VALIDATION_FAILED',
          details: errorResponse,
          hint:
            'When a scopeIdentifier appears in multiple nodes, the sum of allocationPct across all nodes must equal 100%',
          affectedScopeIdentifiers: allocationValidation.errors.map(e => ({
            scopeIdentifier: e.scopeIdentifier,
            currentSum:      e.currentSum,
            expectedSum:     100,
            nodes:           e.entries.map(en => ({
              nodeId:        en.nodeId,
              nodeLabel:     en.nodeLabel,
              allocationPct: en.allocationPct
            }))
          }))
        });
      }
    }

    // ── 9) Quota check ────────────────────────────────────────────────────────
    if (isQuotaSubject(req.user.userType)) {
      const assignedConsultantId = await getAssignedConsultantId(clientId);
      if (!assignedConsultantId) {
        return res.status(403).json({
          success: false,
          message:
            'This client does not have an assigned consultant. Assign a consultant first.',
          code: 'NO_ASSIGNED_CONSULTANT'
        });
      }

      const projectedNodes = [
        ...processFlowchart.nodes.map(n =>
          typeof n.toObject === 'function' ? n.toObject() : n
        ),
        ...normalizedNodes
      ];

      const quotaResult = await checkFlowchartQuota({
        clientId,
        consultantId: assignedConsultantId,
        nodes:        projectedNodes,
        chartType:    'processFlowchart'
      });

      if (!quotaResult.allowed) {
        return res.status(422).json({
          success: false,
          message: `Process flowchart quota exceeded. Cannot add ${normalizedNodes.length} node(s).`,
          code:        'QUOTA_EXCEEDED',
          quotaErrors: quotaResult.errors.map(e => ({
            resource:  e.resource,
            limit:     e.limit,
            used:      e.used,
            remaining: e.remaining,
            attempted: e.newTotal,
            message:   e.message
          }))
        });
      }
    }

    // ── 10) Append all nodes and edges — single save ──────────────────────────
    for (const node of normalizedNodes) {
      processFlowchart.nodes.push(node);
    }
    for (const edge of normalizedEdges) {
      processFlowchart.edges.push(edge);
    }

    processFlowchart.markModified('nodes');
    if (normalizedEdges.length > 0) processFlowchart.markModified('edges');
    processFlowchart.lastModifiedBy = userId;
    processFlowchart.version        = (processFlowchart.version || 1) + 1;

    // Skip the edge-connectivity pre-save hook when no edges were supplied
    // so the new nodes can be wired in a subsequent request without failing.
    if (normalizedEdges.length === 0) {
      processFlowchart.$locals                    = processFlowchart.$locals || {};
      processFlowchart.$locals.skipEdgeValidation = true;
    }

    await processFlowchart.save();

    // ── 11) Audit log ─────────────────────────────────────────────────────────
    const addedIds = normalizedNodes.map(n => n.id).join(', ');
    await logProcessFlowUpdate(
      req,
      processFlowchart,
      `${normalizedNodes.length} node(s) added via PATCH — nodeIds: [${addedIds}], client: ${clientId}, version: ${processFlowchart.version}`
    );

    // ── 12) Return the freshly saved nodes ────────────────────────────────────
    const totalNodes = processFlowchart.nodes.length;
    const addedNodes = processFlowchart.nodes.slice(totalNodes - normalizedNodes.length);

    return res.status(200).json({
      message:     `${normalizedNodes.length} node(s) added successfully`,
      flowchartId: processFlowchart._id,
      clientId,
      version:     processFlowchart.version,
      totalNodes,
      addedNodes,
      addedEdges:  normalizedEdges
    });

  } catch (error) {
    console.error('Error in addNodeToProcessFlowchart:', error);
    return res.status(500).json({
      message: 'Failed to add node(s) to process flowchart',
      error:   error.message
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
    } else if (
      ["client_employee_head", "employee", "auditor", "viewer"].includes(userType)
    ) {
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
        assessmentLevel: effectiveLevels
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
      const scopes = (base.details?.scopeDetails || []).filter((s) => !s.isDeleted);

      return {
        ...base,
        details: {
          ...base.details,
          scopeDetails: scopes.map((s) => ({
            _id: s._id, // optional, keep if needed
            scopeIdentifier: s.scopeIdentifier,
            scopeType: s.scopeType,
            inputType: s.inputType || s.dataCollectionType
          })),
          employeeCommutingEmissionFactors: undefined,
          gwp: undefined,
          calculations: undefined,
          formulas: undefined
        }
      };
    };

    if (!fullAccess) {
      if (userType === "client_employee_head") {
        const assigned = nodes.filter(
          (n) => String(n.details?.employeeHeadId || "") === userId
        );

        const fallback = nodes.filter(
          (n) =>
            n.details?.department === user.department ||
            n.details?.location === user.location
        );

        filteredNodes = assigned.length ? assigned : fallback;
      }

      if (userType === "employee") {
        filteredNodes = nodes.reduce((acc, node) => {
          const base = node.toObject ? node.toObject() : node;
          const scopes = base.details?.scopeDetails || [];

          const assignedScopes = scopes.filter((s) =>
            (s.assignedEmployees || []).map((x) => String(x)).includes(userId)
          );

          if (assignedScopes.length > 0) {
            acc.push({
              ...base,
              details: {
                ...base.details,
                scopeDetails: assignedScopes
              }
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
    const getNodeId = (n) => n.id || (n._id && n._id.toString()) || n.data?.id;

    const visible = new Set(filteredNodes.map(getNodeId).filter(Boolean));

    const filteredEdges = (processFlowchart.edges || []).filter(
      (e) => visible.has(e.source) && visible.has(e.target)
    );

    // ---------------- RETURN -----------------------------
    return res.status(200).json({
      success: true,
      processFlowchartId: processFlowchart._id, // explicit top-level id
      flowchart: {
        _id: processFlowchart._id, // explicit inside flowchart object
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
    return res.status(500).json({
      message: "Failed to fetch process flowchart",
      error: err.message
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
    // 🆕 VALIDATE ALLOCATION PERCENTAGES BEFORE SAVE (COMPLETE FLOWCHART STATE)
    // ============================================================================
    // After updating this node, we validate the COMPLETE flowchart to ensure
    // that allocations for shared scopeIdentifiers sum to 100%.
    // 
    // This validation ensures:
    // - No double-counting of emissions
    // - Proper split of emissions across nodes sharing a scopeIdentifier
    // - Clear error messages when allocations are invalid
    // ============================================================================
    
    // Update the node in the array first (so validation sees the updated state)
    processFlowchart.nodes[nodeIndex] = mergedNode;
    
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

    // ─────────────────────────────────────────────────────────────────────────
    // QUOTA CHECK — runs AFTER node merge, BEFORE DB save
    //
    // saveProcessFlowchart checks quota when the ENTIRE nodes array is replaced.
    // updateProcessFlowchartNode patches a SINGLE node (including scopeDetails)
    // and saves directly — bypassing saveProcessFlowchart and its quota check.
    // Without this, a consultant can add unlimited scopeDetails through this
    // endpoint even after the processScopeDetails limit is set.
    // ─────────────────────────────────────────────────────────────────────────
    if (isQuotaSubject(req.user.userType)) {
      try {
        const _quotaConsultantId = await getAssignedConsultantId(clientId);
        if (_quotaConsultantId) {
          // Build the would-be full nodes array with the merged node applied.
          const _updatedNodes = processFlowchart.nodes.map((n, i) =>
            i === nodeIndex
              ? mergedNode
              : (typeof n.toObject === 'function' ? n.toObject() : n)
          );
          const _quotaResult = await checkFlowchartQuota({
            clientId,
            consultantId: _quotaConsultantId,
            nodes:        _updatedNodes,
            chartType:    'processFlowchart',
          });
          if (!_quotaResult.allowed) {
            return res.status(422).json({
              success:     false,
              message:     'Process flowchart quota exceeded.',
              code:        'QUOTA_EXCEEDED',
              quotaErrors: _quotaResult.errors.map((e) => ({
                resource:  e.resource,
                limit:     e.limit,
                used:      e.used,
                remaining: e.remaining,
                attempted: e.newTotal,
                message:   e.message,
              })),
            });
          }
        }
      } catch (qErr) {
        console.error('❌ Quota check error in updateProcessFlowchartNode:', qErr);
        throw qErr;
      }
    }

    // ============================================================================
    // SAVE TO DATABASE
    // ============================================================================

    // ── EC Tier 2 EF change detection ─────────────────────────────────────────
    const _updatePFEFChanges = _pfDetectAndRecordEFChanges(
      existingNode.details?.scopeDetails ?? [],
      mergedNode.details?.scopeDetails ?? [],
      req.user?._id || req.user?.id || null
    );

    processFlowchart.markModified('nodes'); // ensure Mongoose tracks deep nested changes
    processFlowchart.lastModifiedBy = req.user?._id || req.user?.id || null;

    await processFlowchart.save();
    await logProcessFlowUpdate(
      req,
      processFlowchart,
      `Process node updated — nodeId: ${nodeId}, client: ${clientId}, version: ${processFlowchart.version}`
    );

    // Fire per-scope EF audit logs
    for (const c of _updatePFEFChanges) {
      await logProcessFlowEmissionFactorUpdate(req, processFlowchart, nodeId, c.scopeIdentifier, c.previousEFs, c.newEFs);
    }

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
    await logProcessFlowDelete(req, processFlowchart, 'soft');

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

    // ✅ Ensure node exists (avoid silent no-op)
    const exists = (processFlowchart.nodes || []).some(n => String(n.id) === String(nodeId));
    if (!exists) {
      return res.status(404).json({ message: 'Node not found' });
    }

    // Remove node + related edges
    processFlowchart.nodes = (processFlowchart.nodes || []).filter(n => String(n.id) !== String(nodeId));
    processFlowchart.edges = (processFlowchart.edges || []).filter(
      e => String(e.source) !== String(nodeId) && String(e.target) !== String(nodeId)
    );

    processFlowchart.lastModifiedBy = req.user._id || req.user.id || null;

    // ✅ Make sure Mongoose tracks changes
    processFlowchart.markModified('nodes');
    processFlowchart.markModified('edges');

    // ✅ Bypass the "min 1 edge per node" rule for this delete operation
    processFlowchart.$locals = processFlowchart.$locals || {};
    processFlowchart.$locals.skipEdgeValidation = true;

    await processFlowchart.save();
    await logProcessFlowUpdate(
      req,
      processFlowchart,
      `Process node deleted — nodeId: ${nodeId}, client: ${clientId}, remaining nodes: ${processFlowchart.nodes.length}`
    );

    return res.status(200).json({
      message: 'Node and associated edges deleted successfully'
    });

  } catch (error) {
    console.error('Delete process node error:', error);

    // ✅ If your pre-save hook throws statusCode=400, return 400 (not 500)
    if (error.statusCode === 400) {
      return res.status(400).json({
        message: 'Process flowchart validation failed.',
        error: error.message
      });
    }

    return res.status(500).json({
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
    await logProcessFlowUpdate(
      req,
      processFlowchart,
      `Process flowchart restored from soft-delete — client: ${clientId}`
    );

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
      await logProcessFlowNodeAssign(req, flowchart, nodeId, employeeHeadId);

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
      await logProcessFlowUpdate(
        req,
        flowchart,
        `Employee head unassigned from process node — nodeId: ${nodeId}, client: ${clientId}`
      );

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

    // 4) Load the full process flowchart (nodes are encrypted, so we fetch the
    //    whole document and locate the node in JavaScript instead of using
    //    MongoDB positional operators on the encrypted nodes array)
    const flow = await ProcessFlowchart.findOne({ clientId, isDeleted: false });

    if (!flow) {
      return res.status(404).json({ message: 'Process flowchart not found' });
    }

    const nodeIndex = (flow.nodes || []).findIndex(n => n.id === nodeId);
    if (nodeIndex === -1) {
      return res.status(404).json({ message: 'Node not found in process flowchart' });
    }

    const node = flow.nodes[nodeIndex];

    // 5) Verify this head is assigned to this PROCESS node
    const assignedHeadId = node?.details?.employeeHeadId ? String(node.details.employeeHeadId) : null;
    const currentUserId  = req.user.id ? String(req.user.id) : (req.user._id ? String(req.user._id) : null);

    if (!assignedHeadId || assignedHeadId !== currentUserId) {
      return res.status(403).json({
        message: 'You are not authorized to manage this node. Only the assigned Employee Head can assign scopes.'
      });
    }

    // 6) Locate the specific scope
    const scopeIndex = (node.details?.scopeDetails || []).findIndex(s => s.scopeIdentifier === scopeIdentifier);
    if (scopeIndex === -1) {
      return res.status(404).json({ message: `Scope detail '${scopeIdentifier}' not found in this node` });
    }
    const scope = flow.nodes[nodeIndex].details.scopeDetails[scopeIndex];

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

    // 8) Remove existing occurrences + add back (unique), set metadata — in JS
    const existingEmployees = (scope.assignedEmployees || []).map(e => String(e));
    const newEmployeeSet = [...new Set([
      ...existingEmployees.filter(e => !employeeIds.map(String).includes(e)),
      ...employeeIds.map(String)
    ])];
    flow.nodes[nodeIndex].details.scopeDetails[scopeIndex].assignedEmployees = newEmployeeSet;
    flow.nodes[nodeIndex].details.scopeDetails[scopeIndex].lastAssignedAt = new Date();
    flow.nodes[nodeIndex].details.scopeDetails[scopeIndex].assignedBy = req.user._id;

    // 9) Save — pre('save') encryption plugin encrypts nodes before write
    flow.markModified('nodes');
    await flow.save();

    // Audit log — employees assigned to a scope in a process node
    await logProcessFlowScopeAssign(
      req,
      { _id: flow._id, clientId },
      nodeId,
      scopeIdentifier,
      employeeIds
    );

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

    // 4) Load the full process flowchart — nodes are encrypted so we locate
    //    the node in JavaScript rather than using MongoDB positional operators
    const flow = await ProcessFlowchart.findOne({ clientId, isDeleted: false });

    if (!flow) {
      return res.status(404).json({ message: 'Process flowchart not found' });
    }

    const nodeIndex = (flow.nodes || []).findIndex(n => n.id === nodeId);
    if (nodeIndex === -1) {
      return res.status(404).json({ message: 'Node not found in process flowchart' });
    }

    const node = flow.nodes[nodeIndex];

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
    const scopeIndex = (node.details?.scopeDetails || []).findIndex(
      s => s.scopeIdentifier === scopeIdentifier
    );
    if (scopeIndex === -1) {
      return res.status(404).json({
        message: `Scope detail '${scopeIdentifier}' not found in this node`
      });
    }
    const scope = flow.nodes[nodeIndex].details.scopeDetails[scopeIndex];

    // 7) Remove employees from this scope's assignedEmployees — in JavaScript
    const employeeIdStrings = employeeIds.map(String);
    flow.nodes[nodeIndex].details.scopeDetails[scopeIndex].assignedEmployees =
      (scope.assignedEmployees || []).filter(e => !employeeIdStrings.includes(String(e)));

    // Save — encryption plugin encrypts nodes before write
    flow.markModified('nodes');
    await flow.save();

    // Audit log — employees removed from a scope in a process node
    await logProcessFlowScopeUnassign(
      req,
      { _id: flow._id, clientId },
      nodeId,
      scopeIdentifier,
      employeeIds
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



// DELETE single scopeDetail from inside a node (Process flowchart)
// Route: DELETE /api/processflow/:clientId/node/:nodeId/scope/:scopeIdentifier?scopeUid=...

const hardDeleteProcessScopeDetail = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;
    const { scopeUid } = req.query || {};

    // Permission check (your canManageProcessFlowchart seems to return an object in other places)
    const can = await canManageProcessFlowchart(req.user, clientId);
    const allowed = typeof can === "boolean" ? can : !!can?.allowed;
    if (!allowed) return res.status(403).json({ message: "Permission denied" });

    // Load ONLY the node we care about (lean)
    const pf = await ProcessFlowchart.findOne(
      { clientId, isDeleted: false, "nodes.id": nodeId },
      { nodes: { $elemMatch: { id: nodeId } } }
    ).lean();

    if (!pf) return res.status(404).json({ message: "Process flowchart / node not found" });

    const node = pf.nodes?.[0];
    if (!node) return res.status(404).json({ message: "Node not found" });

    const scopes = node?.details?.scopeDetails || [];
    const idx = findScopeIndex(scopes, { scopeUid, scopeIdentifier });
    if (idx === -1) return res.status(404).json({ message: "Scope detail not found" });

    const removed = scopes[idx];

    // Build a precise pull condition (prefer _id if present)
    const pullCondition = removed?._id
      ? { _id: removed._id }
      : scopeUid
        ? { $or: [{ scopeUid: String(scopeUid) }] }
        : { scopeIdentifier };

    const modifierUserId = req.user?._id || req.user?.id || null;

    // Atomic update: $pull the scopeDetail from that node
    const result = await ProcessFlowchart.updateOne(
      { clientId, isDeleted: false, "nodes.id": nodeId },
      {
        $pull: { "nodes.$[n].details.scopeDetails": pullCondition },
        $set: { lastModifiedBy: modifierUserId, updatedAt: new Date() },
        $inc: { version: 1 }
      },
      { arrayFilters: [{ "n.id": nodeId }] }
    );

    if (!result.modifiedCount) {
      return res.status(409).json({
        message: "Scope detail could not be deleted (no changes applied).",
        nodeId,
        scopeIdentifier
      });
    }

    // Audit log — scope permanently deleted from a process node
    await logProcessFlowUpdate(
      req,
      { _id: pf._id, clientId, nodes: pf.nodes ?? [] },
      `Process scope detail permanently deleted — nodeId: ${nodeId}, scope: ${removed?.scopeIdentifier || scopeIdentifier}, client: ${clientId}`
    );

    return res.status(200).json({
      message: "Scope detail permanently deleted (process)",
      nodeId,
      scope: {
        scopeIdentifier: removed?.scopeIdentifier,
        scopeUid: removed?.scopeUid || removed?._id
      }
    });
  } catch (err) {
    console.error("hardDeleteProcessScopeDetail error:", err);
    return res.status(500).json({ message: "Failed to delete scope detail", error: err.message });
  }
};


// Bulk hard delete scopeDetails from inside a PROCESS node
// DELETE /api/processflow/:clientId/node/:nodeId/scopes
// Body: { scopeIdentifiers?: string[], scopeIds?: string[] }
// Optional query: ?cleanupAssignments=true|false
const hardDeleteProcessScopeDetailsBulk = async (req, res) => {
  try {
    const { clientId, nodeId } = req.params;

    // Accept identifiers via body OR query (?scopeIdentifiers=a,b,c)
    const body = req.body || {};
    const q = req.query || {};

    const rawScopeIdentifiers = [
      ...(Array.isArray(body.scopeIdentifiers) ? body.scopeIdentifiers : []),
      ...(typeof q.scopeIdentifiers === 'string'
        ? q.scopeIdentifiers.split(',').map(s => s.trim())
        : [])
    ];

    const rawScopeIds = Array.isArray(body.scopeIds) ? body.scopeIds : [];

    const scopeIdentifiers = [...new Set(rawScopeIdentifiers.filter(Boolean))];
    const scopeObjectIds = rawScopeIds
      .filter(id => mongoose.Types.ObjectId.isValid(id))
      .map(id => new mongoose.Types.ObjectId(id));

    if (scopeIdentifiers.length === 0 && scopeObjectIds.length === 0) {
      return res.status(400).json({
        message: 'Provide scopeIdentifiers[] and/or scopeIds[] to delete'
      });
    }

    // Permission check (same as your other process endpoints)
    const canManage = await canManageProcessFlowchart(req.user, clientId);
    if (!canManage) {
      return res.status(403).json({ message: 'Permission denied' });
    }

    // Load the full process flowchart — nodes are encrypted so we locate the
    // node and modify scopeDetails in JavaScript instead of using positional operators
    const pf = await ProcessFlowchart.findOne({ clientId, isDeleted: false });

    if (!pf) {
      return res.status(404).json({ message: 'Process flowchart not found' });
    }

    const nodeIndex = (pf.nodes || []).findIndex(n => n.id === nodeId);
    if (nodeIndex === -1) {
      return res.status(404).json({ message: 'Node not found in process flowchart' });
    }

    const node = pf.nodes[nodeIndex];
    const scopes = node?.details?.scopeDetails || [];

    // Determine which scopes match
    const identifierSet = new Set(scopeIdentifiers);
    const idSet = new Set(scopeObjectIds.map(x => String(x)));

    const matchedScopes = scopes.filter(s => {
      const sid = s?.scopeIdentifier;
      const oid = s?._id ? String(s._id) : null;
      return (sid && identifierSet.has(sid)) || (oid && idSet.has(oid));
    });

    if (matchedScopes.length === 0) {
      return res.status(404).json({
        message: 'No matching scopeDetails found to delete',
        requested: { scopeIdentifiers, scopeIds: rawScopeIds }
      });
    }

    const userId = req.user._id || req.user.id;

    // Remove matching scopeDetails in JavaScript, then save
    pf.nodes[nodeIndex].details.scopeDetails = scopes.filter(s => {
      const sid = s?.scopeIdentifier;
      const oid = s?._id ? String(s._id) : null;
      return !((sid && identifierSet.has(sid)) || (oid && idSet.has(oid)));
    });
    pf.lastModifiedBy = userId;
    pf.version = (pf.version || 0) + 1;

    pf.markModified('nodes');
    const savedPf = await pf.save();

    if (!savedPf) {
      return res.status(500).json({
        message: 'Failed to delete scopeDetails',
        requested: { scopeIdentifiers, scopeIds: rawScopeIds }
      });
    }

    // Optional: cleanup assignedModules for employees who were assigned to deleted scopes
    const cleanupAssignments =
      String(req.query.cleanupAssignments || 'true').toLowerCase() === 'true';

    if (cleanupAssignments) {
      // Build scopeIdentifier -> employeeIds map
      const scopeToEmployees = new Map(); // key: scopeIdentifier, val: Set(employeeId)
      for (const s of matchedScopes) {
        const sid = s?.scopeIdentifier;
        const empIds = Array.isArray(s?.assignedEmployees) ? s.assignedEmployees : [];
        if (!sid || empIds.length === 0) continue;

        if (!scopeToEmployees.has(sid)) scopeToEmployees.set(sid, new Set());
        empIds.forEach(eid => scopeToEmployees.get(sid).add(String(eid)));
      }

      for (const [sid, empSet] of scopeToEmployees.entries()) {
        const empIds = [...empSet].filter(id => mongoose.Types.ObjectId.isValid(id));
        if (empIds.length === 0) continue;

        await User.updateMany(
          { _id: { $in: empIds } },
          {
            $pull: {
              assignedModules: {
                $regex: `.*"nodeId":"${nodeId}".*"scopeIdentifier":"${sid}".*`
              }
            }
          }
        );
      }
    }

    return res.status(200).json({
      message: `Deleted ${matchedScopes.length} scopeDetail(s) from node`,
      clientId,
      nodeId,
      deleted: matchedScopes.map(s => ({
        scopeIdentifier: s.scopeIdentifier,
        scopeId: s._id
      })),
      cleanupAssignments
    });
  } catch (err) {
    console.error('hardDeleteProcessScopeDetailsBulk error:', err);
    return res.status(500).json({
      message: 'Failed to delete scopeDetails (bulk)',
      error: err.message
    });
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
    const { buildAllocationIndex, getAllocationSummary, validateAllocations } = require('../../utils/allocation/allocationHelpers');

// Build allocation index and summary
const allocationIndex = buildAllocationIndex(processFlowchart, {
  includeFromOtherChart: false,
  includeDeleted: false
});

const summary = getAllocationSummary(allocationIndex);
const validation = validateAllocations(processFlowchart.nodes, {
  includeFromOtherChart: false,
  includeDeleted: false
});
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
 * Update allocation percentages for scopeIdentifiers across nodes.
 * 
 * Conceptual model: When a scopeIdentifier appears in multiple nodes,
 * we allocate what percentage of that scope's emissions belong to each node.
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
 *     },
 *     {
 *       "scopeIdentifier": "Natural_Gas",
 *       "nodeAllocations": [
 *         { "nodeId": "node-3", "allocationPct": 100 }
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
    
    // ============================================================================
    // VALIDATE AND PREPARE UPDATES (scopeIdentifier-centric)
    // ============================================================================
    const updateErrors = [];
    const scopeIdentifierUpdates = new Map(); // Map<scopeIdentifier, Map<nodeId, allocationPct>>
    
    for (const alloc of allocations) {
      const { scopeIdentifier, nodeAllocations } = alloc;
      
      // Validate structure
      if (!scopeIdentifier || !nodeAllocations || !Array.isArray(nodeAllocations)) {
        updateErrors.push({
          scopeIdentifier: scopeIdentifier || 'UNKNOWN',
          error: 'Invalid allocation format: must have scopeIdentifier and nodeAllocations array'
        });
        continue;
      }
      
      // ============================================================================
      // 🆕 REMOVED: 100% sum validation
      // ============================================================================
      // OLD CODE (removed):
      // const sum = nodeAllocations.reduce((s, na) => s + (na.allocationPct || 0), 0);
      // if (Math.abs(sum - 100) > 0.01) { ... }
      //
      // NEW BEHAVIOR: You can now update individual nodes without requiring
      // all nodes with the same scopeIdentifier to be included in the request.
      // ============================================================================
      
      // Validate each node allocation
      const nodeMap = new Map();
      let hasErrors = false;
      
      for (const na of nodeAllocations) {
        if (!na.nodeId) {
          updateErrors.push({
            scopeIdentifier,
            error: 'Each nodeAllocation must have a nodeId'
          });
          hasErrors = true;
          continue;
        }
        
        // Validate percentage is in valid range (0-100)
        if (na.allocationPct === undefined || na.allocationPct === null) {
          updateErrors.push({
            scopeIdentifier,
            nodeId: na.nodeId,
            error: 'allocationPct is required'
          });
          hasErrors = true;
          continue;
        }
        
        if (na.allocationPct < 0 || na.allocationPct > 100) {
          updateErrors.push({
            scopeIdentifier,
            nodeId: na.nodeId,
            error: `allocationPct must be between 0 and 100, got ${na.allocationPct}`
          });
          hasErrors = true;
          continue;
        }
        
        // Check for duplicate nodeId for same scopeIdentifier
        if (nodeMap.has(na.nodeId)) {
          updateErrors.push({
            scopeIdentifier,
            nodeId: na.nodeId,
            error: `Duplicate nodeId in allocations for scopeIdentifier "${scopeIdentifier}"`
          });
          hasErrors = true;
          continue;
        }
        
        nodeMap.set(na.nodeId, na.allocationPct);
      }
      
      if (!hasErrors) {
        scopeIdentifierUpdates.set(scopeIdentifier, nodeMap);
      }
    }
    
    if (updateErrors.length > 0) {
      return res.status(400).json({
        message: 'Allocation validation errors',
        errors: updateErrors
      });
    }
    
    // ============================================================================
    // APPLY UPDATES (scopeIdentifier-centric approach)
    // ============================================================================
    let updatedCount = 0;
    const updateSummary = [];
    
    // Process each scopeIdentifier
    for (const [scopeIdentifier, nodeAllocations] of scopeIdentifierUpdates) {
      const scopeUpdateInfo = {
        scopeIdentifier,
        nodesUpdated: [],
        nodesNotFound: []
      };
      
      // For each node where this scopeIdentifier should have an allocation
      for (const [nodeId, allocationPct] of nodeAllocations) {
        let foundAndUpdated = false;
        
        // Find the node in the flowchart
        const node = processFlowchart.nodes.find(n => n.id === nodeId);
        
        if (!node) {
          scopeUpdateInfo.nodesNotFound.push({
            nodeId,
            reason: 'Node not found in flowchart'
          });
          continue;
        }
        
        // Find all scopes with this scopeIdentifier in this node (should typically be 1)
        const scopeDetails = node.details?.scopeDetails || [];
        let previousAllocationPct = null;
        
        for (const scope of scopeDetails) {
          if (scope.scopeIdentifier === scopeIdentifier && !scope.isDeleted) {
            previousAllocationPct = scope.allocationPct;
            scope.allocationPct = allocationPct;
            foundAndUpdated = true;
            updatedCount++;
          }
        }
        
        if (foundAndUpdated) {
          scopeUpdateInfo.nodesUpdated.push({
            nodeId,
            nodeLabel: node.label || node.id,
            previousAllocationPct,
            newAllocationPct: allocationPct
          });
        } else {
          scopeUpdateInfo.nodesNotFound.push({
            nodeId,
            nodeLabel: node.label || node.id,
            reason: `scopeIdentifier "${scopeIdentifier}" not found in this node`
          });
        }
      }
      
      updateSummary.push(scopeUpdateInfo);
    }
    
    // Mark as modified and save
    processFlowchart.markModified('nodes');
    processFlowchart.lastModifiedBy = req.user._id || req.user.id;
    await processFlowchart.save();

    // ── Audit log: one entry per changed node allocation ──────────────────
    for (const scopeInfo of updateSummary) {
      for (const nodeInfo of scopeInfo.nodesUpdated) {
        await logProcessFlowAllocationUpdate(
          req,
          processFlowchart,
          nodeInfo.nodeId,
          nodeInfo.previousAllocationPct,
          nodeInfo.newAllocationPct
        );
      }
    }
    // ── Audit log: one summary-level update entry ──────────────────────────
    await logProcessFlowUpdate(
      req,
      processFlowchart,
      `Allocation percentages updated — client: ${clientId}, ${scopeIdentifierUpdates.size} scopeIdentifier(s), ${updatedCount} scope(s) changed`
    );
    // ─────────────────────────────────────────────────────────────────────

    console.log(`✅ Allocations saved successfully for ${scopeIdentifierUpdates.size} scopeIdentifier(s)`);
    
    // ============================================================================
    // BUILD RESPONSE WITH ALLOCATION SUMMARY
    // ============================================================================
    const { buildAllocationIndex, getAllocationSummary, validateAllocations } = require('../../utils/allocation/allocationHelpers');

const allocationIndex = buildAllocationIndex(processFlowchart, {
  includeFromOtherChart: false,
  includeDeleted: false
});

const summary = getAllocationSummary(allocationIndex);
const validation = validateAllocations(processFlowchart.nodes, {
  includeFromOtherChart: false,
  includeDeleted: false
});
    
    // ============================================================================
    // 🆕 TRIGGER AUTOMATIC EMISSION SUMMARY RECALCULATION
    // ============================================================================
    const affectedScopeIdentifiers = Array.from(scopeIdentifierUpdates.keys());
    
    let recalculationStatus = {
      triggered: false,
      status: 'not_attempted',
      message: null
    };
    
    try {
      console.log(`🔄 Triggering emission summary recalculation for client ${clientId}...`);
      
      // Import the recalculation function
      const { recalculateSummariesOnAllocationUpdate } = require('../Calculation/CalculationSummary');
      
      // Trigger recalculation asynchronously (don't wait for it to complete)
      // This prevents the allocation update response from being delayed
      recalculateSummariesOnAllocationUpdate(
        clientId,
        affectedScopeIdentifiers,
        req.user
      ).then((result) => {
        console.log(`✅ Background recalculation completed:`, result);
      }).catch((error) => {
        console.error(`❌ Background recalculation failed:`, error);
      });
      
      recalculationStatus = {
        triggered: true,
        status: 'in_progress',
        message: 'Emission summary recalculation started in background',
        affectedScopeIdentifiers
      };
      
    } catch (recalcError) {
      // Log the error but don't fail the allocation update
      console.error('❌ Failed to trigger emission summary recalculation:', recalcError);
      
      recalculationStatus = {
        triggered: false,
        status: 'failed',
        message: 'Failed to trigger emission summary recalculation',
        error: recalcError.message
      };
    }
    
    // ============================================================================
    // RETURN SUCCESS RESPONSE
    // ============================================================================
    return res.status(200).json({
      success: true,
      message: `Updated allocations for ${scopeIdentifierUpdates.size} scopeIdentifier(s)`,
      scopeIdentifiersUpdated: scopeIdentifierUpdates.size,
      totalScopesUpdated: updatedCount,
      updateDetails: updateSummary,
      currentAllocations: summary,
      validation: {
        isValid: validation.isValid,
        errorCount: validation.errors.length,
        warningCount: validation.warnings.length,
        errors: validation.errors,
        warnings: validation.warnings
      },
      recalculation: recalculationStatus
    });
    
  } catch (error) {
    console.error('Update allocations error:', error);
    return res.status(500).json({
      message: 'Failed to update allocations',
      error: error.message
    });
  }
};

// ============================================================================
// SECTION: ProcessEmissionDataEntry — Helper Functions
// ============================================================================

/**
 * Build a MongoDB filter object from request params / query.
 * Handles strict client isolation the same way DataEntry does.
 */
function buildProcessEmissionFilters(req) {
  const filters = {};

  const clientScopedTypes = [
    'client_admin',
    'client_employee_head',
    'employee',
    'auditor',
    'viewer',
  ];

  const userType      = req.user?.userType;
  const userClientId  = req.user?.clientId;

  // ── clientId ──────────────────────────────────────────────────────────────
  const requestedClientId =
    req.params?.clientId || req.query?.clientId;

  if (clientScopedTypes.includes(userType)) {
    if (requestedClientId && userClientId && requestedClientId !== userClientId) {
      const err = new Error('Access denied: cross-client request');
      err.statusCode = 403;
      throw err;
    }
    filters.clientId = userClientId;
  } else {
    if (!requestedClientId) {
      const err = new Error('clientId is required');
      err.statusCode = 400;
      throw err;
    }
    filters.clientId = requestedClientId;
  }

  // ── nodeId ────────────────────────────────────────────────────────────────
  const requestedNodeId =
    req.params?.nodeId || req.query?.nodeId;
  if (requestedNodeId) filters.nodeId = requestedNodeId;

  // ── scopeIdentifier ───────────────────────────────────────────────────────
  const requestedScope =
    req.params?.scopeIdentifier || req.query?.scopeIdentifier;
  if (requestedScope) filters.scopeIdentifier = requestedScope;

  // ── scopeType  e.g. "Scope 1" | "Scope 2" | "Scope 3" ───────────────────
  if (req.query.scopeType) filters.scopeType = req.query.scopeType;

  // ── inputType  e.g. "manual" | "API" | "IOT" ─────────────────────────────
  if (req.query.inputType) filters.inputType = req.query.inputType;

  // ── nodeType  "Emission Source" | "Reduction" ────────────────────────────
  if (req.query.nodeType) filters.nodeType = req.query.nodeType;

  // ── emissionCalculationStatus ─────────────────────────────────────────────
  if (req.query.emissionCalculationStatus)
    filters.emissionCalculationStatus = req.query.emissionCalculationStatus;

  // ── sourceDataEntryId ─────────────────────────────────────────────────────
  if (req.query.sourceDataEntryId) {
    const id = req.query.sourceDataEntryId;
    if (mongoose.Types.ObjectId.isValid(id))
      filters.sourceDataEntryId = new mongoose.Types.ObjectId(id);
  }

  // ── date range (on timestamp) ─────────────────────────────────────────────
  if (req.query.startDate || req.query.endDate) {
    filters.timestamp = {};
    if (req.query.startDate)
      filters.timestamp.$gte = new Date(req.query.startDate);
    if (req.query.endDate)
      filters.timestamp.$lte = new Date(req.query.endDate);
  }

  return filters;
}

/** Build a sort object; mirrors the DataEntry helper. */
function buildProcessEmissionSort(req) {
  const allowedFields = [
    'timestamp', 'date', 'time',
    'inputType', 'scopeType', 'nodeType',
    'emissionCalculationStatus',
    'dataEntryCumulative.incomingTotalValue',
    'dataEntryCumulative.cumulativeTotalValue',
    'dataEntryCumulative.entryCount',
    'createdAt', 'updatedAt',
  ];

  let { sortBy = 'timestamp', sortOrder = 'desc' } = req.query;
  if (!allowedFields.includes(sortBy)) sortBy = 'timestamp';
  return { [sortBy]: sortOrder === 'asc' ? 1 : -1 };
}

/** Pagination helper — returns { page, limit, skip }. */
function buildPagination(req) {
  const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
  const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) || 100));
  return { page, limit, skip: (page - 1) * limit };
}

// ============================================================================
// SECTION: ProcessEmissionDataEntry — Controller Functions
// ============================================================================

/**
 * GET /process-emission-entries/clients/:clientId/all
 *
 * Returns ALL ProcessEmissionDataEntry records for a client with
 * optional multi-filter support via query params:
 *   nodeId, scopeIdentifier, scopeType, inputType, nodeType,
 *   emissionCalculationStatus, sourceDataEntryId, startDate, endDate,
 *   sortBy, sortOrder, page, limit
 */
const getProcessEmissionEntries = async (req, res) => {
  try {
    const filters = buildProcessEmissionFilters(req);
    const sort     = buildProcessEmissionSort(req);
    const { page, limit, skip } = buildPagination(req);

    // Optional: select specific fields to reduce payload
    // const selectFields = req.query.fields
    //   ? req.query.fields.split(',').join(' ')
    //   : '';

    const [entries, total] = await Promise.all([
      ProcessEmissionDataEntry.find(filters)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      ProcessEmissionDataEntry.countDocuments(filters),
    ]);

    const totalPages = Math.ceil(total / limit);

    return res.status(200).json({
      success: true,
      message: 'Process emission entries fetched successfully',
      data: entries,
      filtersApplied: filters,
      sort,
      pagination: {
        currentPage:  page,
        totalPages,
        totalItems:   total,
        itemsPerPage: limit,
        hasNextPage:  page < totalPages,
        hasPrevPage:  page > 1,
      },
    });
  } catch (error) {
    if (error.statusCode === 403)
      return res.status(403).json({ success: false, message: error.message });
    if (error.statusCode === 400)
      return res.status(400).json({ success: false, message: error.message });

    console.error('[getProcessEmissionEntries]', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch process emission entries',
      error: error.message,
    });
  }
};


/**
 * GET /process-emission-entries/clients/:clientId/nodes/:nodeId
 *
 * Returns ProcessEmissionDataEntry records for a specific node
 * within a client. Supports the same query-param filters as
 * getProcessEmissionEntries.
 */
const getProcessEmissionEntriesByNode = async (req, res) => {
  try {
    const filters = buildProcessEmissionFilters(req);   // nodeId comes from req.params
    const sort     = buildProcessEmissionSort(req);
    const { page, limit, skip } = buildPagination(req);

    const [entries, total] = await Promise.all([
      ProcessEmissionDataEntry.find(filters)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      ProcessEmissionDataEntry.countDocuments(filters),
    ]);

    const totalPages = Math.ceil(total / limit);

    return res.status(200).json({
      success: true,
      message: 'Process emission entries for node fetched successfully',
      data: entries,
      filtersApplied: filters,
      sort,
      pagination: {
        currentPage:  page,
        totalPages,
        totalItems:   total,
        itemsPerPage: limit,
        hasNextPage:  page < totalPages,
        hasPrevPage:  page > 1,
      },
    });
  } catch (error) {
    if (error.statusCode === 403)
      return res.status(403).json({ success: false, message: error.message });
    if (error.statusCode === 400)
      return res.status(400).json({ success: false, message: error.message });

    console.error('[getProcessEmissionEntriesByNode]', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch process emission entries by node',
      error: error.message,
    });
  }
};


/**
 * GET /process-emission-entries/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier
 *
 * Returns ProcessEmissionDataEntry records for a specific
 * client + node + scope combination.
 */
const getProcessEmissionEntriesByScope = async (req, res) => {
  try {
    const filters = buildProcessEmissionFilters(req);   // includes scopeIdentifier
    const sort     = buildProcessEmissionSort(req);
    const { page, limit, skip } = buildPagination(req);

    const [entries, total] = await Promise.all([
      ProcessEmissionDataEntry.find(filters)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      ProcessEmissionDataEntry.countDocuments(filters),
    ]);

    const totalPages = Math.ceil(total / limit);

    return res.status(200).json({
      success: true,
      message: 'Process emission entries for scope fetched successfully',
      data: entries,
      filtersApplied: filters,
      sort,
      pagination: {
        currentPage:  page,
        totalPages,
        totalItems:   total,
        itemsPerPage: limit,
        hasNextPage:  page < totalPages,
        hasPrevPage:  page > 1,
      },
    });
  } catch (error) {
    if (error.statusCode === 403)
      return res.status(403).json({ success: false, message: error.message });
    if (error.statusCode === 400)
      return res.status(400).json({ success: false, message: error.message });

    console.error('[getProcessEmissionEntriesByScope]', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch process emission entries by scope',
      error: error.message,
    });
  }
};


/**
 * GET /process-emission-entries/:entryId
 *
 * Returns a single ProcessEmissionDataEntry by its MongoDB _id.
 */
const getProcessEmissionEntryById = async (req, res) => {
  try {
    const { entryId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(entryId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid entryId format',
      });
    }

    const entry = await ProcessEmissionDataEntry.findById(entryId).lean();

    if (!entry) {
      return res.status(404).json({
        success: false,
        message: 'Process emission entry not found',
      });
    }

    // Client isolation check
    const clientScopedTypes = [
      'client_admin', 'client_employee_head', 'employee', 'auditor', 'viewer',
    ];
    if (clientScopedTypes.includes(req.user?.userType)) {
      if (entry.clientId !== req.user.clientId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied: entry belongs to another client',
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Process emission entry fetched successfully',
      data: entry,
    });
  } catch (error) {
    console.error('[getProcessEmissionEntryById]', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch process emission entry',
      error: error.message,
    });
  }
};


/**
 * GET /process-emission-entries/clients/:clientId/summary/stats
 *
 * Returns aggregate statistics for ProcessEmissionDataEntry records:
 *   - total count
 *   - breakdown by scopeType
 *   - breakdown by inputType
 *   - breakdown by nodeType
 *   - breakdown by emissionCalculationStatus
 *   - date range of available records
 *
 * Supports the same optional query-param filters as getProcessEmissionEntries.
 */
const getProcessEmissionStats = async (req, res) => {
  try {
    const filters = buildProcessEmissionFilters(req);

    const [
      totalCount,
      scopeTypeBreakdown,
      inputTypeBreakdown,
      nodeTypeBreakdown,
      statusBreakdown,
      dateRange,
    ] = await Promise.all([
      // 1) total
      ProcessEmissionDataEntry.countDocuments(filters),

      // 2) by scopeType
      ProcessEmissionDataEntry.aggregate([
        { $match: filters },
        { $group: { _id: '$scopeType', count: { $sum: 1 } } },
        { $project: { _id: 0, scopeType: '$_id', count: 1 } },
        { $sort: { count: -1 } },
      ]),

      // 3) by inputType
      ProcessEmissionDataEntry.aggregate([
        { $match: filters },
        { $group: { _id: '$inputType', count: { $sum: 1 } } },
        { $project: { _id: 0, inputType: '$_id', count: 1 } },
        { $sort: { count: -1 } },
      ]),

      // 4) by nodeType
      ProcessEmissionDataEntry.aggregate([
        { $match: filters },
        { $group: { _id: '$nodeType', count: { $sum: 1 } } },
        { $project: { _id: 0, nodeType: '$_id', count: 1 } },
        { $sort: { count: -1 } },
      ]),

      // 5) by emissionCalculationStatus
      ProcessEmissionDataEntry.aggregate([
        { $match: filters },
        { $group: { _id: '$emissionCalculationStatus', count: { $sum: 1 } } },
        { $project: { _id: 0, status: '$_id', count: 1 } },
        { $sort: { count: -1 } },
      ]),

      // 6) date range
      ProcessEmissionDataEntry.aggregate([
        { $match: filters },
        {
          $group: {
            _id: null,
            earliest: { $min: '$timestamp' },
            latest:   { $max: '$timestamp' },
          },
        },
      ]),
    ]);

    return res.status(200).json({
      success: true,
      message: 'Process emission statistics fetched successfully',
      data: {
        totalCount,
        byScopeType:  scopeTypeBreakdown,
        byInputType:  inputTypeBreakdown,
        byNodeType:   nodeTypeBreakdown,
        byStatus:     statusBreakdown,
        dateRange: dateRange[0]
          ? { earliest: dateRange[0].earliest, latest: dateRange[0].latest }
          : null,
      },
      filtersApplied: filters,
    });
  } catch (error) {
    if (error.statusCode === 403)
      return res.status(403).json({ success: false, message: error.message });
    if (error.statusCode === 400)
      return res.status(400).json({ success: false, message: error.message });

    console.error('[getProcessEmissionStats]', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch process emission statistics',
      error: error.message,
    });
  }
};


/**
 * GET /process-emission-entries/clients/:clientId/minimal
 *
 * Lightweight version — returns only fields needed for dashboards:
 *   _id, clientId, nodeId, scopeIdentifier, scopeType, inputType,
 *   nodeType, timestamp, emissionCalculationStatus,
 *   calculatedEmissions (incoming & cumulative allocated totals),
 *   dataEntryCumulative
 *
 * Supports the same optional query-param filters as getProcessEmissionEntries.
 */
const getProcessEmissionEntriesMinimal = async (req, res) => {
  try {
    const filters = buildProcessEmissionFilters(req);
    const sort     = buildProcessEmissionSort(req);
    const { page, limit, skip } = buildPagination(req);

    const MINIMAL_PROJECTION = {
      _id:                        1,
      clientId:                   1,
      nodeId:                     1,
      sourceDataEntryId:          1,
      scopeIdentifier:            1,
      scopeType:                  1,
      inputType:                  1,
      nodeType:                   1,
      timestamp:                  1,
      date:                       1,
      emissionCalculationStatus:  1,
      dataEntryCumulative:        1,
      'calculatedEmissions.incoming.allocationPct':        1,
      'calculatedEmissions.incoming.allocated':            1,
      'calculatedEmissions.cumulative.allocationPct':      1,
      'calculatedEmissions.cumulative.allocated':          1,
      'calculatedEmissions.metadata':                      1,
    };

    const [entries, total] = await Promise.all([
      ProcessEmissionDataEntry.find(filters, MINIMAL_PROJECTION)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      ProcessEmissionDataEntry.countDocuments(filters),
    ]);

    const totalPages = Math.ceil(total / limit);

    return res.status(200).json({
      success: true,
      message: 'Minimal process emission entries fetched successfully',
      data: entries,
      filtersApplied: filters,
      sort,
      pagination: {
        currentPage:  page,
        totalPages,
        totalItems:   total,
        itemsPerPage: limit,
        hasNextPage:  page < totalPages,
        hasPrevPage:  page > 1,
      },
    });
  } catch (error) {
    if (error.statusCode === 403)
      return res.status(403).json({ success: false, message: error.message });
    if (error.statusCode === 400)
      return res.status(400).json({ success: false, message: error.message });

    console.error('[getProcessEmissionEntriesMinimal]', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch minimal process emission entries',
      error: error.message,
    });
  }
};


/**
 * GET /process-emission-entries/clients/:clientId/nodes/:nodeId/summary
 *
 * Returns an aggregated emission summary per node — useful for
 * dashboard charts.  Groups entries by scopeIdentifier and returns
 * the latest cumulative allocated totals for each gas metric.
 */
const getProcessEmissionNodeSummary = async (req, res) => {
  try {
    const filters = buildProcessEmissionFilters(req);

 const summaries = await ProcessEmissionDataEntry.aggregate([
  { $match: filters },
  { $sort: { timestamp: -1 } },
  {
    $group: {
      _id: {
        nodeId:          '$nodeId',
        scopeIdentifier: '$scopeIdentifier',
      },
      latestRecord:    { $first: '$$ROOT' },
      totalEntries:    { $sum: 1 },
      latestTimestamp: { $first: '$timestamp' },
      oldestTimestamp: { $last: '$timestamp' },
    },
  },
  {
    $project: {
      _id: 0,
      nodeId:          '$_id.nodeId',
      scopeIdentifier: '$_id.scopeIdentifier',
      scopeType:       '$latestRecord.scopeType',
      inputType:       '$latestRecord.inputType',
      nodeType:        '$latestRecord.nodeType',
      allocationPct:   '$latestRecord.calculatedEmissions.cumulative.allocationPct',
      cumulativeAllocated: '$latestRecord.calculatedEmissions.cumulative.allocated',
      incomingAllocated:   '$latestRecord.calculatedEmissions.incoming.allocated',
      metadata:        '$latestRecord.calculatedEmissions.metadata',
      dataEntryCumulative: '$latestRecord.dataEntryCumulative',
      totalEntries:    '$totalEntries',    // ✅ $ prefix to reference grouped field
      latestTimestamp: '$latestTimestamp', // ✅ $ prefix
      oldestTimestamp: '$oldestTimestamp', // ✅ $ prefix
    },
  },
  { $sort: { nodeId: 1, scopeIdentifier: 1 } },
]);

    return res.status(200).json({
      success: true,
      message: 'Process emission node summary fetched successfully',
      data: summaries,
      filtersApplied: filters,
    });
  } catch (error) {
    if (error.statusCode === 403)
      return res.status(403).json({ success: false, message: error.message });
    if (error.statusCode === 400)
      return res.status(400).json({ success: false, message: error.message });

    console.error('[getProcessEmissionNodeSummary]', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch process emission node summary',
      error: error.message,
    });
  }
};


module.exports = {
  saveProcessFlowchart,
  addNodeToProcessFlowchart,
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
  updateAllocations,
  getProcessEmissionEntries,
  getProcessEmissionEntriesByNode,
  getProcessEmissionEntriesByScope,
  getProcessEmissionEntryById,
  getProcessEmissionStats,
  getProcessEmissionEntriesMinimal,
  getProcessEmissionNodeSummary,  
};