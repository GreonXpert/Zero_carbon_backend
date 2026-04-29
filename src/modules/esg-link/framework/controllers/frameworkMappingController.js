'use strict';

const QuestionMetricMapping          = require('../models/QuestionMetricMapping.model');
const EsgFrameworkQuestion           = require('../models/FrameworkQuestion.model');
const EsgMetric                      = require('../../esgLink_core/metric/models/EsgMetric');
const { canManageFrameworkQuestion } = require('../services/frameworkAccessService');
const { canConsultantFinalApprove }  = require('../services/frameworkAccessService');
const { syncMetricFrameworkFlags }   = require('../services/metricFrameworkSyncService');

// ── Shared mapping creation logic ─────────────────────────────────────────────
// clientId = null  → framework-level template (visible to all clients)
// clientId = <id>  → client-specific override (applies only to that client)

const _createMappingDoc = async (req, res, clientId) => {
  const { questionId } = req.params;
  const {
    metricId, metricCode, frameworkId, frameworkCode, sectionCode, principleCode,
    indicatorType, mappingType, boundaryLevel, aggregationMethod, periodType,
    answerFieldKey, isPrimary, isCore, isBrsrCore, allowManualOverride, requiredForReadiness,
    useAllNodes, boundaryNodeIds,
  } = req.body;

  if (!metricId)      return res.status(400).json({ message: 'metricId is required' });
  if (!frameworkId)   return res.status(400).json({ message: 'frameworkId is required' });
  if (!frameworkCode) return res.status(400).json({ message: 'frameworkCode is required' });

  const resolvedUseAllNodes = useAllNodes !== false;
  if (!resolvedUseAllNodes) {
    const nodeIds = Array.isArray(boundaryNodeIds) ? boundaryNodeIds.filter(Boolean) : [];
    if (!nodeIds.length) {
      return res.status(400).json({
        message: 'boundaryNodeIds must contain at least one nodeId when useAllNodes is false. To use all nodes, set useAllNodes to true or omit it.',
      });
    }
  }

  const question = await EsgFrameworkQuestion.findById(questionId, 'questionCode frameworkCode').lean();
  if (!question) return res.status(404).json({ message: 'Question not found' });

  const metric = await EsgMetric.findById(metricId, 'metricCode').lean();
  if (!metric) return res.status(404).json({ message: 'Metric not found' });

  const existing = await QuestionMetricMapping.findOne({
    questionId,
    metricId,
    clientId: clientId || null,
    active: true,
  }).lean();
  if (existing) {
    return res.status(409).json({
      message: clientId
        ? 'An active client-specific mapping for this question+metric+client combination already exists'
        : 'An active framework-level mapping for this question+metric combination already exists',
    });
  }

  const mapping = await QuestionMetricMapping.create({
    clientId:             clientId || null,
    frameworkId,
    frameworkCode:        frameworkCode.toUpperCase(),
    questionId,
    questionCode:         question.questionCode,
    metricId,
    metricCode:           metricCode || metric.metricCode,
    sectionCode:          sectionCode    || null,
    principleCode:        principleCode  || null,
    indicatorType:        indicatorType  || null,
    mappingType:          mappingType    || 'auto_answer',
    boundaryLevel:        boundaryLevel  || null,
    aggregationMethod:    aggregationMethod || 'sum',
    periodType:           periodType     || 'annual',
    answerFieldKey:       answerFieldKey || null,
    isPrimary:            isPrimary      || false,
    isCore:               isCore         || false,
    isBrsrCore:           isBrsrCore     || false,
    allowManualOverride:  allowManualOverride !== undefined ? allowManualOverride : true,
    requiredForReadiness: requiredForReadiness || false,
    useAllNodes:          resolvedUseAllNodes,
    boundaryNodeIds:      resolvedUseAllNodes ? [] : (Array.isArray(boundaryNodeIds) ? boundaryNodeIds.filter(Boolean) : []),
    active:               true,
    createdBy:            req.user._id,
  });

  await syncMetricFrameworkFlags(metricId);

  return res.status(201).json({
    success: true,
    message: clientId ? 'Client-specific mapping created' : 'Framework-level mapping created',
    data: mapping,
  });
};

// ── Framework-level mapping (no clientId) ─────────────────────────────────────

