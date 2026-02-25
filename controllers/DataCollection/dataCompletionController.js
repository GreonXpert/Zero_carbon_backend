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
// ─── Helpers ──────────────────────────────────────────────────────────────────

const toStr = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (v._id != null) return String(v._id);
  if (v.id  != null) return String(v.id);
  return typeof v.toString === 'function' ? v.toString() : '';
};

/**
 * Derive month + year from a JS Date (1-indexed month).
 */
function getPeriodFromDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return {
    month: d.getMonth() + 1, // 1-12
    year:  d.getFullYear(),
  };
}

// ─── Core computation ─────────────────────────────────────────────────────────

/**
 * calculateDataCompletionStatsForClient
 *
 * Returns completion statistics for a client's flowchart scopes.
 * If `options.allowedNodeIds` or `options.allowedScopeIdentifiers` is provided,
 * only the matching scopes are included — the DB aggregation is scoped at
 * query time for performance (no post-filter).
 *
 * @param {string} clientId
 * @param {Date}   referenceDate   - determines the current period (month/year)
 * @param {object} [options]
 * @param {Set<string>} [options.allowedNodeIds]          - restrict to these nodeIds   (employee_head)
 * @param {Set<string>} [options.allowedScopeIdentifiers] - restrict to these scopes   (employee)
 *
 * @returns {object} See "Return shape" section at bottom of file.
 */
