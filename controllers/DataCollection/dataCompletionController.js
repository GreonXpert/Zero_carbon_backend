// controllers/DataCollection/dataCompletionController.js

const moment = require('moment');
const Client = require('../../models/CMS/Client');
const Flowchart = require('../../models/Organization/Flowchart');
const ProcessFlowchart = require('../../models/Organization/ProcessFlowchart');
const DataEntry = require('../../models/Organization/DataEntry');
const NetReductionEntry = require('../../models/Reduction/NetReductionEntry');
const Reduction = require('../../models/Reduction/Reduction');
const Notification = require('../../models/Notification/Notification');

const {
  getCurrentWindowForFrequency,
  isDataMissingForCurrentWindow,
} = require('../../utils/DataCollection/dataFrequencyHelper');

// =================== Socket.IO ===================

let io = null;
function setSocketIO(socketIoInstance) {
  io = socketIoInstance;
}

// Broadcast stats to all listeners for this client
async function broadcastDataCompletionUpdate(clientId, now = new Date()) {
  if (!io) return;

  try {
    const stats = await calculateDataCompletionStatsForClient(clientId, now);
    const payload = {
      clientId,
      stats,
      timestamp: new Date().toISOString(),
    };

    // Room specifically for data-completion widgets
    io.to(`data-completion-${clientId}`).emit('data-completion-update', payload);

    // Also send to general client room (already used in your app)
    io.to(`client_${clientId}`).emit('data-completion-update', payload);
  } catch (error) {
    console.error('broadcastDataCompletionUpdate error:', error);
  }
}

/**
 * Broadcast ONLY the net-reduction data-completion stats via Socket.IO
 * so frontend can update in real-time.
 */
async function broadcastNetReductionCompletionUpdate(clientId, now = new Date()) {
  if (!io) {
    console.warn('Socket.IO not initialized for net reduction data completion');
    return;
  }

  try {
    const stats = await calculateNetReductionCompletionStatsForClient(clientId, now);

    const payload = {
      eventType: 'net-reduction-data-completion',
      clientId,
      stats
    };

    // Send to client-specific rooms (same pattern as data-completion-update)
    io.to(`client_${clientId}`).emit('net-reduction-data-completion-update', payload);
    io.to(`client-${clientId}`).emit('net-reduction-data-completion-update', payload);
  } catch (err) {
    console.error('Error broadcasting net reduction data completion update:', err);
  }
}

// =================== Notification Helpers ===================

// You can replace this with your existing helper if you want
async function createMissingDataNotification({
  client,
  title,
  message,
  targetUserTypes = ['client_admin', 'client_employee_head'],
  extraTargetUsers = [],
}) {
  const notif = await Notification.create({
    title,
    message,
    status: 'published',
    priority: 'high',
    isDeleted: false,
    targetClients: [client.clientId],
    targetUserTypes,
    targetUsers: extraTargetUsers,
    createdBy: null,        // system
    createdByType: 'system',
    createdAt: new Date(),
  });

  if (global.broadcastNotification) {
    global.broadcastNotification(notif);
  }

  return notif;
}

/**
 * Get all scopes (organization + process) with collectionFrequency for a client
 * Returns array of { type: 'organization'|'process', node, scope }
 */
async function getAllScopesWithFrequencyForClient(clientId) {
  const result = [];

  // Flowchart has no isDeleted → use isActive
  const [orgFlowchart, procFlowchart] = await Promise.all([
    Flowchart.findOne({ clientId, isActive: true }).lean(),
    ProcessFlowchart.findOne({ clientId, isDeleted: false }).lean(),
  ]);

  // ---- ORGANIZATION FLOWCHART ----
  if (orgFlowchart?.nodes?.length) {
    for (const node of orgFlowchart.nodes) {
      const scopes = node.details?.scopeDetails || [];
      for (const scope of scopes) {
        if (!scope.isDeleted && scope.collectionFrequency) {
          result.push({
            type: 'organization',
            node,
            scope,
          });
        }
      }
    }
  }

  // ---- PROCESS FLOWCHART ----
  if (procFlowchart?.nodes?.length) {
    for (const node of procFlowchart.nodes) {
      const scopes = node.details?.scopeDetails || [];
      for (const scope of scopes) {
        if (!scope.isDeleted && scope.collectionFrequency) {
          result.push({
            type: 'process',
            node,
            scope,
          });
        }
      }
    }
  }

  return result;
}