const createMapping = async (req, res) => {
  try {
    const perm = canManageFrameworkQuestion(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });
    return await _createMappingDoc(req, res, null);
  } catch (err) {
    console.error('[frameworkMappingController] createMapping:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const listMappings = async (req, res) => {
  try {
    const { questionId } = req.params;
    const { active, clientId: qClientId } = req.query;

    const query = { questionId, clientId: null };
    if (active !== undefined) query.active = active === 'true';

    const mappings = await QuestionMetricMapping.find(query)
      .populate('metricId', 'metricCode metricName esgCategory primaryUnit')
      .lean();

    return res.status(200).json({ success: true, count: mappings.length, data: mappings });
  } catch (err) {
    console.error('[frameworkMappingController] listMappings:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const updateMapping = async (req, res) => {
  try {
    const perm = canManageFrameworkQuestion(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { mappingId } = req.params;
    const allowedFields = [
      'mappingType', 'boundaryLevel', 'aggregationMethod', 'periodType',
      'answerFieldKey', 'isPrimary', 'isCore', 'isBrsrCore',
      'allowManualOverride', 'requiredForReadiness',
    ];
    const update = {};
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }

    if (req.body.useAllNodes !== undefined) {
      update.useAllNodes = req.body.useAllNodes !== false;
      if (!update.useAllNodes) {
        const nodeIds = Array.isArray(req.body.boundaryNodeIds) ? req.body.boundaryNodeIds.filter(Boolean) : [];
        if (!nodeIds.length) {
          return res.status(400).json({
            message: 'boundaryNodeIds must contain at least one nodeId when useAllNodes is false',
          });
        }
        update.boundaryNodeIds = nodeIds;
      } else {
        update.boundaryNodeIds = [];
      }
    } else if (req.body.boundaryNodeIds !== undefined) {
      update.boundaryNodeIds = Array.isArray(req.body.boundaryNodeIds) ? req.body.boundaryNodeIds.filter(Boolean) : [];
    }

    update.updatedBy = req.user._id;

    const mapping = await QuestionMetricMapping.findByIdAndUpdate(
      mappingId,
      { $set: update },
      { new: true, runValidators: true }
    );
    if (!mapping) return res.status(404).json({ message: 'Mapping not found' });

    await syncMetricFrameworkFlags(mapping.metricId);

    return res.status(200).json({ success: true, message: 'Mapping updated', data: mapping });
  } catch (err) {
    console.error('[frameworkMappingController] updateMapping:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const deactivateMapping = async (req, res) => {
  try {
    const perm = canManageFrameworkQuestion(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { mappingId } = req.params;
    const mapping = await QuestionMetricMapping.findByIdAndUpdate(
      mappingId,
      { $set: { active: false, updatedBy: req.user._id } },
      { new: true }
    );
    if (!mapping) return res.status(404).json({ message: 'Mapping not found' });

    await syncMetricFrameworkFlags(mapping.metricId);

    return res.status(200).json({ success: true, message: 'Mapping deactivated', data: mapping });
  } catch (err) {
    console.error('[frameworkMappingController] deactivateMapping:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const reactivateMapping = async (req, res) => {
  try {
    const perm = canManageFrameworkQuestion(req.user);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { mappingId } = req.params;
    const target = await QuestionMetricMapping.findById(mappingId).lean();
    if (!target) return res.status(404).json({ message: 'Mapping not found' });

    // Check no other active mapping already exists for same question+metric+client
    const conflict = await QuestionMetricMapping.findOne({
      _id:        { $ne: mappingId },
      questionId: target.questionId,
      metricId:   target.metricId,
      clientId:   target.clientId || null,
      active:     true,
    }).lean();
    if (conflict) {
      return res.status(409).json({
        message: 'Another active mapping already exists for this question+metric combination. Deactivate it first.',
        data: { conflictId: conflict._id },
      });
    }

    const mapping = await QuestionMetricMapping.findByIdAndUpdate(
      mappingId,
      { $set: { active: true, updatedBy: req.user._id } },
      { new: true }
    );

    await syncMetricFrameworkFlags(mapping.metricId);

    return res.status(200).json({ success: true, message: 'Mapping reactivated', data: mapping });
  } catch (err) {
    console.error('[frameworkMappingController] reactivateMapping:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// ── Client-specific mapping ───────────────────────────────────────────────────
// Routes: /clients/:clientId/brsr/questions/:questionId/metrics[/:mappingId]

const createClientMapping = async (req, res) => {
  try {
    const { clientId } = req.params;
    const perm = await canConsultantFinalApprove(req.user, clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });
    return await _createMappingDoc(req, res, clientId);
  } catch (err) {
    console.error('[frameworkMappingController] createClientMapping:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const listClientMappings = async (req, res) => {
  try {
    const { clientId, questionId } = req.params;
    const { active, includeFramework } = req.query;

    const baseQuery = { questionId, active: active === 'false' ? false : true };

    // Client-specific mappings for this client
    const clientMappings = await QuestionMetricMapping.find({ ...baseQuery, clientId })
      .populate('metricId', 'metricCode metricName esgCategory primaryUnit')
      .lean();

    let frameworkMappings = [];
    if (includeFramework !== 'false') {
      // Framework-level templates (clientId: null) for this question
      frameworkMappings = await QuestionMetricMapping.find({ ...baseQuery, clientId: null })
        .populate('metricId', 'metricCode metricName esgCategory primaryUnit')
        .lean();
    }

    // Mark which metrics are overridden at client level
    const overriddenMetricIds = new Set(clientMappings.map((m) => String(m.metricId._id || m.metricId)));
    const frameworkTemplates = frameworkMappings.map((m) => ({
      ...m,
      _overriddenByClient: overriddenMetricIds.has(String(m.metricId._id || m.metricId)),
    }));

    return res.status(200).json({
      success: true,
      clientId,
      clientSpecific:    { count: clientMappings.length,   data: clientMappings },
      frameworkTemplate: { count: frameworkTemplates.length, data: frameworkTemplates },
    });
  } catch (err) {
    console.error('[frameworkMappingController] listClientMappings:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const updateClientMapping = async (req, res) => {
  try {
    const { clientId, mappingId } = req.params;
    const perm = await canConsultantFinalApprove(req.user, clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    // Ensure the mapping actually belongs to this client
    const existing = await QuestionMetricMapping.findOne({ _id: mappingId, clientId }).lean();
    if (!existing) {
      return res.status(404).json({ message: 'Client-specific mapping not found' });
    }

    const allowedFields = [
      'mappingType', 'boundaryLevel', 'aggregationMethod', 'periodType',
      'answerFieldKey', 'isPrimary', 'allowManualOverride', 'requiredForReadiness',
    ];
    const update = {};
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }

    if (req.body.useAllNodes !== undefined) {
      update.useAllNodes = req.body.useAllNodes !== false;
      if (!update.useAllNodes) {
        const nodeIds = Array.isArray(req.body.boundaryNodeIds) ? req.body.boundaryNodeIds.filter(Boolean) : [];
        if (!nodeIds.length) {
          return res.status(400).json({
            message: 'boundaryNodeIds must contain at least one nodeId when useAllNodes is false',
          });
        }
        update.boundaryNodeIds = nodeIds;
      } else {
        update.boundaryNodeIds = [];
      }
    } else if (req.body.boundaryNodeIds !== undefined) {
      update.boundaryNodeIds = Array.isArray(req.body.boundaryNodeIds) ? req.body.boundaryNodeIds.filter(Boolean) : [];
    }

    update.updatedBy = req.user._id;

    const mapping = await QuestionMetricMapping.findByIdAndUpdate(
      mappingId,
      { $set: update },
      { new: true, runValidators: true }
    );

    await syncMetricFrameworkFlags(mapping.metricId);

    return res.status(200).json({ success: true, message: 'Client mapping updated', data: mapping });
  } catch (err) {
    console.error('[frameworkMappingController] updateClientMapping:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const deactivateClientMapping = async (req, res) => {
  try {
    const { clientId, mappingId } = req.params;
    const perm = await canConsultantFinalApprove(req.user, clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const mapping = await QuestionMetricMapping.findOne({ _id: mappingId, clientId }).lean();
    if (!mapping) return res.status(404).json({ message: 'Client-specific mapping not found' });

    const updated = await QuestionMetricMapping.findByIdAndUpdate(
      mappingId,
      { $set: { active: false, updatedBy: req.user._id } },
      { new: true }
    );

    await syncMetricFrameworkFlags(mapping.metricId);

    return res.status(200).json({ success: true, message: 'Client mapping deactivated', data: updated });
  } catch (err) {
    console.error('[frameworkMappingController] deactivateClientMapping:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

module.exports = {
  createMapping,
  listMappings,
  updateMapping,
  deactivateMapping,
  reactivateMapping,
  createClientMapping,
  listClientMappings,
  updateClientMapping,
  deactivateClientMapping,
};
