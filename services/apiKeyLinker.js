const Reduction = require('../models/Reduction/Reduction');
const Flowchart = require('../models/Organization/Flowchart');
const processflowchart = require('../models/Organization/ProcessFlowchart')
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
 */
async function applyKeyToNetReductionProject({
  clientId,
  projectId,
  nodeId,
  scopeIdentifier,
  calculationMethodology,
  keyType,
  keyValue
}) {
  // =====================================================
  // NET REDUCTION
  // =====================================================
  if (keyType === 'NET_API' || keyType === 'NET_IOT') {
    const reduction = await Reduction.findOne({
      clientId,
      projectId,
      calculationMethodology
    });

    if (!reduction) return null;

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

    await reduction.save();
    return reduction;
  }

  // =====================================================
  // DATA COLLECTION (ORG / PROCESS FLOWCHART)
  // =====================================================
  if (keyType === 'DC_API' || keyType === 'DC_IOT') {
    const flowchart = await Flowchart.findOne({ clientId, isActive:true });
    if (!flowchart) return null;

    let scope;

    for (const node of flowchart.nodes) {
      if (node.id !== nodeId) continue;
      scope = node.details.scopeDetails.find(s => s.scopeIdentifier === scopeIdentifier);
      if (scope) break;
    }

    if (!scope) return null;

    const endpoint = buildDCEndpoint({
      clientId,
      nodeId,
      scopeIdentifier,
      key: keyValue,
      type: keyType
    });

    scope.inputType = keyType === 'DC_API' ? 'API' : 'IOT';
    scope.apiEndpoint = endpoint;
    scope.apiStatus = keyType === 'DC_API';
    scope.iotStatus = keyType === 'DC_IOT';

    flowchart.markModified('nodes');
    await flowchart.save();

    // 🔁 Also update Client.workflowTracking
    const client = await Client.findOne({ clientId });
    if (!client) return null;

    const pointId = `${nodeId}_${scopeIdentifier}`;

    // Remove old inputs
    client.workflowTracking.dataInputPoints.api.inputs =
      client.workflowTracking.dataInputPoints.api.inputs.filter(i => i.pointId !== pointId);

    client.workflowTracking.dataInputPoints.iot.inputs =
      client.workflowTracking.dataInputPoints.iot.inputs.filter(i => i.pointId !== pointId);

    if (keyType === 'DC_API') {
      client.workflowTracking.dataInputPoints.api.inputs.push({
        pointId,
        nodeId,
        scopeIdentifier,
        endpoint,
        status: 'active',
        connectionStatus: 'connected'
      });
    }

    if (keyType === 'DC_IOT') {
      client.workflowTracking.dataInputPoints.iot.inputs.push({
        pointId,
        nodeId,
        scopeIdentifier,
        endpoint,
        status: 'active',
        connectionStatus: 'connected'
      });
    }

    await client.save();
    return flowchart;
  }
  // =====================================================
// DATA COLLECTION (ORG + PROCESS FLOWCHART)
// =====================================================
if (keyType === 'DC_API' || keyType === 'DC_IOT') {

  const endpoint = buildDCEndpoint({
    clientId,
    nodeId,
    scopeIdentifier,
    key: keyValue,
    type: keyType
  });

  // ================= ORG FLOWCHART =================
  const flowchart = await Flowchart.findOne({ clientId, isActive:true });
  if (flowchart) {
    for (const node of flowchart.nodes) {
      if (node.id !== nodeId) continue;
      const scope = node.details.scopeDetails.find(s => s.scopeIdentifier === scopeIdentifier);
      if (!scope) continue;

      scope.inputType = keyType === 'DC_API' ? 'API' : 'IOT';
      scope.apiEndpoint = endpoint;
      scope.apiStatus = keyType === 'DC_API';
      scope.iotStatus = keyType === 'DC_IOT';
    }

    flowchart.markModified('nodes');
    await flowchart.save();
  }

  // ================= PROCESS FLOWCHART =================
  const processFlow = await ProcessFlowchart.findOne({ clientId, isActive:true });
  if (processFlow) {
    for (const node of processFlow.nodes) {
      const scope = node.scopeDetails?.find(s => s.scopeIdentifier === scopeIdentifier);
      if (!scope) continue;

      scope.inputType = keyType === 'DC_API' ? 'API' : 'IOT';
      scope.apiEndpoint = endpoint;
      scope.apiStatus = keyType === 'DC_API';
      scope.iotStatus = keyType === 'DC_IOT';
    }

    processFlow.markModified('nodes');
    await processFlow.save();
  }

  // ================= CLIENT.workflowTracking =================
  const client = await Client.findOne({ clientId });
  if (!client) return null;

  const pointId = `${nodeId}_${scopeIdentifier}`;

  client.workflowTracking.dataInputPoints.api.inputs =
    client.workflowTracking.dataInputPoints.api.inputs.filter(i => i.pointId !== pointId);

  client.workflowTracking.dataInputPoints.iot.inputs =
    client.workflowTracking.dataInputPoints.iot.inputs.filter(i => i.pointId !== pointId);

  if (keyType === 'DC_API') {
    client.workflowTracking.dataInputPoints.api.inputs.push({
      pointId,
      nodeId,
      scopeIdentifier,
      endpoint,
      status: 'active',
      connectionStatus: 'connected'
    });
  }

  if (keyType === 'DC_IOT') {
    client.workflowTracking.dataInputPoints.iot.inputs.push({
      pointId,
      nodeId,
      scopeIdentifier,
      endpoint,
      status: 'active',
      connectionStatus: 'connected'
    });
  }

  await client.save();
  return processFlow || flowchart;
}
  return null;
}

/**
 * Sends client-side notification after API key is ready
 */
// services/apiKeyLinker.js
async function notifyClientApiKeyReady({
  clientId,
  keyType,
  projectId,
  nodeId,
  scopeIdentifier,
  apiKey,
  actorId,          // ✅ add
  actorType         // ✅ add
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

    // ✅ REQUIRED by schema
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
