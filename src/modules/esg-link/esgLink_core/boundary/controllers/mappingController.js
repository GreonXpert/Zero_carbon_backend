'use strict';
/**
 * mappingController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * ESGLink Core Step 3 — Metric Mapping handlers.
 *
 * Endpoints:
 *   1. POST   /:clientId/boundary/nodes/:nodeId/metrics          → addMetricToNode
 *   2. PATCH  /:clientId/boundary/nodes/:nodeId/metrics/:mappingId → updateMapping
 *   3. DELETE /:clientId/boundary/nodes/:nodeId/metrics/:mappingId → removeMapping
 *   4. PATCH  /:clientId/boundary/nodes/:nodeId/workflow-defaults  → updateWorkflowDefaults
 *   5. GET    /:clientId/my-assigned-metrics                      → getMyAssignedMetrics
 *   6. GET    /:clientId/nodes/:nodeId/metrics/:mappingId         → getMappingById
 */

const mongoose = require('mongoose');
const EsgLinkBoundary = require('../models/EsgLinkBoundary');
const EsgMetric       = require('../../metric/models/EsgMetric');
const Formula         = require('../../../../zero-carbon/reduction/models/Formula');
const UserModel       = require('../../../../../common/models/User');

const Notification = require('../../../../../common/models/Notification/Notification');

const {
  canManageMapping,
  canManageWorkflowDefaults,
  canViewAssignedMetrics,
} = require('../utils/mappingPermissions');

const {
  buildFormulaSnapshot,
  buildMappingEntry,
  hasMeaningfulChange,
  appendVersionHistory,
  resolveEffectiveReviewers,
  resolveEffectiveApprovers,
  validateAssignees,
} = require('../services/mappingService');

const { logEventFireAndForget } = require('../../../../../common/services/audit/auditLogService');

// ── Helpers ───────────────────────────────────────────────────────────────────

const _guardPermission = (perm, res) => {
  if (perm.allowed) return false;
  if (perm.reason === 'Client not found') {
    res.status(404).json({ message: 'Client not found', code: 'CLIENT_NOT_FOUND' });
  } else {
    res.status(403).json({ message: 'Permission denied', reason: perm.reason });
  }
  return true;
};

/** Find active boundary — shared across handlers */
const _getActiveBoundary = async (clientId) => {
  return EsgLinkBoundary.findOne({ clientId, isActive: true, isDeleted: false });
};

/** Find node within decrypted boundary */
const _findNode = (boundary, nodeId) => {
  return boundary.nodes.find(n => n.id === nodeId);
};

/** Find mapping within node */
const _findMapping = (node, mappingId) => {
  return (node.metricsDetails || []).find(m => String(m._id) === String(mappingId));
};

/**
 * Fire-and-forget notification helper.
 * Sends a system notification to each target user individually.
 */
const _notifyUsers = async (targetUserIds, { title, message, systemAction, boundaryId, clientId, actorId }) => {
  try {
    if (!targetUserIds || targetUserIds.length === 0) return;
    const unique = [...new Set(targetUserIds.map(String))];
    for (const userId of unique) {
      await Notification.create({
        title,
        message,
        priority: 'medium',
        createdBy: actorId,
        targetUsers: [userId],
        targetClients: [clientId],
        status: 'published',
        isSystemNotification: true,
        systemAction,
        relatedEntity: { type: 'EsgLinkBoundary', id: boundaryId },
      });
    }
  } catch (err) {
    // fire-and-forget — never throw
    console.error('[mappingController] _notifyUsers error (non-blocking):', err.message);
  }
};

