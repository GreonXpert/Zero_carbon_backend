// controllers/transportFlowController.js
const { v4: uuidv4 } = require('uuid');
const TransportFlowchart = require('../../models/Organization/TransportFlowchart');
const Flowchart = require('../../models/Organization/Flowchart');
const ProcessFlowchart = require('../../models/Organization/ProcessFlowchart');
const { getNormalizedAssessmentLevels } = require('../../utils/DataCollection/dataCollection');
const { canManageFlowchart, canViewFlowchart } = require('../../utils/Permissions/permissions');
const { normalizeEdges } = require('../../utils/chart/chartHelpers');

/**
 * Internal helper: extract upstream / downstream transportation scopes
 * from a given chart.
 *
 * @param {Object} chart     Flowchart or ProcessFlowchart document (lean)
 * @param {String} chartType 'flowchart' | 'processflowchart'
 * @returns {Array} transport nodes ready for TransportFlowchart.nodes
 */
function extractTransportNodesFromChart(chart, chartType) {
  if (!chart || !Array.isArray(chart.nodes)) return [];

  const nodes = [];

  for (const node of chart.nodes) {
    const details = node.details || {};
    const scopes = Array.isArray(details.scopeDetails) ? details.scopeDetails : [];

    for (const scope of scopes) {
      if (!scope || !scope.scopeIdentifier) continue;

      const categoryRaw = String(scope.categoryName || '').toLowerCase();
      if (!categoryRaw) continue;

      // We treat anything that has both "upstream" + "transport" as upstream transportation
      // and anything that has both "downstream" + "transport" as downstream transportation.
      const isUpstream = categoryRaw.includes('upstream') && categoryRaw.includes('transport');
      const isDownstream = categoryRaw.includes('downstream') && categoryRaw.includes('transport');

      if (!isUpstream && !isDownstream) continue;

      const direction = isUpstream ? 'upstream' : 'downstream';

      nodes.push({
        id: uuidv4(),
        label: scope.scopeIdentifier || `${direction} transport - ${node.label}`,
        position: { x: 0, y: 0 }, // Frontend can reposition

        direction,
        source: {
          chartType,
          nodeId: node.id,
          scopeIdentifier: scope.scopeIdentifier
        },
        details: {
          categoryName: scope.categoryName || '',
          activity:     scope.activity     || '',
          scopeType:    scope.scopeType    || '',
          nodeLabel:    node.label         || '',
          department:   details.department || '',
          location:     details.location   || ''
        }
      });
    }
  }

  return nodes;
}

/**
 * Helper to normalize incoming nodes body into TransportNodeSchema-compatible objects.
 */
function normalizeTransportNodes(rawNodes = []) {
  if (!Array.isArray(rawNodes)) return [];

  return rawNodes
    .map((n) => ({
      id: n.id || uuidv4(),
      label: n.label || 'Transport node',
      position: {
        x: (n.position && typeof n.position.x === 'number') ? n.position.x : 0,
        y: (n.position && typeof n.position.y === 'number') ? n.position.y : 0
      },
      direction: n.direction === 'downstream' ? 'downstream' : 'upstream',
      source: {
        chartType: n.source?.chartType || 'flowchart',
        nodeId: n.source?.nodeId || '',
        scopeIdentifier: n.source?.scopeIdentifier || ''
      },
      details: {
        categoryName: n.details?.categoryName || '',
        activity:     n.details?.activity     || '',
        scopeType:    n.details?.scopeType    || '',
        nodeLabel:    n.details?.nodeLabel    || '',
        department:   n.details?.department   || '',
        location:     n.details?.location     || ''
      }
    }))
    .filter(n => n.source.nodeId && n.source.scopeIdentifier);
}

/**
 * GET /api/transport-flowchart/:clientId/template
 *
 * Build a *virtual* transport chart based on the client's
 * Flowchart / ProcessFlowchart, filtered for upstream / downstream transportation.
 *
 * You can pass optional query:
 *   ?direction=upstream
 *   ?direction=downstream
 *   (or ?transportType=upstream / downstream)
 *
 * - If direction is given -> returns only that side, in `nodes`
 * - If no direction -> returns both `upstream` and `downstream` arrays
 */