async function calculateDataCompletionStatsForClient(clientId, referenceDate, options = {}) {
  const { allowedNodeIds, allowedScopeIdentifiers } = options;
  const hasNodeFilter  = allowedNodeIds          instanceof Set && allowedNodeIds.size  > 0;
  const hasScopeFilter = allowedScopeIdentifiers instanceof Set && allowedScopeIdentifiers.size > 0;

  // ── 1. Fetch the active flowchart ──────────────────────────────────────────
  const flowchart = await Flowchart.findOne({ clientId, isActive: true }).lean();
  if (!flowchart || !Array.isArray(flowchart.nodes)) {
    return _buildEmptyStats(clientId, referenceDate);
  }

  // ── 2. Build the definitive list of scopes the user is allowed to see ──────
  //    Each entry in `scopePlan` represents ONE scope cell in the flowchart.
  const scopePlan = []; // { nodeId, nodeLabel, department, location, scopeIdentifier, scopeType, inputType, categoryName }

  for (const node of flowchart.nodes) {
    const details = node.details || {};
    const nodeId  = node.id;

    // Respect node-level restriction (employee_head)
    if (hasNodeFilter && !allowedNodeIds.has(nodeId)) continue;

    const scopeDetails = Array.isArray(details.scopeDetails) ? details.scopeDetails : [];

    for (const sd of scopeDetails) {
      if (!sd.scopeIdentifier || sd.isDeleted) continue;

      // Respect scope-level restriction (employee)
      if (hasScopeFilter && !allowedScopeIdentifiers.has(sd.scopeIdentifier)) continue;

      scopePlan.push({
        nodeId,
        nodeLabel:       node.label        || '',
        department:      details.department || '',
        location:        details.location   || '',
        scopeIdentifier: sd.scopeIdentifier,
        scopeType:       sd.scopeType       || '',
        inputType:       sd.inputType       || 'manual',
        categoryName:    sd.categoryName    || '',
        activity:        sd.activity        || '',
      });
    }
  }

  // No scopes accessible → return empty (fail-closed)
  if (scopePlan.length === 0) {
    return _buildEmptyStats(clientId, referenceDate);
  }

  // ── 3. Single aggregation: which scopes have ≥1 DataEntry this period ──────
  const { month, year } = getPeriodFromDate(referenceDate);

  // Period boundaries: first millisecond of month → first millisecond of next month
  const periodStart = new Date(year, month - 1, 1);            // month is 1-indexed
  const periodEnd   = new Date(year, month,     1);            // exclusive upper bound

  // Only query for the scopeIdentifiers we care about (scoped at DB level)
  const scopeIdentifiersInPlan = scopePlan.map(s => s.scopeIdentifier);

  // Build optional nodeId constraint for employee_head (tightens the DB scan further)
  const nodeIdsInPlan = hasNodeFilter
    ? Array.from(allowedNodeIds)
    : [...new Set(scopePlan.map(s => s.nodeId))];

  const matchStage = {
    clientId,
    nodeId:          { $in: nodeIdsInPlan },
    scopeIdentifier: { $in: scopeIdentifiersInPlan },
    isSummary:       false,
    timestamp:       { $gte: periodStart, $lt: periodEnd },
  };

  // Aggregate: one document per unique (nodeId, scopeIdentifier) pair that has data
  const completedAgg = await DataEntry.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: {
          nodeId:          '$nodeId',
          scopeIdentifier: '$scopeIdentifier',
        },
        entryCount:    { $sum: 1 },
        latestEntry:   { $max: '$timestamp' },
        inputTypes:    { $addToSet: '$inputType' },
      },
    },
  ]);

  // Build a fast lookup: "nodeId|scopeIdentifier" → aggregation result
  const completedMap = new Map();
  for (const row of completedAgg) {
    const key = `${row._id.nodeId}|${row._id.scopeIdentifier}`;
    completedMap.set(key, {
      entryCount:  row.entryCount,
      latestEntry: row.latestEntry,
      inputTypes:  row.inputTypes,
    });
  }

  // ── 4. Build the flat scope list (Option A shape) ─────────────────────────
  const scopes = scopePlan.map(s => {
    const key      = `${s.nodeId}|${s.scopeIdentifier}`;
    const aggData  = completedMap.get(key) || null;
    const hasData  = aggData !== null;

    return {
      nodeId:          s.nodeId,
      nodeLabel:       s.nodeLabel,
      department:      s.department,
      location:        s.location,
      scopeIdentifier: s.scopeIdentifier,
      scopeType:       s.scopeType,
      inputType:       s.inputType,
      categoryName:    s.categoryName,
      activity:        s.activity,
      hasData,
      entryCount:  hasData ? aggData.entryCount  : 0,
      latestEntry: hasData ? aggData.latestEntry : null,
      inputTypes:  hasData ? aggData.inputTypes  : [],
      status:      hasData ? 'completed' : 'pending',
    };
  });

  // ── 5. Compute summary totals ──────────────────────────────────────────────
  const totalScopes     = scopes.length;
  const completedScopes = scopes.filter(s => s.hasData).length;
  const pendingScopes   = totalScopes - completedScopes;
  const completionPercentage = totalScopes > 0
    ? parseFloat(((completedScopes / totalScopes) * 100).toFixed(1))
    : 0;

  // ── 6. Break down by scope type (Scope 1 / 2 / 3) ─────────────────────────
  const byScopeType = {};
  for (const s of scopes) {
    const st = s.scopeType || 'Unknown';
    if (!byScopeType[st]) {
      byScopeType[st] = { total: 0, completed: 0, pending: 0, completionPercentage: 0 };
    }
    byScopeType[st].total += 1;
    if (s.hasData) byScopeType[st].completed += 1;
    else           byScopeType[st].pending   += 1;
  }
  for (const st of Object.keys(byScopeType)) {
    const g = byScopeType[st];
    g.completionPercentage = g.total > 0
      ? parseFloat(((g.completed / g.total) * 100).toFixed(1))
      : 0;
  }

  // ── 7. Break down by node ──────────────────────────────────────────────────
  const byNodeMap = new Map();
  for (const s of scopes) {
    if (!byNodeMap.has(s.nodeId)) {
      byNodeMap.set(s.nodeId, {
        nodeId:    s.nodeId,
        nodeLabel: s.nodeLabel,
        department: s.department,
        location:   s.location,
        total:     0, completed: 0, pending: 0, completionPercentage: 0,
      });
    }
    const n = byNodeMap.get(s.nodeId);
    n.total += 1;
    if (s.hasData) n.completed += 1;
    else           n.pending   += 1;
  }
  for (const n of byNodeMap.values()) {
    n.completionPercentage = n.total > 0
      ? parseFloat(((n.completed / n.total) * 100).toFixed(1))
      : 0;
  }

  return {
    clientId,
    period: {
      month,
      year,
      label: periodStart.toLocaleString('default', { month: 'long' }) + ' ' + year,
      startDate: periodStart.toISOString(),
      endDate:   new Date(year, month, 0).toISOString(), // last day of month
    },
    summary: {
      totalScopes,
      completedScopes,
      pendingScopes,
      completionPercentage,
      isFiltered: hasNodeFilter || hasScopeFilter,   // tells the frontend it's a role-scoped view
    },
    byScopeType,
    byNode: Array.from(byNodeMap.values()),
    scopes,                  // flat list — Option A shape
  };
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
// ─── HTTP handler ─────────────────────────────────────────────────────────────