/**
 * INTERNAL: for a single emission scope (node + scope), check if data is missing
 * and send notification if needed.
 */
async function checkEmissionScopeAndNotify(client, scopeCtx, now = new Date()) {
  const { node, scope, type: assessmentLevel } = scopeCtx;

  const collectionFrequency = scope.collectionFrequency || 'monthly';

  if (!scope.inputType) return; // nothing to collect

  const { from, to } = getCurrentWindowForFrequency(collectionFrequency, now);

  const lastEntry = await DataEntry.findOne({
    clientId: client.clientId,
    nodeId: node.id,
    scopeIdentifier: scope.scopeIdentifier,
    timestamp: { $lte: to },
  })
    .sort({ timestamp: -1 })
    .lean();

  const lastEntryAt = lastEntry?.timestamp;

  const missing = isDataMissingForCurrentWindow(collectionFrequency, lastEntryAt, now);
  if (!missing) return;

  const extraTargetUsers = Array.isArray(scope.assignedEmployees)
    ? scope.assignedEmployees
    : [];

  const title = `Missing emission data for ${scope.scopeIdentifier}`;
  const message = [
    `Client: ${client.clientName || client.clientId}`,
    `Node: ${node.label}`,
    `Scope Identifier: ${scope.scopeIdentifier}`,
    `Assessment Level: ${assessmentLevel}`,
    `Frequency: ${collectionFrequency}`,
    `Expected window: ${from.toISOString()} → ${to.toISOString()}`,
    lastEntryAt
      ? `Last data entry date: ${new Date(lastEntryAt).toISOString()}`
      : 'No data has ever been recorded for this scope.',
  ].join('\n');

  await createMissingDataNotification({
    client,
    title,
    message,
    extraTargetUsers,
  });
}

/**
 * INTERNAL: for a client's reductions, check NetReduction entries and notify if missing.
 */
async function checkNetReductionAndNotify(client, now = new Date()) {
  const reductions = await Reduction.find({
    clientId: client.clientId,
    isDeleted: { $ne: true },
  })
    .select('reductionId projectId projectName reportingFrequency')
    .lean();

  for (const red of reductions) {
    const freqField = red.reportingFrequency || 'monthly';
    const { from, to } = getCurrentWindowForFrequency(freqField, now);

    const lastNet = await NetReductionEntry.findOne({
      clientId: client.clientId,
      projectId: red.projectId,
      timestamp: { $lte: to },
    })
      .sort({ timestamp: -1 })
      .lean();

    const lastAt = lastNet?.timestamp;

    const missing = isDataMissingForCurrentWindow(freqField, lastAt, now);
    if (!missing) continue;

    const title = `Missing Net Reduction data for project ${red.projectName}`;
    const message = [
      `Client: ${client.clientName || client.clientId}`,
      `Reduction Project: ${red.projectName} (${red.projectId})`,
      `Frequency: ${freqField}`,
      `Expected window: ${from.toISOString()} → ${to.toISOString()}`,
      lastAt
        ? `Last Net Reduction entry: ${new Date(lastAt).toISOString()}`
        : 'No Net Reduction entry has been recorded for this project in this period.',
    ].join('\n');

    await createMissingDataNotification({
      client,
      title,
      message,
    });
  }
}

/**
 * === CRON FUNCTION ===
 * Iterate over clients & send "missing data" notifications.
 */
