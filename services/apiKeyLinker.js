const Reduction = require('../models/Reduction/Reduction');
const Flowchart = require('../models/Organization/Flowchart');
const ProcessFlowchart = require('../models/Organization/ProcessFlowchart');
const Client = require('../models/CMS/Client');
const Notification = require('../models/Notification/Notification');

/**
 * Builds endpoint for Data Collection
 */
function buildDCEndpoint({ clientId, nodeId, scopeIdentifier, key, type }) {
  const base = `/api/data-collection/clients/${clientId}/nodes/${nodeId}/scopes/${scopeIdentifier}/${key}`;
  return type === 'DC_API'
    ? `${base}/api-data`
    : `${base}/iot-data`;
}

/**
 * Builds endpoint for Net Reduction
 */
function buildNetEndpoint({ clientId, projectId, calculationMethodology, key, type }) {
  const base = `/api/net-reduction/${clientId}/${projectId}/${calculationMethodology}/${key}`;
  return type === 'NET_API'
    ? `${base}/api`
    : `${base}/iot`;
}

/**
 * 🔥 Single source of truth
 * Applies API key everywhere it must exist
 * ✅ FIXED: Properly updates both Flowchart and ProcessFlowchart for DC types
 * ✅ FIXED: Removed duplicate dead code
 */