/**
 * GET /api/data-collection/clients/:clientId/data-completion
 *
 * Reads req.dataEntryAccessContext (attached by attachDataEntryAccessContext
 * middleware) and passes the allowed sets into calculateDataCompletionStatsForClient
 * so the DB aggregation is scoped at query level — no post-filter required.
 *
 * Query params:
 *   month (1-12)  — defaults to current month
 *   year  (4-dig) — defaults to current year
 */
async function getDataCompletionStats(req, res) {
  try {
    const { clientId } = req.params;

    // Build reference date from query params or default to now
    const now   = new Date();
    const month = parseInt(req.query.month, 10) || (now.getMonth() + 1);
    const year  = parseInt(req.query.year,  10) || now.getFullYear();
    const referenceDate = new Date(year, month - 1, 1);

    // ── Resolve access options from context set by middleware ──────────────
    const accessCtx = req.dataEntryAccessContext;

    let filterOptions = {};  // empty = full access

    if (accessCtx && !accessCtx.isFullAccess) {
      const { role, allowedNodeIds, allowedScopeIdentifiers } = accessCtx;

      if (role === 'client_employee_head') {
        // Fail-closed: employee_head with no assigned nodes → return empty
        if (!allowedNodeIds || allowedNodeIds.size === 0) {
          return res.status(200).json({
            success: true,
            message: 'Data completion stats fetched successfully',
            data:    _buildEmptyStats(clientId, referenceDate),
          });
        }
        filterOptions = { allowedNodeIds };

      } else if (role === 'employee') {
        // Fail-closed: employee with no assigned scopes → return empty
        if (!allowedScopeIdentifiers || allowedScopeIdentifiers.size === 0) {
          return res.status(200).json({
            success: true,
            message: 'Data completion stats fetched successfully',
            data:    _buildEmptyStats(clientId, referenceDate),
          });
        }
        filterOptions = { allowedScopeIdentifiers };
      }
      // For any other unrecognised restricted role → fail-closed
      else if (!accessCtx.isFullAccess) {
        return res.status(200).json({
          success: true,
          message: 'Data completion stats fetched successfully',
          data:    _buildEmptyStats(clientId, referenceDate),
        });
      }
    }

    const stats = await calculateDataCompletionStatsForClient(
      clientId,
      referenceDate,
      filterOptions
    );

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

// ─── Private helpers ──────────────────────────────────────────────────────────

function _buildEmptyStats(clientId, referenceDate) {
  const { month, year } = getPeriodFromDate(referenceDate);
  const periodStart = new Date(year, month - 1, 1);
  return {
    clientId,
    period: {
      month,
      year,
      label:     periodStart.toLocaleString('default', { month: 'long' }) + ' ' + year,
      startDate: periodStart.toISOString(),
      endDate:   new Date(year, month, 0).toISOString(),
    },
    summary: {
      totalScopes:          0,
      completedScopes:      0,
      pendingScopes:        0,
      completionPercentage: 0,
      isFiltered:           true,
    },
    byScopeType: {},
    byNode:      [],
    scopes:      [],
  };
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