async function checkDataFrequencyAndNotifyAllClients(now = new Date()) {
  const clients = await Client.find({ isDeleted: { $ne: true } })
    .select('clientId clientName')
    .lean();

  for (const client of clients) {
    const scopes = await getAllScopesWithFrequencyForClient(client.clientId);

    for (const scopeCtx of scopes) {
      await checkEmissionScopeAndNotify(client, scopeCtx, now);
    }

    await checkNetReductionAndNotify(client, now);
  }
}

// =================== Stats Helper ===================

/**
 * Pure function: calculate data completion stats for a client.
 * Used by HTTP API and Socket.IO.
 */
async function calculateDataCompletionStatsForClient(clientId, now = new Date()) {
  const client = await Client.findOne({ clientId }).select('clientId clientName').lean();
  if (!client) {
    const error = new Error('Client not found');
    error.statusCode = 404;
    throw error;
  }

  const scopes = await getAllScopesWithFrequencyForClient(clientId);

  const stats = {
    clientId,
    clientName: client.clientName,
    generatedAt: now,
    overall: {
      expected: 0,
      completed: 0,
      completionPercent: 0,
    },
    byAssessmentLevel: {
      organization: { expected: 0, completed: 0, completionPercent: 0 },
      process: { expected: 0, completed: 0, completionPercent: 0 },
    },
    byInputType: {
      manual: { expected: 0, completed: 0, completionPercent: 0 },
      API: { expected: 0, completed: 0, completionPercent: 0 },
      IOT: { expected: 0, completed: 0, completionPercent: 0 },
    },
  };

  for (const scopeCtx of scopes) {
    const { node, scope, type: assessmentLevel } = scopeCtx;
    const collectionFrequency = scope.collectionFrequency || 'monthly';

    // Normalise inputType to our keys
    const rawInputType = scope.inputType || 'manual';
    let inputType;
    if (rawInputType.toLowerCase() === 'manual') inputType = 'manual';
    else if (rawInputType.toLowerCase() === 'api') inputType = 'API';
    else if (rawInputType.toLowerCase() === 'iot') inputType = 'IOT';
    else inputType = rawInputType;

    const { from, to } = getCurrentWindowForFrequency(collectionFrequency, now);

    // Expected one update per period
    stats.overall.expected += 1;
    if (stats.byAssessmentLevel[assessmentLevel]) {
      stats.byAssessmentLevel[assessmentLevel].expected += 1;
    }

    if (!stats.byInputType[inputType]) {
      stats.byInputType[inputType] = { expected: 0, completed: 0, completionPercent: 0 };
    }
    stats.byInputType[inputType].expected += 1;

    const lastEntry = await DataEntry.findOne({
      clientId,
      nodeId: node.id,
      scopeIdentifier: scope.scopeIdentifier,
      timestamp: { $gte: from, $lte: to },
    })
      .sort({ timestamp: -1 })
      .lean();

    const hasDataThisPeriod = !!lastEntry;

    if (hasDataThisPeriod) {
      stats.overall.completed += 1;
      if (stats.byAssessmentLevel[assessmentLevel]) {
        stats.byAssessmentLevel[assessmentLevel].completed += 1;
      }
      stats.byInputType[inputType].completed += 1;
    }
  }

  const safePercent = (completed, expected) =>
    expected > 0 ? Math.round((completed / expected) * 100) : 0;

  stats.overall.completionPercent = safePercent(
    stats.overall.completed,
    stats.overall.expected,
  );

  for (const level of ['organization', 'process']) {
    const block = stats.byAssessmentLevel[level];
    block.completionPercent = safePercent(block.completed, block.expected);
  }

  for (const key of Object.keys(stats.byInputType)) {
    const block = stats.byInputType[key];
    block.completionPercent = safePercent(block.completed, block.expected);
  }

  return stats;
}

/**
 * Net Reduction data completion / frequency stats for a client.
 * Uses Reduction.reportingFrequency and NetReductionEntry timestamp window.
 */