async function applyKeyToNetReductionProject({
  clientId,
  projectId,
  nodeId,
  scopeIdentifier,
  calculationMethodology,
  keyType,
  keyValue,
  apiKeyId = null,
  requestId = null,
  approvedAt = null
}) {
  const now = approvedAt || new Date();

  // =====================================================
  // NET REDUCTION
  // =====================================================
  if (keyType === 'NET_API' || keyType === 'NET_IOT') {
    const reduction = await Reduction.findOne({
      clientId,
      projectId,
      calculationMethodology
    });

    if (!reduction) {
      console.log(`[applyKeyToNetReductionProject] Reduction not found for clientId: ${clientId}, projectId: ${projectId}, methodology: ${calculationMethodology}`);
      return null;
    }

    const endpoint = buildNetEndpoint({
      clientId,
      projectId,
      calculationMethodology,
      key: keyValue,
      type: keyType
    });

    if (!reduction.reductionDataEntry) reduction.reductionDataEntry = {};

    reduction.reductionDataEntry.inputType = keyType === 'NET_API' ? 'API' : 'IOT';
    reduction.reductionDataEntry.apiEndpoint = endpoint;
    reduction.reductionDataEntry.apiStatus = keyType === 'NET_API';
    reduction.reductionDataEntry.iotStatus = keyType === 'NET_IOT';

    // ✅ Update request status in Reduction.reductionDataEntry
    reduction.reductionDataEntry.apiKeyRequest = {
      ...(reduction.reductionDataEntry.apiKeyRequest || {}),
      status: 'approved',
      requestedInputType: reduction.reductionDataEntry.inputType,
      requestedAt: reduction.reductionDataEntry.apiKeyRequest?.requestedAt || now,
      approvedAt: now,
      rejectedAt: null,
      apiKeyId: apiKeyId || reduction.reductionDataEntry.apiKeyRequest?.apiKeyId || null,
      requestId: requestId || reduction.reductionDataEntry.apiKeyRequest?.requestId || null
    };

    reduction.markModified('reductionDataEntry');
    await reduction.save();
    
    console.log(`[applyKeyToNetReductionProject] ✅ Updated NET reduction: inputType=${reduction.reductionDataEntry.inputType}, endpoint=${endpoint}`);
    return reduction;
  }

  // =====================================================
  // DATA COLLECTION (ORG + PROCESS FLOWCHART)
  // ✅ FIXED: Combined both flowchart updates into single block
  // =====================================================
  if (keyType === 'DC_API' || keyType === 'DC_IOT') {
    const endpoint = buildDCEndpoint({
      clientId,
      nodeId,
      scopeIdentifier,
      key: keyValue,
      type: keyType
    });

    const inputType = keyType === 'DC_API' ? 'API' : 'IOT';
    const apiStatus = keyType === 'DC_API';
    const iotStatus = keyType === 'DC_IOT';

    let updatedFlowchart = null;
    let updatedProcessFlow = null;

    // ================= ORG FLOWCHART =================
    const flowchart = await Flowchart.findOne({ clientId, isActive: true });
    if (flowchart) {
      let scopeFound = false;
      
      for (const node of flowchart.nodes) {
        if (node.id !== nodeId) continue;
        const scope = node.details?.scopeDetails?.find(s => s.scopeIdentifier === scopeIdentifier);
        if (!scope) continue;

        scope.inputType = inputType;
        scope.apiEndpoint = endpoint;
        scope.apiStatus = apiStatus;
        scope.iotStatus = iotStatus;

        // ✅ Mark request as approved (Flowchart)
        scope.apiKeyRequest = {
          ...(scope.apiKeyRequest || {}),
          status: 'approved',
          requestedInputType: inputType,
          requestedAt: scope.apiKeyRequest?.requestedAt || now,
          approvedAt: now,
          rejectedAt: null,
          apiKeyId: apiKeyId || scope.apiKeyRequest?.apiKeyId || null,
          requestId: requestId || scope.apiKeyRequest?.requestId || null
        };

        scopeFound = true;
        break;
      }

      if (scopeFound) {
        flowchart.markModified('nodes');
        await flowchart.save();
        updatedFlowchart = flowchart;
        console.log(`[applyKeyToNetReductionProject] ✅ Updated Org Flowchart: inputType=${inputType}, endpoint=${endpoint}`);
      } else {
        console.log(`[applyKeyToNetReductionProject] ⚠️ Scope not found in Org Flowchart for nodeId: ${nodeId}, scopeIdentifier: ${scopeIdentifier}`);
      }
    } else {
      console.log(`[applyKeyToNetReductionProject] ⚠️ No active Org Flowchart found for clientId: ${clientId}`);
    }

    // ================= PROCESS FLOWCHART =================
    const processFlow = await ProcessFlowchart.findOne({ clientId, isActive: true });
    if (processFlow) {
      let scopeFound = false;
      
      for (const node of processFlow.nodes) {
        if (nodeId && node.id !== nodeId) continue;

        const scope = node.details?.scopeDetails?.find(
          (s) => s.scopeIdentifier === scopeIdentifier
        );
        if (!scope) continue;

        scope.inputType = inputType;
        scope.apiEndpoint = endpoint;
        scope.apiStatus = apiStatus;
        scope.iotStatus = iotStatus;

        // ✅ Mark request as approved (ProcessFlowchart)
        scope.apiKeyRequest = {
          ...(scope.apiKeyRequest || {}),
          status: 'approved',
          requestedInputType: inputType,
          requestedAt: scope.apiKeyRequest?.requestedAt || now,
          approvedAt: now,
          rejectedAt: null,
          apiKeyId: apiKeyId || scope.apiKeyRequest?.apiKeyId || null,
          requestId: requestId || scope.apiKeyRequest?.requestId || null
        };

        scopeFound = true;
        break;
      }

      if (scopeFound) {
        processFlow.markModified('nodes');
        await processFlow.save();
        updatedProcessFlow = processFlow;
        console.log(`[applyKeyToNetReductionProject] ✅ Updated Process Flowchart: inputType=${inputType}, endpoint=${endpoint}`);
      } else {
        console.log(`[applyKeyToNetReductionProject] ⚠️ Scope not found in Process Flowchart for scopeIdentifier: ${scopeIdentifier}`);
      }
    } else {
      console.log(`[applyKeyToNetReductionProject] ⚠️ No active Process Flowchart found for clientId: ${clientId}`);
    }

    // ================= CLIENT.workflowTracking =================
    const client = await Client.findOne({ clientId });
    if (!client) {
      console.log(`[applyKeyToNetReductionProject] ⚠️ Client not found: ${clientId}`);
      return updatedProcessFlow || updatedFlowchart;
    }

    const pointId = `${nodeId}_${scopeIdentifier}`;

    // Initialize if not exists
    if (!client.workflowTracking) client.workflowTracking = {};
    if (!client.workflowTracking.dataInputPoints) client.workflowTracking.dataInputPoints = {};
    if (!client.workflowTracking.dataInputPoints.api) client.workflowTracking.dataInputPoints.api = { inputs: [] };
    if (!client.workflowTracking.dataInputPoints.iot) client.workflowTracking.dataInputPoints.iot = { inputs: [] };

    // Remove old inputs for this point
    client.workflowTracking.dataInputPoints.api.inputs =
      client.workflowTracking.dataInputPoints.api.inputs.filter(i => i.pointId !== pointId);

    client.workflowTracking.dataInputPoints.iot.inputs =
      client.workflowTracking.dataInputPoints.iot.inputs.filter(i => i.pointId !== pointId);

    // Add new input based on type
    if (keyType === 'DC_API') {
      client.workflowTracking.dataInputPoints.api.inputs.push({
        pointId,
        nodeId,
        scopeIdentifier,
        endpoint,
        status: 'pending',
        connectionStatus: 'connected'
      });
    }

    if (keyType === 'DC_IOT') {
      client.workflowTracking.dataInputPoints.iot.inputs.push({
        pointId,
        nodeId,
        scopeIdentifier,
        endpoint,
        status: 'pending ',
        connectionStatus: 'connected'
      });
    }

    client.markModified('workflowTracking');
    await client.save();
    console.log(`[applyKeyToNetReductionProject] ✅ Updated Client.workflowTracking for ${keyType}`);

    return updatedProcessFlow || updatedFlowchart;
  }

  return null;
}

