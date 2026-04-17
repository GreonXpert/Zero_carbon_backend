'use strict';
/**
 * boundaryController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles ESGLink Core boundary CRUD:
 *   - importBoundaryFromZeroCarbon  — auto-import from ZeroCarbon org flowchart
 *   - createBoundaryManually        — manual node/edge setup
 *   - getBoundary                   — fetch current boundary
 *   - updateBoundaryNode            — edit a single node
 *   - addNodeToBoundary             — append node(s)
 *   - addEdgeToBoundary             — append edge(s)
 *   - removeNodeFromBoundary        — remove a node (and its edges)
 *   - deleteBoundary                — soft-delete entire boundary
 *   - checkBoundaryImportAvailability — check if ZeroCarbon import is possible
 *   - assignMetricToNode            — Step 3: map metric library entry to a node
 */

const EsgLinkBoundary = require('../models/EsgLinkBoundary');
const EsgMetric = require('../models/EsgMetric');
const EsgMetricNodeMapping = require('../models/EsgMetricNodeMapping');
const User = require('../../../../common/models/User');
const Client = require('../../../../modules/client-management/client/Client');
const { canManageBoundary, canViewBoundary } = require('../utils/boundaryPermissions');
const {
  checkZeroCarbonOrgAvailability,
  extractBoundaryFromFlowchart
} = require('../services/boundaryService');