exports.getTransportTemplate = async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!clientId) {
      return res.status(400).json({ message: 'clientId is required' });
    }

    // upstream / downstream / both (default)
    const dirParam = String(req.query.direction || req.query.transportType || '')
      .trim()
      .toLowerCase();

    let templateType = 'both';
    if (dirParam === 'upstream') templateType = 'upstream';
    else if (dirParam === 'downstream') templateType = 'downstream';

    // Basic permission: can user view this client's flowchart?
    const viewPerm = await canViewFlowchart(req.user, clientId);
    if (!viewPerm?.allowed) {
      return res.status(403).json({ message: 'You do not have permission to view this client' });
    }

    const levels = await getNormalizedAssessmentLevels(clientId);
    const needOrg = levels.includes('organization');
    const needProc = levels.includes('process');

    if (!needOrg && !needProc) {
      return res.status(400).json({
        message: 'Transport chart is only available when assessmentLevel includes organization and/or process',
        assessmentLevels: levels
      });
    }

    const [orgChart, procChart] = await Promise.all([
      needOrg ? Flowchart.findOne({ clientId, isActive: true }).lean() : null,
      needProc ? ProcessFlowchart.findOne({ clientId, isDeleted: { $ne: true }, isActive: true }).lean() : null
    ]);

    if (!orgChart && !procChart) {
      return res.status(404).json({ message: 'No Flowchart or ProcessFlowchart found for this client' });
    }

    let transportNodes = [];
    if (orgChart) {
      transportNodes = transportNodes.concat(
        extractTransportNodesFromChart(orgChart, 'flowchart')
      );
    }
    if (procChart) {
      transportNodes = transportNodes.concat(
        extractTransportNodesFromChart(procChart, 'processflowchart')
      );
    }

    const upstreamNodes = transportNodes.filter(n => n.direction === 'upstream');
    const downstreamNodes = transportNodes.filter(n => n.direction === 'downstream');

    // If user asked only for upstream / downstream -> return only that as `nodes`
    if (templateType === 'upstream') {
      return res.status(200).json({
        clientId,
        assessmentLevels: levels,
        transportType: 'upstream',
        totalTransportNodes: upstreamNodes.length,
        nodes: upstreamNodes
      });
    }

    if (templateType === 'downstream') {
      return res.status(200).json({
        clientId,
        assessmentLevels: levels,
        transportType: 'downstream',
        totalTransportNodes: downstreamNodes.length,
        nodes: downstreamNodes
      });
    }

    // Default (no direction param): return both arrays (your old JSON structure)
    return res.status(200).json({
      clientId,
      assessmentLevels: levels,
      transportType: 'both',
      totalTransportNodes: transportNodes.length,
      upstream: upstreamNodes,
      downstream: downstreamNodes
    });
  } catch (err) {
    console.error('Error building transport template:', err);
    return res.status(500).json({ message: 'Failed to build transport template', error: err.message });
  }
};

/**
 * POST /api/transport-flowchart/save
 *
 * Create or update TransportFlowchart for a client.
 * Body:
 * {
 *   "clientId": "Greon180",
 *   "transportType": "upstream" | "downstream" | "both",   // REQUIRED for your 2 charts
 *   "chartData": { "nodes": [...], "edges": [...] }
 * }
 *
 * For "upstream" chart we auto-filter nodes to direction="upstream".
 * For "downstream" chart we auto-filter nodes to direction="downstream".
 */