async function calculateNetReductionCompletionStatsForClient(clientId, now = new Date()) {
  const nowMoment = moment(now);

  // Fetch all non-deleted reductions for this client
  const reductions = await Reduction.find({
    clientId,
    isDeleted: { $ne: true }
  })
    .select('_id projectId projectName reportingFrequency')
    .lean();

  const byProject = [];
  let totalExpected = 0;
  let totalCompleted = 0;

  for (const reduction of reductions) {
    // reportingFrequency might be string, object, or undefined.
    // Normalize safely to a lowercase string with default "monthly".
    const rawFreq =
      (typeof reduction.reportingFrequency === 'string'
        ? reduction.reportingFrequency
        : 'monthly');

    const frequency = rawFreq.toLowerCase();

    // Current time window for this project's reporting frequency
    const windowInfo = getCurrentWindowForFrequency(frequency, now);
    const { from, to } = windowInfo;

    // Check if there is any NetReductionEntry in this window
    const lastEntry = await NetReductionEntry.findOne({
      clientId,
      projectId: reduction.projectId,
      timestamp: { $gte: from, $lte: to }
    })
      .sort({ timestamp: -1 })
      .lean();

    const hasData = !!lastEntry;

    // For now: expected = 1 record per period per project
    const expected = 1;
    const completed = hasData ? 1 : 0;

    totalExpected += expected;
    totalCompleted += completed;

    const completionPercent =
      expected === 0 ? 0 : Math.round((completed / expected) * 100);

    byProject.push({
      reductionId: reduction._id,
      projectId: reduction.projectId,
      projectName: reduction.projectName,
      reportingFrequency: frequency,
      currentWindow: windowInfo,
      expected,
      completed,
      completionPercent,
      isMissing: !hasData,
      lastEntryAt: lastEntry ? lastEntry.timestamp : null
    });
  }

  const overallCompletionPercent =
    totalExpected === 0 ? 0 : Math.round((totalCompleted / totalExpected) * 100);

  return {
    clientId,
    generatedAt: nowMoment.toISOString(),
    totals: {
      projects: reductions.length,
      expected: totalExpected,
      completed: totalCompleted,
      completionPercent: overallCompletionPercent
    },
    byProject
  };
}



/**
 * GET /api/net-reduction/:clientId/data-completion
 * Returns net reduction data completion stats for the current frequency window.
 */
async function getNetReductionCompletionStats(req, res) {
  try {
    const { clientId } = req.params;
    const now = new Date();

    const stats = await calculateNetReductionCompletionStatsForClient(clientId, now);

    return res.status(200).json({
      success: true,
      clientId,
      stats
    });
  } catch (error) {
    console.error('getNetReductionCompletionStats error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to compute net reduction data completion stats',
      error: error.message
    });
  }
}



/**
 * === HTTP API ===
 * GET /api/data-collection/clients/:clientId/data-completion
 */
async function getDataCompletionStats(req, res) {
  try {
    const { clientId } = req.params;
    const stats = await calculateDataCompletionStatsForClient(clientId, new Date());

    return res.status(200).json({
      success: true,
      message: 'Data completion stats fetched successfully',
      data: stats,
    });
  } catch (err) {
    console.error('getDataCompletionStats error:', err);
    const status = err.statusCode || 500;
    return res.status(status).json({
      success: false,
      message: 'Failed to fetch data completion stats',
      error: err.message,
    });
  }
}

module.exports = {
  // cron
  checkDataFrequencyAndNotifyAllClients,

  // http
  getDataCompletionStats,

  // sockets
  setSocketIO,
  broadcastDataCompletionUpdate,
  calculateDataCompletionStatsForClient,
  
  // 🔥 NEW: Net Reduction data completion helpers
  calculateNetReductionCompletionStatsForClient,
  getNetReductionCompletionStats,
  broadcastNetReductionCompletionUpdate
};