// ─────────────────────────────────────────────────────────────────────────────
// Helper: permission gate with proper 404 / 403 distinction
// canManageFlowchart returns { allowed: false, reason: 'Client not found' }
// when the clientId doesn't exist in the DB. We surface that as 404 so the
// caller knows the problem is the clientId, not their access rights.
// ─────────────────────────────────────────────────────────────────────────────
const _guardPermission = (perm, res) => {
  if (perm.allowed) return false; // no error — caller should continue
  if (perm.reason === 'Client not found') {
    res.status(404).json({ message: 'Client not found', code: 'CLIENT_NOT_FOUND' });
  } else {
    res.status(403).json({ message: 'Permission denied', reason: perm.reason });
  }
  return true; // error was sent — caller should return
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. importBoundaryFromZeroCarbon
//    POST /api/esglink/core/:clientId/boundary/import-from-zero-carbon
// ─────────────────────────────────────────────────────────────────────────────
const importBoundaryFromZeroCarbon = async (req, res) => {
  try {
    const { clientId } = req.params;

    // 1) Permission check
    const perm = await canManageBoundary(req.user, clientId);
    if (_guardPermission(perm, res)) return;

    // 2) Check client has ESGLink module access
    const client = await Client.findOne({ clientId }, { accessibleModules: 1 }).lean();
    if (!client) return res.status(404).json({ message: 'Client not found' });

    const hasEsgLink = (client.accessibleModules || []).includes('esg_link');
    if (!hasEsgLink) {
      return res.status(400).json({
        message: 'Client does not have the esg_link module',
        code: 'NO_ESG_LINK_MODULE'
      });
    }

    // 3) Check ZeroCarbon org availability
    const availability = await checkZeroCarbonOrgAvailability(clientId);
    if (!availability.available) {
      return res.status(400).json({
        message: availability.reason,
        code: availability.code,
        ...(availability.assessmentLevel && { assessmentLevel: availability.assessmentLevel })
      });
    }

    // 4) Check if a boundary already exists — prevent duplicate import
    const existing = await EsgLinkBoundary.findOne({ clientId, isActive: true, isDeleted: false });
    if (existing) {
      return res.status(409).json({
        message: 'An active boundary already exists for this client. Delete or update the existing boundary.',
        code: 'BOUNDARY_ALREADY_EXISTS',
        boundaryId: existing._id
      });
    }

    // 5) Extract boundary data from ZeroCarbon flowchart
    const extracted = await extractBoundaryFromFlowchart(clientId);
    if (!extracted) {
      return res.status(404).json({
        message: 'Failed to extract flowchart data',
        code: 'EXTRACTION_FAILED'
      });
    }

    // 6) Create and save boundary
    const boundary = new EsgLinkBoundary({
      clientId,
      setupMethod:              'imported_from_zero_carbon',
      importedFromFlowchartId:  extracted.sourceChartId,
      importedFromChartVersion: extracted.chartVersion,
      nodes:                    extracted.nodes,
      edges:                    extracted.edges,
      version:                  1,
      isActive:                 true,
      createdBy:                req.user._id,
      lastModifiedBy:           req.user._id
    });

    await boundary.save();

    return res.status(201).json({
      success: true,
      message: `Boundary imported from ZeroCarbon organisational flowchart (v${extracted.chartVersion})`,
      data: {
        boundaryId:  boundary._id,
        clientId,
        setupMethod: boundary.setupMethod,
        nodeCount:   boundary.nodes.length,
        edgeCount:   boundary.edges.length,
        version:     boundary.version,
        importedFrom: {
          flowchartId:  extracted.sourceChartId,
          chartVersion: extracted.chartVersion
        }
      }
    });

  } catch (error) {
    console.error('importBoundaryFromZeroCarbon error:', error);
    return res.status(500).json({ message: 'Server error importing boundary', error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. createBoundaryManually
//    POST /api/esglink/core/:clientId/boundary
// ─────────────────────────────────────────────────────────────────────────────
const createBoundaryManually = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { nodes = [], edges = [] } = req.body;

    // 1) Permission check
    const perm = await canManageBoundary(req.user, clientId);
    if (_guardPermission(perm, res)) return;

    // 2) Check client has ESGLink module
    const client = await Client.findOne({ clientId }, { accessibleModules: 1 }).lean();
    if (!client) return res.status(404).json({ message: 'Client not found' });

    const hasEsgLink = (client.accessibleModules || []).includes('esg_link');
    if (!hasEsgLink) {
      return res.status(400).json({ message: 'Client does not have the esg_link module', code: 'NO_ESG_LINK_MODULE' });
    }

    // 3) Check no active boundary already exists
    const existing = await EsgLinkBoundary.findOne({ clientId, isActive: true, isDeleted: false });
    if (existing) {
      return res.status(409).json({
        message: 'An active boundary already exists for this client.',
        code: 'BOUNDARY_ALREADY_EXISTS',
        boundaryId: existing._id
      });
    }

    // 4) Basic validation
    if (!Array.isArray(nodes)) {
      return res.status(400).json({ message: 'nodes must be an array' });
    }

    const nodeErrors = [];
    nodes.forEach((n, i) => {
      if (!n.id)    nodeErrors.push(`nodes[${i}]: id is required`);
      if (!n.label) nodeErrors.push(`nodes[${i}]: label is required`);
    });
    if (nodeErrors.length) {
      return res.status(400).json({ message: 'Invalid node data', errors: nodeErrors });
    }

    // Validate edges reference valid nodes
    const nodeIds = new Set(nodes.map(n => n.id));
    const edgeErrors = [];
    (edges || []).forEach((e, i) => {
      if (!e.id)     edgeErrors.push(`edges[${i}]: id is required`);
      if (!e.source) edgeErrors.push(`edges[${i}]: source is required`);
      if (!e.target) edgeErrors.push(`edges[${i}]: target is required`);
      if (e.source && !nodeIds.has(e.source)) edgeErrors.push(`edges[${i}]: source "${e.source}" does not match any node id`);
      if (e.target && !nodeIds.has(e.target)) edgeErrors.push(`edges[${i}]: target "${e.target}" does not match any node id`);
    });
    if (edgeErrors.length) {
      return res.status(400).json({ message: 'Invalid edge data', errors: edgeErrors });
    }

    // 5) Create boundary
    const boundary = new EsgLinkBoundary({
      clientId,
      setupMethod: 'manual',
      nodes: nodes.map(n => ({
        id:       n.id,
        label:    n.label,
        type:     n.type || 'entity',
        position: n.position || { x: 0, y: 0 },
        details: {
          name:       n.details?.name       || n.label,
          department: n.details?.department || '',
          location:   n.details?.location   || '',
          entityType: n.details?.entityType || '',
          notes:      n.details?.notes      || ''
        }
      })),
      edges: (edges || []).map(e => ({
        id:     e.id,
        source: e.source,
        target: e.target,
        label:  e.label || ''
      })),
      version:        1,
      isActive:       true,
      createdBy:      req.user._id,
      lastModifiedBy: req.user._id
    });

    await boundary.save();

    return res.status(201).json({
      success: true,
      message: 'ESGLink Core boundary created manually',
      data: {
        boundaryId:  boundary._id,
        clientId,
        setupMethod: 'manual',
        nodeCount:   boundary.nodes.length,
        edgeCount:   boundary.edges.length,
        version:     boundary.version
      }
    });

  } catch (error) {
    console.error('createBoundaryManually error:', error);
    return res.status(500).json({ message: 'Server error creating boundary', error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. getBoundary
//    GET /api/esglink/core/:clientId/boundary
// ─────────────────────────────────────────────────────────────────────────────
const getBoundary = async (req, res) => {
  try {
    const { clientId } = req.params;

    // 1) Permission check
    const perm = await canViewBoundary(req.user, clientId);
    if (_guardPermission(perm, res)) return;

    // 2) Find active boundary
    const boundary = await EsgLinkBoundary.findOne({ clientId, isActive: true, isDeleted: false })
      .populate('createdBy', 'userName email userType')
      .populate('lastModifiedBy', 'userName email');

    if (!boundary) {
      return res.status(404).json({
        message: 'No active boundary found for this client',
        code: 'BOUNDARY_NOT_FOUND'
      });
    }

    return res.status(200).json({
      success: true,
      data: boundary
    });

  } catch (error) {
    console.error('getBoundary error:', error);
    return res.status(500).json({ message: 'Server error fetching boundary', error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. updateBoundaryNode
//    PATCH /api/esglink/core/:clientId/boundary/nodes/:nodeId
// ─────────────────────────────────────────────────────────────────────────────
const updateBoundaryNode = async (req, res) => {
  try {
    const { clientId, nodeId } = req.params;
    const updates = req.body;

    // 1) Permission check
    const perm = await canManageBoundary(req.user, clientId);
    if (_guardPermission(perm, res)) return;

    // 2) Find boundary
    const boundary = await EsgLinkBoundary.findOne({ clientId, isActive: true, isDeleted: false });
    if (!boundary) return res.status(404).json({ message: 'Boundary not found', code: 'BOUNDARY_NOT_FOUND' });

    // 3) Find node
    const nodeIndex = boundary.nodes.findIndex(n => n.id === nodeId);
    if (nodeIndex === -1) {
      return res.status(404).json({ message: `Node "${nodeId}" not found in boundary` });
    }

    // 4) Apply allowed updates (label, type, position, details)
    const node = boundary.nodes[nodeIndex];
    if (updates.label)    node.label    = updates.label;
    if (updates.type)     node.type     = updates.type;
    if (updates.position) node.position = { ...node.position, ...updates.position };
    if (updates.details)  node.details  = { ...node.details,  ...updates.details  };
    node.updatedAt = new Date();

    // 5) Bump version and save
    boundary.version        = (boundary.version || 1) + 1;
    boundary.lastModifiedBy = req.user._id;
    boundary.markModified('nodes');

    await boundary.save();

    return res.status(200).json({
      success: true,
      message: `Node "${nodeId}" updated`,
      data: {
        boundaryId: boundary._id,
        version:    boundary.version,
        node:       boundary.nodes[nodeIndex]
      }
    });

  } catch (error) {
    console.error('updateBoundaryNode error:', error);
    return res.status(500).json({ message: 'Server error updating node', error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. addNodeToBoundary
//    POST /api/esglink/core/:clientId/boundary/nodes
// ─────────────────────────────────────────────────────────────────────────────
const addNodeToBoundary = async (req, res) => {
  try {
    const { clientId } = req.params;
    // Accept single node object or array of nodes
    const rawNodes = Array.isArray(req.body.nodes) ? req.body.nodes
                   : req.body.node                  ? [req.body.node]
                   : [];

    if (rawNodes.length === 0) {
      return res.status(400).json({ message: 'Provide "node" (object) or "nodes" (array) in request body' });
    }

    // 1) Permission check
    const perm = await canManageBoundary(req.user, clientId);
    if (_guardPermission(perm, res)) return;

    // 2) Find boundary
    const boundary = await EsgLinkBoundary.findOne({ clientId, isActive: true, isDeleted: false });
    if (!boundary) return res.status(404).json({ message: 'Boundary not found', code: 'BOUNDARY_NOT_FOUND' });

    // 3) Validate + deduplicate
    const existingIds = new Set(boundary.nodes.map(n => n.id));
    const errors = [];
    const validNodes = [];

    rawNodes.forEach((n, i) => {
      const pfx = rawNodes.length > 1 ? `nodes[${i}]: ` : '';
      if (!n.id)            { errors.push(`${pfx}id is required`); return; }
      if (!n.label)         { errors.push(`${pfx}label is required`); return; }
      if (existingIds.has(n.id)) { errors.push(`${pfx}node id "${n.id}" already exists in boundary`); return; }
      existingIds.add(n.id);
      validNodes.push({
        id:       n.id,
        label:    n.label,
        type:     n.type || 'entity',
        position: n.position || { x: 0, y: 0 },
        details: {
          name:       n.details?.name       || n.label,
          department: n.details?.department || '',
          location:   n.details?.location   || '',
          entityType: n.details?.entityType || '',
          notes:      n.details?.notes      || ''
        }
      });
    });

    if (errors.length) return res.status(400).json({ message: 'Node validation failed', errors });

    boundary.nodes.push(...validNodes);
    boundary.version        = (boundary.version || 1) + 1;
    boundary.lastModifiedBy = req.user._id;
    boundary.markModified('nodes');

    await boundary.save();

    return res.status(201).json({
      success: true,
      message: `${validNodes.length} node(s) added to boundary`,
      data: {
        boundaryId: boundary._id,
        version:    boundary.version,
        addedNodes: validNodes
      }
    });

  } catch (error) {
    console.error('addNodeToBoundary error:', error);
    return res.status(500).json({ message: 'Server error adding node', error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 5b. appendNodeToBoundary
//     PATCH /api/esglink/core/:clientId/boundary/nodes
//     Safe append — never touches existing node IDs or their metricsDetails.
//     Returns 200 (not 201) since it partially updates an existing boundary.
// ─────────────────────────────────────────────────────────────────────────────
const appendNodeToBoundary = async (req, res) => {
  try {
    const { clientId } = req.params;

    // Accept single node object or array
    const rawNodes = Array.isArray(req.body.nodes) ? req.body.nodes
                   : req.body.node                  ? [req.body.node]
                   : [];

    if (rawNodes.length === 0) {
      return res.status(400).json({ message: 'Provide "node" (object) or "nodes" (array) in request body' });
    }

    const perm = await canManageBoundary(req.user, clientId);
    if (_guardPermission(perm, res)) return;

    const boundary = await EsgLinkBoundary.findOne({ clientId, isActive: true, isDeleted: false });
    if (!boundary) return res.status(404).json({ message: 'Boundary not found', code: 'BOUNDARY_NOT_FOUND' });

    // Validate and check for duplicate IDs against existing nodes
    const existingIds = new Set(boundary.nodes.map(n => n.id));
    const errors      = [];
    const validNodes  = [];

    rawNodes.forEach((n, i) => {
      const pfx = rawNodes.length > 1 ? `nodes[${i}]: ` : '';
      if (!n.id)    { errors.push(`${pfx}id is required`);    return; }
      if (!n.label) { errors.push(`${pfx}label is required`); return; }
      if (existingIds.has(n.id)) {
        errors.push(`${pfx}node id "${n.id}" already exists in boundary`);
        return;
      }
      existingIds.add(n.id);
      validNodes.push({
        id:       n.id,
        label:    n.label,
        type:     n.type || 'entity',
        position: n.position || { x: 0, y: 0 },
        details: {
          name:       n.details?.name       || n.label,
          department: n.details?.department || '',
          location:   n.details?.location   || '',
          entityType: n.details?.entityType || '',
          notes:      n.details?.notes      || '',
        },
        metricsDetails: [],
      });
    });

    if (errors.length) return res.status(400).json({ message: 'Node validation failed', errors });

    boundary.nodes.push(...validNodes);
    boundary.version        = (boundary.version || 1) + 1;
    boundary.lastModifiedBy = req.user._id;
    boundary.markModified('nodes');
    await boundary.save();

    return res.status(200).json({
      success: true,
      message: `${validNodes.length} node(s) appended to boundary`,
      data: {
        boundaryId:  boundary._id,
        version:     boundary.version,
        addedNodes:  validNodes.map(n => ({
          id:       n.id,
          label:    n.label,
          type:     n.type,
          position: n.position,
          details:  n.details,
        })),
      },
    });

  } catch (error) {
    console.error('appendNodeToBoundary error:', error);
    return res.status(500).json({ message: 'Server error appending node', error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. addEdgeToBoundary
//    POST /api/esglink/core/:clientId/boundary/edges
// ─────────────────────────────────────────────────────────────────────────────
const addEdgeToBoundary = async (req, res) => {
  try {
    const { clientId } = req.params;
    const rawEdges = Array.isArray(req.body.edges) ? req.body.edges
                   : req.body.edge                  ? [req.body.edge]
                   : [];

    if (rawEdges.length === 0) {
      return res.status(400).json({ message: 'Provide "edge" (object) or "edges" (array) in request body' });
    }

    // 1) Permission check
    const perm = await canManageBoundary(req.user, clientId);
    if (_guardPermission(perm, res)) return;

    // 2) Find boundary
    const boundary = await EsgLinkBoundary.findOne({ clientId, isActive: true, isDeleted: false });
    if (!boundary) return res.status(404).json({ message: 'Boundary not found', code: 'BOUNDARY_NOT_FOUND' });

    // 3) Validate edges
    const nodeIds    = new Set(boundary.nodes.map(n => n.id));
    const edgeIds    = new Set(boundary.edges.map(e => e.id));
    const errors     = [];
    const validEdges = [];

    rawEdges.forEach((e, i) => {
      const pfx = rawEdges.length > 1 ? `edges[${i}]: ` : '';
      if (!e.id)              { errors.push(`${pfx}id is required`); return; }
      if (!e.source)          { errors.push(`${pfx}source is required`); return; }
      if (!e.target)          { errors.push(`${pfx}target is required`); return; }
      if (edgeIds.has(e.id))  { errors.push(`${pfx}edge id "${e.id}" already exists`); return; }
      if (!nodeIds.has(e.source)) { errors.push(`${pfx}source node "${e.source}" not found in boundary`); return; }
      if (!nodeIds.has(e.target)) { errors.push(`${pfx}target node "${e.target}" not found in boundary`); return; }
      edgeIds.add(e.id);
      validEdges.push({ id: e.id, source: e.source, target: e.target, label: e.label || '' });
    });

    if (errors.length) return res.status(400).json({ message: 'Edge validation failed', errors });

    boundary.edges.push(...validEdges);
    boundary.version        = (boundary.version || 1) + 1;
    boundary.lastModifiedBy = req.user._id;
    boundary.markModified('edges');

    await boundary.save();

    return res.status(201).json({
      success: true,
      message: `${validEdges.length} edge(s) added to boundary`,
      data: { boundaryId: boundary._id, version: boundary.version, addedEdges: validEdges }
    });

  } catch (error) {
    console.error('addEdgeToBoundary error:', error);
    return res.status(500).json({ message: 'Server error adding edge', error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 7. removeNodeFromBoundary
//    DELETE /api/esglink/core/:clientId/boundary/nodes/:nodeId
// ─────────────────────────────────────────────────────────────────────────────
const removeNodeFromBoundary = async (req, res) => {
  try {
    const { clientId, nodeId } = req.params;

    // 1) Permission check
    const perm = await canManageBoundary(req.user, clientId);
    if (_guardPermission(perm, res)) return;

    // 2) Find boundary
    const boundary = await EsgLinkBoundary.findOne({ clientId, isActive: true, isDeleted: false });
    if (!boundary) return res.status(404).json({ message: 'Boundary not found', code: 'BOUNDARY_NOT_FOUND' });

    // 3) Find node
    const nodeExists = boundary.nodes.some(n => n.id === nodeId);
    if (!nodeExists) return res.status(404).json({ message: `Node "${nodeId}" not found in boundary` });

    // 4) Remove node AND any edges connected to it
    const removedEdges = boundary.edges.filter(e => e.source === nodeId || e.target === nodeId);
    boundary.nodes = boundary.nodes.filter(n => n.id !== nodeId);
    boundary.edges = boundary.edges.filter(e => e.source !== nodeId && e.target !== nodeId);

    boundary.version        = (boundary.version || 1) + 1;
    boundary.lastModifiedBy = req.user._id;
    boundary.markModified('nodes');
    boundary.markModified('edges');

    await boundary.save();

    return res.status(200).json({
      success: true,
      message: `Node "${nodeId}" removed from boundary`,
      data: {
        boundaryId:    boundary._id,
        version:       boundary.version,
        removedNodeId: nodeId,
        removedEdges:  removedEdges.map(e => e.id)
      }
    });

  } catch (error) {
    console.error('removeNodeFromBoundary error:', error);
    return res.status(500).json({ message: 'Server error removing node', error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 8. deleteBoundary
//    DELETE /api/esglink/core/:clientId/boundary
// ─────────────────────────────────────────────────────────────────────────────
const deleteBoundary = async (req, res) => {
  try {
    const { clientId } = req.params;

    // 1) Permission check — super_admin and consultant_admin only for deletion
    if (!['super_admin', 'consultant_admin'].includes(req.user.userType)) {
      return res.status(403).json({ message: 'Only super_admin or consultant_admin can delete a boundary' });
    }

    const perm = await canManageBoundary(req.user, clientId);
    if (_guardPermission(perm, res)) return;

    // 2) Soft-delete
    const boundary = await EsgLinkBoundary.findOne({ clientId, isActive: true, isDeleted: false });
    if (!boundary) return res.status(404).json({ message: 'No active boundary found', code: 'BOUNDARY_NOT_FOUND' });

    boundary.isActive  = false;
    boundary.isDeleted = true;
    boundary.deletedAt = new Date();
    boundary.deletedBy = req.user._id;

    await boundary.save();

    return res.status(200).json({
      success: true,
      message: 'ESGLink Core boundary soft-deleted',
      data: { boundaryId: boundary._id, deletedAt: boundary.deletedAt }
    });

  } catch (error) {
    console.error('deleteBoundary error:', error);
    return res.status(500).json({ message: 'Server error deleting boundary', error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 9. checkBoundaryImportAvailability
//    GET /api/esglink/core/:clientId/boundary/import-availability
// ─────────────────────────────────────────────────────────────────────────────
const checkBoundaryImportAvailability = async (req, res) => {
  try {
    const { clientId } = req.params;

    // 1) Permission check
    const perm = await canViewBoundary(req.user, clientId);
    if (_guardPermission(perm, res)) return;

    // 2) Check availability
    const availability = await checkZeroCarbonOrgAvailability(clientId);

    return res.status(200).json({
      success: true,
      data: {
        clientId,
        importAvailable: availability.available,
        ...(availability.available
          ? { flowchartId: availability.flowchartId, chartVersion: availability.chartVersion }
          : { reason: availability.reason, code: availability.code }
        )
      }
    });

  } catch (error) {
    console.error('checkBoundaryImportAvailability error:', error);
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 10. assignMetricToNode
//     POST /api/esglink/core/:clientId/boundary/nodes/:nodeId/metrics
// ─────────────────────────────────────────────────────────────────────────────
const assignMetricToNode = async (req, res) => {
  try {
    const { clientId, nodeId } = req.params;
    const {
      metricId,
      mappingStatus         = 'draft',
      frequency,
      boundaryScope         = '',
      rollUpBehavior        = 'sum',
      reportingLevelNote    = '',
      allowedSourceTypes    = ['manual'],
      defaultSourceType     = 'manual',
      zeroCarbonReference   = false,
      ingestionInstructions = '',
      validationRules       = [],
      evidenceRequirement   = 'optional',
      evidenceTypeNote      = '',
      contributors          = [],
      reviewers             = [],
      approvers             = [],
      inheritNodeReviewers  = false,
      inheritNodeApprovers  = false,
      approvalLevel         = 'single'
    } = req.body;

    // 1) Permission check
    const perm = await canManageBoundary(req.user, clientId);
    if (_guardPermission(perm, res)) return;

    // 2) Required fields
    if (!metricId) {
      return res.status(400).json({ message: 'metricId is required', code: 'MISSING_METRIC_ID' });
    }
    if (!frequency) {
      return res.status(400).json({ message: 'frequency is required', code: 'MISSING_FREQUENCY' });
    }

    // 3) Boundary must exist and contain the node
    const boundary = await EsgLinkBoundary.findOne({ clientId, isActive: true, isDeleted: false });
    if (!boundary) {
      return res.status(404).json({ message: 'No active boundary found for this client', code: 'BOUNDARY_NOT_FOUND' });
    }
    const targetNode = boundary.nodes.find(n => n.id === nodeId);
    if (!targetNode) {
      return res.status(404).json({ message: `Node "${nodeId}" not found in boundary`, code: 'NODE_NOT_FOUND' });
    }

    // 4) Metric must exist and be accessible to this client
    const metric = await EsgMetric.findOne({
      _id: metricId,
      isDeleted: false,
      $or: [{ isGlobal: true }, { clientId }]
    }).lean();
    if (!metric) {
      return res.status(404).json({ message: 'Metric not found or not accessible to this client', code: 'METRIC_NOT_FOUND' });
    }

    // 5) Duplicate mapping check
    const duplicate = await EsgMetricNodeMapping.findOne({
      clientId,
      boundaryNodeId: nodeId,
      metricId,
      isDeleted: false
    });
    if (duplicate) {
      return res.status(409).json({
        message: 'This metric is already mapped to this boundary node',
        code: 'DUPLICATE_MAPPING',
        mappingId: duplicate._id
      });
    }

    // 6) Validate assignees against their correct userTypes
    //    contributors → userType 'contributor'
    //    reviewers    → userType 'reviewer'
    //    approvers    → userType 'approver'
    if (contributors.length > 0) {
      const found = await User.find({
        _id: { $in: contributors },
        userType: 'contributor',
        clientId,
        isActive: true
      }).select('_id').lean();
      if (found.length !== contributors.length) {
        return res.status(400).json({
          message: 'One or more contributor IDs not found or not of type contributor for this client',
          code: 'INVALID_CONTRIBUTOR'
        });
      }
    }

    if (reviewers.length > 0) {
      const found = await User.find({
        _id: { $in: reviewers },
        userType: 'reviewer',
        clientId,
        isActive: true
      }).select('_id').lean();
      if (found.length !== reviewers.length) {
        return res.status(400).json({
          message: 'One or more reviewer IDs not found or not of type reviewer for this client',
          code: 'INVALID_REVIEWER'
        });
      }
    }

    if (approvers.length > 0) {
      const found = await User.find({
        _id: { $in: approvers },
        userType: 'approver',
        clientId,
        isActive: true
      }).select('_id').lean();
      if (found.length !== approvers.length) {
        return res.status(400).json({
          message: 'One or more approver IDs not found or not of type approver for this client',
          code: 'INVALID_APPROVER'
        });
      }
    }

    // 7) Create mapping
    const mapping = new EsgMetricNodeMapping({
      clientId,
      boundaryNodeId:       nodeId,
      boundaryDocId:        boundary._id,
      metricId,
      mappingStatus,
      frequency,
      boundaryScope,
      rollUpBehavior,
      reportingLevelNote,
      allowedSourceTypes,
      defaultSourceType,
      zeroCarbonReference,
      ingestionInstructions,
      validationRules,
      evidenceRequirement,
      evidenceTypeNote,
      contributors,
      reviewers,
      approvers,
      inheritNodeReviewers,
      inheritNodeApprovers,
      approvalLevel,
      createdBy: req.user._id
    });

    await mapping.save();

    return res.status(201).json({
      success: true,
      message: `Metric "${metric.metricName}" mapped to node "${targetNode.label}"`,
      data: mapping
    });

  } catch (error) {
    console.error('assignMetricToNode error:', error);
    return res.status(500).json({ message: 'Server error assigning metric to node', error: error.message });
  }
};

module.exports = {
  importBoundaryFromZeroCarbon,
  createBoundaryManually,
  getBoundary,
  updateBoundaryNode,
  addNodeToBoundary,
  appendNodeToBoundary,
  addEdgeToBoundary,
  removeNodeFromBoundary,
  deleteBoundary,
  checkBoundaryImportAvailability,
};