/** Emit socket event fire-and-forget */
const _emitSocket = (affectedUserIds, eventType, payload) => {
  try {
    if (!global.io) return;
    const unique = [...new Set((affectedUserIds || []).map(String))];
    for (const userId of unique) {
      global.io.to(`user_${userId}`).emit('esg_link_mapping_update', {
        type: eventType,
        ...payload,
        timestamp: new Date().toISOString(),
      });
    }
    global.io.to('userType_super_admin').emit('esg_link_mapping_update', {
      type: eventType,
      ...payload,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[mappingController] _emitSocket error (non-blocking):', err.message);
  }
};

// ── 1. addMetricToNode ────────────────────────────────────────────────────────
// POST /:clientId/boundary/nodes/:nodeId/metrics

const addMetricToNode = async (req, res) => {
  try {
    const { clientId, nodeId } = req.params;

    const perm = await canManageMapping(req.user, clientId);
    if (_guardPermission(perm, res)) return;

    const { metricId } = req.body;
    if (!metricId) {
      return res.status(400).json({ message: 'metricId is required', code: 'MISSING_REQUIRED_FIELDS' });
    }
    if (!mongoose.Types.ObjectId.isValid(metricId)) {
      return res.status(400).json({ message: 'Invalid metricId', code: 'INVALID_ID' });
    }

    // Load boundary
    const boundary = await _getActiveBoundary(clientId);
    if (!boundary) {
      return res.status(404).json({ message: 'No active boundary found for this client', code: 'BOUNDARY_NOT_FOUND' });
    }

    const node = _findNode(boundary, nodeId);
    if (!node) {
      return res.status(404).json({ message: 'Node not found in boundary', code: 'NODE_NOT_FOUND' });
    }

    // Load metric
    const metric = await EsgMetric.findOne({ _id: metricId, isDeleted: false }).lean();
    if (!metric) {
      return res.status(404).json({ message: 'Metric not found', code: 'METRIC_NOT_FOUND' });
    }
    if (metric.publishedStatus !== 'published') {
      return res.status(400).json({ message: 'Only published metrics can be mapped', code: 'METRIC_NOT_PUBLISHED' });
    }
    if (metric.retiredAt) {
      return res.status(400).json({ message: 'Retired metrics cannot be mapped', code: 'METRIC_RETIRED' });
    }

    // Duplicate check — guard against existing nodes that predate Step 3 schema
    if (!node.metricsDetails) node.metricsDetails = [];
    const alreadyMapped = node.metricsDetails.some(m => String(m.metricId) === String(metricId));
    if (alreadyMapped) {
      return res.status(400).json({ message: 'This metric is already mapped to this node', code: 'METRIC_ALREADY_MAPPED' });
    }

    // Validate variable configs for derived/intensity
    if ((metric.metricType === 'derived' || metric.metricType === 'intensity') && metric.formulaId) {
      if (!req.body.variableConfigs || req.body.variableConfigs.length === 0) {
        return res.status(400).json({
          message: 'variableConfigs are required for derived/intensity metrics',
          code: 'FORMULA_VARIABLE_CONFIGS_REQUIRED',
        });
      }
    }

    // Validate defaultSourceType
    if (req.body.defaultSourceType && req.body.allowedSourceTypes) {
      if (!req.body.allowedSourceTypes.includes(req.body.defaultSourceType)) {
        return res.status(400).json({
          message: 'defaultSourceType must be one of allowedSourceTypes',
          code: 'INVALID_DEFAULT_SOURCE_TYPE',
        });
      }
    }

    // Validate assignees by role type
    if ((req.body.contributors || []).length > 0) {
      const check = await validateAssignees(req.body.contributors, clientId, 'contributor', UserModel);
      if (!check.valid) return res.status(400).json({ message: check.message, code: 'INVALID_CONTRIBUTOR' });
    }
    if ((req.body.reviewers || []).length > 0) {
      const check = await validateAssignees(req.body.reviewers, clientId, 'reviewer', UserModel);
      if (!check.valid) return res.status(400).json({ message: check.message, code: 'INVALID_REVIEWER' });
    }
    if ((req.body.approvers || []).length > 0) {
      const check = await validateAssignees(req.body.approvers, clientId, 'approver', UserModel);
      if (!check.valid) return res.status(400).json({ message: check.message, code: 'INVALID_APPROVER' });
    }

    // Build formula snapshot for derived/intensity
    let formulaSnap = { formulaVersionAtAssignment: null, formulaSnapshot: null };
    if ((metric.metricType === 'derived' || metric.metricType === 'intensity') && metric.formulaId) {
      try {
        formulaSnap = await buildFormulaSnapshot(metric.formulaId, Formula);
      } catch (snapErr) {
        return res.status(400).json({ message: 'Formula referenced by this metric is no longer available', code: 'FORMULA_UNAVAILABLE' });
      }
    }

    // Build mapping entry
    const newMapping = buildMappingEntry(req.body, req.user, metric, formulaSnap);

    // Push into node — Mongoose assigns _id to subdoc here, BEFORE save
    node.metricsDetails.push(newMapping);
    // Capture the subdoc reference now (encryption plugin re-encrypts nodes in-memory after save,
    // making boundary.nodes unreadable post-save without a fresh DB fetch)
    const savedMapping = node.metricsDetails[node.metricsDetails.length - 1];
    const nodeLabel    = node.label;

    node.updatedAt = new Date();
    boundary.version = (boundary.version || 1) + 1;
    boundary.lastModifiedBy = req.user._id;
    boundary.markModified('nodes');
    await boundary.save();

    // Audit log
    logEventFireAndForget({
      req,
      module:        'esg_link_mapping',
      action:        'create',
      subAction:     'metric_mapped',
      entityType:    'EsgLinkBoundary',
      entityId:      boundary._id.toString(),
      clientId,
      changeSummary: `Metric ${metric.metricCode} mapped to node ${nodeId}`,
      metadata:      { nodeId, metricId, metricCode: metric.metricCode, mappingId: savedMapping._id },
      severity:      'info',
      status:        'success',
    });

    // Notifications + socket (fire-and-forget)
    const effectiveReviewers = resolveEffectiveReviewers(savedMapping, node);
    const effectiveApprovers = resolveEffectiveApprovers(savedMapping, node);
    const notifyIds = [...(effectiveReviewers || []), ...(effectiveApprovers || [])];
    _notifyUsers(notifyIds, {
      title: `Metric mapped: ${metric.metricName}`,
      message: `Metric ${metric.metricCode} has been mapped to node "${nodeLabel}" by ${req.user.name || req.user.email}.`,
      systemAction: 'esg_link_metric_mapped',
      boundaryId: boundary._id,
      clientId,
      actorId: req.user._id,
    });
    _emitSocket(notifyIds, 'metric_mapped', {
      clientId,
      boundaryId: boundary._id,
      nodeId,
      mappingId:  savedMapping._id,
      metricCode: metric.metricCode,
      actorId:    req.user._id,
    });

    return res.status(201).json({
      message: 'Metric mapped to node successfully',
      nodeId,
      mapping: {
        _id:            savedMapping._id,
        metricId:       savedMapping.metricId,
        metricCode:     savedMapping.metricCode,
        metricName:     savedMapping.metricName,
        mappingStatus:  savedMapping.mappingStatus,
        frequency:      savedMapping.frequency,
        allowedSourceTypes: savedMapping.allowedSourceTypes,
        auditTrailRequired: savedMapping.auditTrailRequired,
        mappingVersion: savedMapping.mappingVersion,
        createdBy:      savedMapping.createdBy,
        createdAt:      savedMapping.createdAt,
      },
    });
  } catch (err) {
    console.error('[mappingController] addMetricToNode error:', err);
    return res.status(500).json({ message: 'Internal server error', code: 'SERVER_ERROR' });
  }
};

// ── 2. updateMapping ──────────────────────────────────────────────────────────
// PATCH /:clientId/boundary/nodes/:nodeId/metrics/:mappingId

const updateMapping = async (req, res) => {
  try {
    const { clientId, nodeId, mappingId } = req.params;

    const perm = await canManageMapping(req.user, clientId);
    if (_guardPermission(perm, res)) return;

    const boundary = await _getActiveBoundary(clientId);
    if (!boundary) return res.status(404).json({ message: 'Boundary not found', code: 'BOUNDARY_NOT_FOUND' });

    const node = _findNode(boundary, nodeId);
    if (!node) return res.status(404).json({ message: 'Node not found', code: 'NODE_NOT_FOUND' });

    const mapping = _findMapping(node, mappingId);
    if (!mapping) return res.status(404).json({ message: 'Mapping not found', code: 'MAPPING_NOT_FOUND' });

    // Fields that cannot be updated
    const IMMUTABLE = ['metricId', 'metricCode', 'metricName', 'formulaSnapshot',
      'formulaVersionAtAssignment', 'auditTrailRequired', 'createdBy', 'createdAt',
      'mappingVersion', 'versionHistory'];

    const body = { ...req.body };
    IMMUTABLE.forEach(f => delete body[f]);

    if (Object.keys(body).length === 0) {
      return res.status(400).json({ message: 'No updatable fields provided', code: 'NO_UPDATE_FIELDS' });
    }

    // Validate defaultSourceType
    const newAllowed = body.allowedSourceTypes || mapping.allowedSourceTypes || [];
    const newDefault = body.defaultSourceType !== undefined ? body.defaultSourceType : mapping.defaultSourceType;
    if (newDefault && newAllowed.length > 0 && !newAllowed.includes(newDefault)) {
      return res.status(400).json({ message: 'defaultSourceType must be one of allowedSourceTypes', code: 'INVALID_DEFAULT_SOURCE_TYPE' });
    }

    // Validate status transition
    const VALID_TRANSITIONS = {
      draft:        ['under_review', 'approved', 'active', 'inactive'],
      under_review: ['approved', 'rejected', 'draft'],
      approved:     ['active', 'inactive', 'draft'],
      rejected:     ['draft'],
      active:       ['inactive'],
      inactive:     ['active', 'draft'],
    };
    if (body.mappingStatus && body.mappingStatus !== mapping.mappingStatus) {
      const allowed = VALID_TRANSITIONS[mapping.mappingStatus] || [];
      if (!allowed.includes(body.mappingStatus)) {
        return res.status(400).json({
          message: `Invalid status transition: ${mapping.mappingStatus} → ${body.mappingStatus}`,
          code: 'INVALID_STATUS_TRANSITION',
        });
      }
    }

    // Validate assignees if being updated, by role type
    if ((body.contributors || []).length > 0) {
      const check = await validateAssignees(body.contributors, clientId, 'contributor', UserModel);
      if (!check.valid) return res.status(400).json({ message: check.message, code: 'INVALID_CONTRIBUTOR' });
    }
    if ((body.reviewers || []).length > 0) {
      const check = await validateAssignees(body.reviewers, clientId, 'reviewer', UserModel);
      if (!check.valid) return res.status(400).json({ message: check.message, code: 'INVALID_REVIEWER' });
    }
    if ((body.approvers || []).length > 0) {
      const check = await validateAssignees(body.approvers, clientId, 'approver', UserModel);
      if (!check.valid) return res.status(400).json({ message: check.message, code: 'INVALID_APPROVER' });
    }

    // Capture previous status BEFORE applying updates
    const previousStatus = mapping.mappingStatus;

    // Version bump if meaningful fields changed
    const shouldBump = hasMeaningfulChange(body);
    if (shouldBump) {
      appendVersionHistory(mapping, req.user, `Updated: ${Object.keys(body).join(', ')}`);
    }

    // Sanitise validationRules if provided
    if (body.validationRules) {
      body.validationRules = body.validationRules.map(rule => ({
        ...rule,
        validationRuleId: null,
      }));
    }

    // Always hardcode auditTrailRequired
    body.auditTrailRequired = true;
    body.updatedBy = req.user._id;
    body.updatedAt = new Date();

    // Apply updates to mapping
    Object.assign(mapping, body);

    boundary.version = (boundary.version || 1) + 1;
    boundary.lastModifiedBy = req.user._id;
    boundary.markModified('nodes');
    await boundary.save();

    // Determine subAction by status change (compare against pre-update status)
    const statusChanged = body.mappingStatus && body.mappingStatus !== previousStatus;
    let subAction = 'mapping_updated';
    if (statusChanged) {
      const subActionMap = {
        under_review: 'mapping_submitted_for_review',
        approved:     'mapping_approved',
        rejected:     'mapping_rejected',
        active:       'mapping_activated',
      };
      subAction = subActionMap[body.mappingStatus] || 'mapping_updated';
    }

    logEventFireAndForget({
      req,
      module:        'esg_link_mapping',
      action:        'update',
      subAction,
      entityType:    'EsgLinkBoundary',
      entityId:      boundary._id.toString(),
      clientId,
      changeSummary: `Mapping ${mappingId} updated on node ${nodeId}`,
      metadata:      { nodeId, mappingId, updatedFields: Object.keys(body), versionBumped: shouldBump },
      severity:      subAction === 'mapping_rejected' ? 'warning' : 'info',
      status:        'success',
    });

    // Notify on status change
    if (statusChanged) {
      const notifyTargets = subAction === 'mapping_submitted_for_review'
        ? [...(resolveEffectiveReviewers(mapping, node)), ...(resolveEffectiveApprovers(mapping, node))]
        : (mapping.contributors || []);

      _notifyUsers(notifyTargets, {
        title:        `Mapping ${body.mappingStatus}: ${mapping.metricCode}`,
        message:      `Mapping for metric ${mapping.metricCode} on node "${node.label}" is now ${body.mappingStatus}.`,
        systemAction: `esg_link_mapping_${body.mappingStatus}`,
        boundaryId:   boundary._id,
        clientId,
        actorId:      req.user._id,
      });
      _emitSocket(notifyTargets, 'mapping_status_changed', {
        clientId, boundaryId: boundary._id, nodeId, mappingId, newStatus: body.mappingStatus,
      });
    }

    return res.status(200).json({
      message: 'Mapping updated successfully',
      nodeId,
      mapping: {
        _id:            mapping._id,
        metricCode:     mapping.metricCode,
        mappingStatus:  mapping.mappingStatus,
        mappingVersion: mapping.mappingVersion,
        updatedBy:      mapping.updatedBy,
        updatedAt:      mapping.updatedAt,
      },
    });
  } catch (err) {
    console.error('[mappingController] updateMapping error:', err);
    return res.status(500).json({ message: 'Internal server error', code: 'SERVER_ERROR' });
  }
};

// ── 3. removeMapping ──────────────────────────────────────────────────────────
// DELETE /:clientId/boundary/nodes/:nodeId/metrics/:mappingId

const removeMapping = async (req, res) => {
  try {
    const { clientId, nodeId, mappingId } = req.params;

    const perm = await canManageMapping(req.user, clientId);
    if (_guardPermission(perm, res)) return;

    const boundary = await _getActiveBoundary(clientId);
    if (!boundary) return res.status(404).json({ message: 'Boundary not found', code: 'BOUNDARY_NOT_FOUND' });

    const node = _findNode(boundary, nodeId);
    if (!node) return res.status(404).json({ message: 'Node not found', code: 'NODE_NOT_FOUND' });

    const mapping = _findMapping(node, mappingId);
    if (!mapping) return res.status(404).json({ message: 'Mapping not found', code: 'MAPPING_NOT_FOUND' });

    if (mapping.mappingStatus === 'inactive') {
      return res.status(400).json({ message: 'Mapping is already inactive', code: 'MAPPING_ALREADY_INACTIVE' });
    }

    const previousStatus = mapping.mappingStatus;
    mapping.mappingStatus = 'inactive';
    mapping.updatedBy = req.user._id;
    mapping.updatedAt = new Date();

    boundary.version = (boundary.version || 1) + 1;
    boundary.lastModifiedBy = req.user._id;
    boundary.markModified('nodes');
    await boundary.save();

    logEventFireAndForget({
      req,
      module:        'esg_link_mapping',
      action:        'delete',
      subAction:     'mapping_removed',
      entityType:    'EsgLinkBoundary',
      entityId:      boundary._id.toString(),
      clientId,
      changeSummary: `Mapping ${mappingId} (${mapping.metricCode}) deactivated on node ${nodeId}`,
      metadata:      { nodeId, mappingId, metricCode: mapping.metricCode, previousStatus },
      severity:      'warning',
      status:        'success',
    });

    const notifyIds = [
      ...(mapping.contributors || []),
      ...(resolveEffectiveReviewers(mapping, node)),
      ...(resolveEffectiveApprovers(mapping, node)),
    ];
    _notifyUsers(notifyIds, {
      title:        `Mapping removed: ${mapping.metricCode}`,
      message:      `Mapping for metric ${mapping.metricCode} on node "${node.label}" has been removed.`,
      systemAction: 'esg_link_mapping_removed',
      boundaryId:   boundary._id,
      clientId,
      actorId:      req.user._id,
    });
    _emitSocket(notifyIds, 'mapping_removed', { clientId, boundaryId: boundary._id, nodeId, mappingId });

    return res.status(200).json({
      message:       'Mapping removed (deactivated) successfully',
      nodeId,
      mappingId,
      mappingStatus: 'inactive',
      updatedAt:     mapping.updatedAt,
    });
  } catch (err) {
    console.error('[mappingController] removeMapping error:', err);
    return res.status(500).json({ message: 'Internal server error', code: 'SERVER_ERROR' });
  }
};

// ── reactivateMapping ────────────────────────────────────────────────────────
// PATCH /:clientId/boundary/nodes/:nodeId/metrics/:mappingId/reactivate

const reactivateMapping = async (req, res) => {
  try {
    const { clientId, nodeId, mappingId } = req.params;

    const perm = await canManageMapping(req.user, clientId);
    if (_guardPermission(perm, res)) return;

    const boundary = await _getActiveBoundary(clientId);
    if (!boundary) return res.status(404).json({ message: 'Boundary not found', code: 'BOUNDARY_NOT_FOUND' });

    const node = _findNode(boundary, nodeId);
    if (!node) return res.status(404).json({ message: 'Node not found', code: 'NODE_NOT_FOUND' });

    const mapping = _findMapping(node, mappingId);
    if (!mapping) return res.status(404).json({ message: 'Mapping not found', code: 'MAPPING_NOT_FOUND' });

    if (mapping.mappingStatus !== 'inactive') {
      return res.status(400).json({ message: 'Only inactive mappings can be reactivated', code: 'MAPPING_NOT_INACTIVE' });
    }

    mapping.mappingStatus = 'active';
    mapping.updatedBy = req.user._id;
    mapping.updatedAt = new Date();

    boundary.version = (boundary.version || 1) + 1;
    boundary.lastModifiedBy = req.user._id;
    boundary.markModified('nodes');
    await boundary.save();

    logEventFireAndForget({
      req,
      module:        'esg_link_mapping',
      action:        'update',
      subAction:     'mapping_reactivated',
      entityType:    'EsgLinkBoundary',
      entityId:      boundary._id.toString(),
      clientId,
      changeSummary: `Mapping ${mappingId} (${mapping.metricCode}) reactivated on node ${nodeId}`,
      metadata:      { nodeId, mappingId, metricCode: mapping.metricCode },
      severity:      'info',
      status:        'success',
    });

    const notifyIds = [
      ...(mapping.contributors || []),
      ...(resolveEffectiveReviewers(mapping, node)),
      ...(resolveEffectiveApprovers(mapping, node)),
    ];
    _notifyUsers(notifyIds, {
      title:        `Mapping reactivated: ${mapping.metricCode}`,
      message:      `Mapping for metric ${mapping.metricCode} on node "${node.label}" has been reactivated.`,
      systemAction: 'esg_link_mapping_reactivated',
      boundaryId:   boundary._id,
      clientId,
      actorId:      req.user._id,
    });
    _emitSocket(notifyIds, 'mapping_reactivated', { clientId, boundaryId: boundary._id, nodeId, mappingId });

    return res.status(200).json({
      message:       'Mapping reactivated successfully',
      nodeId,
      mappingId,
      mappingStatus: 'active',
      updatedAt:     mapping.updatedAt,
    });
  } catch (err) {
    console.error('[mappingController] reactivateMapping error:', err);
    return res.status(500).json({ message: 'Internal server error', code: 'SERVER_ERROR' });
  }
};

// ── 4. updateWorkflowDefaults ─────────────────────────────────────────────────
// PATCH /:clientId/boundary/nodes/:nodeId/workflow-defaults

const updateWorkflowDefaults = async (req, res) => {
  try {
    const { clientId, nodeId } = req.params;

    const perm = await canManageWorkflowDefaults(req.user, clientId);
    if (_guardPermission(perm, res)) return;

    const { nodeReviewerIds, nodeApproverIds } = req.body;
    if (!nodeReviewerIds && !nodeApproverIds) {
      return res.status(400).json({ message: 'nodeReviewerIds or nodeApproverIds is required', code: 'NO_UPDATE_FIELDS' });
    }

    // Validate reviewer and approver IDs separately by their expected role type
    if ((nodeReviewerIds || []).length > 0) {
      const check = await validateAssignees(nodeReviewerIds, clientId, 'reviewer', UserModel);
      if (!check.valid) return res.status(400).json({ message: check.message, code: 'INVALID_REVIEWER' });
    }
    if ((nodeApproverIds || []).length > 0) {
      const check = await validateAssignees(nodeApproverIds, clientId, 'approver', UserModel);
      if (!check.valid) return res.status(400).json({ message: check.message, code: 'INVALID_APPROVER' });
    }

    const boundary = await _getActiveBoundary(clientId);
    if (!boundary) return res.status(404).json({ message: 'Boundary not found', code: 'BOUNDARY_NOT_FOUND' });

    const node = _findNode(boundary, nodeId);
    if (!node) return res.status(404).json({ message: 'Node not found', code: 'NODE_NOT_FOUND' });

    if (nodeReviewerIds !== undefined) node.nodeReviewerIds = nodeReviewerIds;
    if (nodeApproverIds !== undefined) node.nodeApproverIds = nodeApproverIds;
    node.updatedAt = new Date();

    boundary.version = (boundary.version || 1) + 1;
    boundary.lastModifiedBy = req.user._id;
    boundary.markModified('nodes');
    await boundary.save();

    logEventFireAndForget({
      req,
      module:        'esg_link_mapping',
      action:        'update',
      subAction:     'workflow_defaults_updated',
      entityType:    'EsgLinkBoundary',
      entityId:      boundary._id.toString(),
      clientId,
      changeSummary: `Node ${nodeId} workflow defaults updated`,
      metadata:      { nodeId, nodeReviewerIds, nodeApproverIds },
      severity:      'info',
      status:        'success',
    });

    const notifyIds = [...(nodeReviewerIds || []), ...(nodeApproverIds || [])];
    _notifyUsers(notifyIds, {
      title:        `Workflow defaults updated: node "${node.label}"`,
      message:      `You have been assigned as a reviewer/approver for node "${node.label}".`,
      systemAction: 'esg_link_node_workflow_updated',
      boundaryId:   boundary._id,
      clientId,
      actorId:      req.user._id,
    });
    _emitSocket(notifyIds, 'node_workflow_defaults_updated', { clientId, boundaryId: boundary._id, nodeId });

    return res.status(200).json({
      message:         'Node workflow defaults updated successfully',
      nodeId,
      nodeReviewerIds: node.nodeReviewerIds,
      nodeApproverIds: node.nodeApproverIds,
    });
  } catch (err) {
    console.error('[mappingController] updateWorkflowDefaults error:', err);
    return res.status(500).json({ message: 'Internal server error', code: 'SERVER_ERROR' });
  }
};

// ── 5. getMyAssignedMetrics ───────────────────────────────────────────────────
// GET /:clientId/my-assigned-metrics

const getMyAssignedMetrics = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { role, mappingStatus } = req.query;

    const perm = await canViewAssignedMetrics(req.user, clientId);
    if (_guardPermission(perm, res)) return;

    const boundary = await _getActiveBoundary(clientId);
    if (!boundary) return res.status(404).json({ message: 'Boundary not found', code: 'BOUNDARY_NOT_FOUND' });

    const userId = String(req.user._id);
    const assignments = [];

    for (const node of boundary.nodes) {
      for (const mapping of (node.metricsDetails || [])) {
        // Determine which role(s) this user has in this mapping
        const isContributor = (mapping.contributors || []).some(id => String(id) === userId);
        const isReviewer    = (mapping.reviewers    || []).some(id => String(id) === userId) ||
                              (mapping.inheritNodeReviewers && (node.nodeReviewerIds || []).some(id => String(id) === userId));
        const isApprover    = (mapping.approvers    || []).some(id => String(id) === userId) ||
                              (mapping.inheritNodeApprovers && (node.nodeApproverIds || []).some(id => String(id) === userId));

        // Role filter if ?role= is provided
        if (role === 'contributor' && !isContributor) continue;
        if (role === 'reviewer'    && !isReviewer)    continue;
        if (role === 'approver'    && !isApprover)    continue;
        if (!isContributor && !isReviewer && !isApprover) continue;

        // mappingStatus filter
        if (mappingStatus && mapping.mappingStatus !== mappingStatus) continue;

        // Determine primary role label for response
        let assignedRole = isContributor ? 'contributor' : (isReviewer ? 'reviewer' : 'approver');

        assignments.push({
          nodeId:    node.id,
          nodeLabel: node.label,
          role:      assignedRole,
          mapping: {
            _id:                mapping._id,
            metricId:           mapping.metricId,
            metricCode:         mapping.metricCode,
            metricName:         mapping.metricName,
            mappingStatus:      mapping.mappingStatus,
            frequency:          mapping.frequency,
            allowedSourceTypes: mapping.allowedSourceTypes,
            defaultSourceType:  mapping.defaultSourceType,
            evidenceRequirement: mapping.evidenceRequirement,
            evidenceTypeNote:   mapping.evidenceTypeNote,
            ingestionInstructions: mapping.ingestionInstructions,
            auditTrailRequired: mapping.auditTrailRequired,
            mappingVersion:     mapping.mappingVersion,
            updatedAt:          mapping.updatedAt,
          },
        });
      }
    }

    return res.status(200).json({
      clientId,
      total: assignments.length,
      assignments,
    });
  } catch (err) {
    console.error('[mappingController] getMyAssignedMetrics error:', err);
    return res.status(500).json({ message: 'Internal server error', code: 'SERVER_ERROR' });
  }
};