/**
 * Sends client-side notification after API key is ready
 */
async function notifyClientApiKeyReady({
  clientId,
  keyType,
  projectId,
  nodeId,
  scopeIdentifier,
  apiKey,
  actorId,
  actorType
}) {
  let title = 'API Key Ready';
  let message = '';

  if (keyType.startsWith('NET')) {
    message =
      `API key for Net Reduction is ready.\n\n` +
      `Project: ${projectId}\n` +
      `Type: ${keyType.includes('API') ? 'API' : 'IoT'}\n\n` +
      `Key is attached in email.`;
  } else {
    message =
      `API key for Data Collection is ready.\n\n` +
      `Node: ${nodeId}\n` +
      `Scope: ${scopeIdentifier}\n` +
      `Type: ${keyType.includes('API') ? 'API' : 'IoT'}\n\n` +
      `Key is attached in email.`;
  }

  await Notification.create({
    title,
    message,
    createdBy: actorId,
    creatorType: actorType,
    targetClients: [clientId],
    isSystemNotification: true,
    systemAction: 'api_key_ready',
    status: 'published',
    publishedAt: new Date()
  });
}

async function notifyClientApiKeyRejected({
  clientId,
  keyType,
  projectId,
  nodeId,
  scopeIdentifier,
  actorId,
  actorType
}) {
  let message = '';

  if (keyType.startsWith('NET')) {
    message = `API Key request rejected.\nProject: ${projectId}\nType: ${keyType}`;
  } else {
    message = `API Key request rejected.\nNode: ${nodeId}\nScope: ${scopeIdentifier}\nType: ${keyType}`;
  }

  await Notification.create({
    title: 'API Key Request Rejected',
    message,
    createdBy: actorId,
    creatorType: actorType,
    targetClients: [clientId],
    isSystemNotification: true,
    systemAction: 'api_key_rejected',
    status: 'published',
    publishedAt: new Date()
  });
}

module.exports = {
  applyKeyToNetReductionProject,
  notifyClientApiKeyReady,
  notifyClientApiKeyRejected
};