exports.saveTransportFlowchart = async (req, res) => {
  try {
    const { clientId, chartData } = req.body;
    let { transportType } = req.body;

    if (!clientId) {
      return res.status(400).json({ message: 'clientId is required' });
    }

    if (!chartData || !Array.isArray(chartData.nodes)) {
      return res.status(400).json({ message: 'chartData.nodes is required' });
    }

    // Normalize transportType
    const rawType = String(transportType || '').trim().toLowerCase();
    if (rawType === 'upstream') transportType = 'upstream';
    else if (rawType === 'downstream') transportType = 'downstream';
    else transportType = 'both'; // default / combined case

    const userType = req.user.userType;

    // Roles that can edit transport charts
    const editRoles = ['super_admin', 'consultant_admin', 'consultant', 'client_admin'];
    if (!editRoles.includes(userType)) {
      return res.status(403).json({ message: 'You do not have permission to modify transport flowcharts' });
    }

    // Reuse existing flowchart permission logic for consultants/admins
    if (['super_admin', 'consultant_admin', 'consultant'].includes(userType)) {
      const managePerm = await canManageFlowchart(req.user, clientId);
      if (!managePerm?.allowed) {
        return res.status(403).json({ message: 'You are not allowed to manage this client' });
      }
    }

    // Client admin can edit only their own client
    if (userType === 'client_admin') {
      const userClientId = req.user.clientId || req.user.client_id;
      if (!userClientId || String(userClientId) !== String(clientId)) {
        return res.status(403).json({ message: 'Client admin can edit only their own client' });
      }
    }

    const levels = await getNormalizedAssessmentLevels(clientId);

    // Normalize nodes & edges
    let normalizedNodes = normalizeTransportNodes(chartData.nodes);
    const normalizedEdges = normalizeEdges(chartData.edges || []);

    // Filter nodes by chart type (upstream / downstream) for safety
    if (transportType === 'upstream') {
      normalizedNodes = normalizedNodes.filter(n => n.direction === 'upstream');
    } else if (transportType === 'downstream') {
      normalizedNodes = normalizedNodes.filter(n => n.direction === 'downstream');
    }

    if (!normalizedNodes.length) {
      return res.status(400).json({
        message: `No ${transportType} transport nodes provided to save`
      });
    }

    // Find existing chart for this client + transportType
    const existing = await TransportFlowchart.findOne({
      clientId,
      transportType,
      isActive: true
    });

    const userId = (req.user._id || req.user.id || '').toString();

    let saved;
    if (existing) {
      existing.nodes = normalizedNodes;
      existing.edges = normalizedEdges;
      existing.version = (existing.version || 1) + 1;
      existing.lastModifiedBy = userId;
      existing.assessmentLevels = levels;
      saved = await existing.save();
    } else {
      saved = await TransportFlowchart.create({
        clientId,
        transportType,
        nodes: normalizedNodes,
        edges: normalizedEdges,
        createdBy: userId,
        creatorType: userType,
        lastModifiedBy: userId,
        assessmentLevels: levels
      });
    }

    return res.status(200).json({
      message: existing
        ? `Transport flowchart (${transportType}) updated successfully`
        : `Transport flowchart (${transportType}) created successfully`,
      transportFlowchart: saved
    });
  } catch (err) {
    console.error('Error saving transport flowchart:', err);
    return res.status(500).json({ message: 'Failed to save transport flowchart', error: err.message });
  }
};

/**
 * GET /api/transport-flowchart/:clientId
 *
 * Optional query: ?transportType=upstream | downstream | both
 * If not passed, returns the "both" chart or any active chart for that client.
 */
exports.getTransportFlowchart = async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!clientId) {
      return res.status(400).json({ message: 'clientId is required' });
    }

    const typeParam = String(req.query.transportType || '')
      .trim()
      .toLowerCase();

    let filterType;
    if (['upstream', 'downstream', 'both'].includes(typeParam)) {
      filterType = typeParam;
    }

    const viewPerm = await canViewFlowchart(req.user, clientId);
    if (!viewPerm?.allowed) {
      return res.status(403).json({ message: 'You do not have permission to view this client' });
    }

    const query = { clientId, isActive: true };
    if (filterType) {
      query.transportType = filterType;
    }

    const chart = await TransportFlowchart.findOne(query)
      .populate('createdBy', 'userName email')
      .populate('lastModifiedBy', 'userName email');

    if (!chart) {
      return res.status(404).json({ message: 'No transport flowchart found for this client' });
    }

    return res.status(200).json(chart);
  } catch (err) {
    console.error('Error fetching transport flowchart:', err);
    return res.status(500).json({ message: 'Failed to fetch transport flowchart', error: err.message });
  }
};

/**
 * DELETE /api/transport-flowchart/:clientId
 *
 * Soft-delete transport chart by marking isActive=false
 * Optional query: ?transportType=upstream | downstream | both
 */
exports.deleteTransportFlowchart = async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!clientId) {
      return res.status(400).json({ message: 'clientId is required' });
    }

    const typeParam = String(req.query.transportType || '')
      .trim()
      .toLowerCase();

    let filterType;
    if (['upstream', 'downstream', 'both'].includes(typeParam)) {
      filterType = typeParam;
    }

    const userType = req.user.userType;
    const editRoles = ['super_admin', 'consultant_admin', 'consultant', 'client_admin'];
    if (!editRoles.includes(userType)) {
      return res.status(403).json({ message: 'You do not have permission to delete transport flowcharts' });
    }

    if (['super_admin', 'consultant_admin', 'consultant'].includes(userType)) {
      const managePerm = await canManageFlowchart(req.user, clientId);
      if (!managePerm?.allowed) {
        return res.status(403).json({ message: 'You are not allowed to manage this client' });
      }
    }

    if (userType === 'client_admin') {
      const userClientId = req.user.clientId || req.user.client_id;
      if (!userClientId || String(userClientId) !== String(clientId)) {
        return res.status(403).json({ message: 'Client admin can delete only their own client' });
      }
    }

    const query = { clientId, isActive: true };
    if (filterType) {
      query.transportType = filterType;
    }

    const existing = await TransportFlowchart.findOne(query);
    if (!existing) {
      return res.status(404).json({ message: 'No active transport flowchart found for this client' });
    }

    existing.isActive = false;
    existing.lastModifiedBy = (req.user._id || req.user.id || '').toString();
    await existing.save();

    return res.status(200).json({
      message: `Transport flowchart (${existing.transportType}) deleted successfully`
    });
  } catch (err) {
    console.error('Error deleting transport flowchart:', err);
    return res.status(500).json({ message: 'Failed to delete transport flowchart', error: err.message });
  }
};