// ── 6. getMappingById ─────────────────────────────────────────────────────────
// GET /:clientId/nodes/:nodeId/metrics/:mappingId

const getMappingById = async (req, res) => {
  try {
    const { clientId, nodeId, mappingId } = req.params;

    const boundary = await _getActiveBoundary(clientId);
    if (!boundary) return res.status(404).json({ message: 'Boundary not found', code: 'BOUNDARY_NOT_FOUND' });

    const node = _findNode(boundary, nodeId);
    if (!node) return res.status(404).json({ message: 'Node not found', code: 'NODE_NOT_FOUND' });

    const mapping = _findMapping(node, mappingId);
    if (!mapping) return res.status(404).json({ message: 'Mapping not found', code: 'MAPPING_NOT_FOUND' });

    // Check if user is a manager
    const managerPerm = await canManageMapping(req.user, clientId);

    if (managerPerm.allowed) {
      // Full view for managers
      return res.status(200).json({
        nodeId,
        nodeLabel:       node.label,
        nodeReviewerIds: node.nodeReviewerIds,
        nodeApproverIds: node.nodeApproverIds,
        mapping,
      });
    }

    // Check if user is an assignee
    const userId = String(req.user._id);
    const isAssigned =
      (mapping.contributors || []).some(id => String(id) === userId) ||
      (mapping.reviewers    || []).some(id => String(id) === userId) ||
      (mapping.approvers    || []).some(id => String(id) === userId) ||
      (mapping.inheritNodeReviewers && (node.nodeReviewerIds || []).some(id => String(id) === userId)) ||
      (mapping.inheritNodeApprovers && (node.nodeApproverIds || []).some(id => String(id) === userId));

    if (!isAssigned) {
      return res.status(403).json({ message: 'Permission denied', reason: 'Not assigned to this mapping' });
    }

    // Filtered view for assignees — no workflow management fields
    return res.status(200).json({
      nodeId,
      nodeLabel: node.label,
      mapping: {
        _id:                   mapping._id,
        metricId:              mapping.metricId,
        metricCode:            mapping.metricCode,
        metricName:            mapping.metricName,
        mappingStatus:         mapping.mappingStatus,
        frequency:             mapping.frequency,
        boundaryScope:         mapping.boundaryScope,
        rollUpBehavior:        mapping.rollUpBehavior,
        allowedSourceTypes:    mapping.allowedSourceTypes,
        defaultSourceType:     mapping.defaultSourceType,
        evidenceRequirement:   mapping.evidenceRequirement,
        evidenceTypeNote:      mapping.evidenceTypeNote,
        ingestionInstructions: mapping.ingestionInstructions,
        zeroCarbonReference:   mapping.zeroCarbonReference,
        auditTrailRequired:    mapping.auditTrailRequired,
        mappingVersion:        mapping.mappingVersion,
        updatedAt:             mapping.updatedAt,
      },
    });
  } catch (err) {
    console.error('[mappingController] getMappingById error:', err);
    return res.status(500).json({ message: 'Internal server error', code: 'SERVER_ERROR' });
  }
};

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  addMetricToNode,
  updateMapping,
  removeMapping,
  reactivateMapping,
  updateWorkflowDefaults,
  getMyAssignedMetrics,
  getMappingById,
};