/**
 * PATCH /api/transport-flowchart/:clientId/restore
 *
 * Restore the latest inactive transport chart as active.
 * Optional query: ?transportType=upstream | downstream | both
 */
exports.restoreTransportFlowchart = async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!clientId) {
      return res.status(400).json({ message: 'clientId is required' });
    }

    const typeParam = String(req.query.transportType || '')
      .trim()
      .toLowerCase();

    let filterType;
    if (['upstream', 'downstream', 'both'].includes(typeParam)) {
      filterType = typeParam;
    }

    const userType = req.user.userType;
    const editRoles = ['super_admin', 'consultant_admin', 'consultant', 'client_admin'];
    if (!editRoles.includes(userType)) {
      return res.status(403).json({ message: 'You do not have permission to restore transport flowcharts' });
    }

    if (['super_admin', 'consultant_admin', 'consultant'].includes(userType)) {
      const managePerm = await canManageFlowchart(req.user, clientId);
      if (!managePerm?.allowed) {
        return res.status(403).json({ message: 'You are not allowed to manage this client' });
      }
    }

    if (userType === 'client_admin') {
      const userClientId = req.user.clientId || req.user.client_id;
      if (!userClientId || String(userClientId) !== String(clientId)) {
        return res.status(403).json({ message: 'Client admin can restore only their own client' });
      }
    }

    const query = { clientId, isActive: false };
    if (filterType) {
      query.transportType = filterType;
    }

    // Find the most recently updated inactive chart for this client (+ type if given)
    const latestInactive = await TransportFlowchart.findOne(query)
      .sort({ updatedAt: -1 });

    if (!latestInactive) {
      return res.status(404).json({ message: 'No inactive transport flowchart found to restore' });
    }

    latestInactive.isActive = true;
    latestInactive.lastModifiedBy = (req.user._id || req.user.id || '').toString();
    latestInactive.version = (latestInactive.version || 1) + 1;
    await latestInactive.save();

    return res.status(200).json({
      message: `Transport flowchart (${latestInactive.transportType}) restored successfully`
    });
  } catch (err) {
    console.error('Error restoring transport flowchart:', err);
    return res.status(500).json({ message: 'Failed to restore transport flowchart', error: err.message });
  }
};



/**
 * DELETE /api/transport-flowchart/:clientId/hard-delete
 *
 * HARD DELETE from MongoDB (no isActive flag) – ONLY super_admin
 * Optional query: ?transportType=upstream | downstream | both
 *  - If transportType is passed → delete only that type
 *  - If not passed → delete ALL transport flowcharts for that client
 */
exports.hardDeleteTransportFlowchart = async (req, res) => {
  try {
    const { clientId } = req.params;

    if (!clientId) {
      return res.status(400).json({ message: 'clientId is required' });
    }

    // Only super_admin can hard delete
    if (!req.user || req.user.userType !== 'super_admin') {
      return res.status(403).json({
        message: 'Only super_admin is allowed to hard delete transport flowcharts'
      });
    }

    const typeParam = String(req.query.transportType || '')
      .trim()
      .toLowerCase();

    const filter = { clientId };

    if (['upstream', 'downstream', 'both'].includes(typeParam)) {
      filter.transportType = typeParam;
    }

    const result = await TransportFlowchart.deleteMany(filter);

    if (!result.deletedCount) {
      return res.status(404).json({
        message: 'No transport flowcharts found to hard delete for this client and filter'
      });
    }

    return res.status(200).json({
      message: 'Transport flowcharts hard deleted successfully',
      deletedCount: result.deletedCount
    });
  } catch (err) {
    console.error('Error hard deleting transport flowchart:', err);
    return res.status(500).json({
      message: 'Failed to hard delete transport flowchart',
      error: err.message
    });
  }
};


