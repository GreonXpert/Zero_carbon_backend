'use strict';

const EsgDataEntry      = require('../models/EsgDataEntry');
const EsgWorkflowAction = require('../models/EsgWorkflowAction');
const EsgLinkBoundary   = require('../../boundary/models/EsgLinkBoundary');

// ── GET /:clientId/completion ─────────────────────────────────────────────────
async function getCompletionStats(req, res) {
  try {
    const { clientId } = req.params;
    const accessCtx    = req.submissionAccessCtx;
    const year         = parseInt(req.query.year, 10) || new Date().getFullYear();

    // Load boundary to get all active mappings
    const boundary = await EsgLinkBoundary.findOne({ clientId, isActive: true, isDeleted: false });
    if (!boundary) {
      return res.json({ success: true, data: { summary: { totalMappings: 0 }, byNode: [], byMetric: [] } });
    }

    const allMappings = [];
    for (const node of boundary.nodes || []) {
      for (const mapping of node.metricsDetails || []) {
        if (mapping.mappingStatus === 'inactive') continue;
        allMappings.push({ node, mapping });
      }
    }

    // Filter to assigned mappings for restricted roles
    let filteredMappings = allMappings;
    if (!accessCtx.isFullAccess && !accessCtx.isViewOnly && accessCtx.assignedMappingIds) {
      filteredMappings = allMappings.filter(({ mapping }) =>
        mapping._id && accessCtx.assignedMappingIds.has(mapping._id.toString())
      );
    }

    const mappingIds = filteredMappings.map(({ mapping }) => mapping._id?.toString()).filter(Boolean);

    // Get all submissions for this year across these mappings
    const submissions = await EsgDataEntry.find({
      clientId,
      mappingId:     { $in: mappingIds },
      isDeleted:     false,
      'period.year': year,
    }).select('mappingId nodeId workflowStatus period submittedAt');

    // Build quick lookup maps
    const approvedMap   = new Map(); // mappingId → latest approved periodLabel
    const submittedMap  = new Map(); // mappingId → has any submission

    for (const s of submissions) {
      const mid = s.mappingId;
      submittedMap.set(mid, true);
      if (s.workflowStatus === 'approved') {
        approvedMap.set(mid, s.period?.periodLabel || '');
      }
    }

    // Build by-node and by-metric stats
    const byNode   = {};
    const byMetric = [];

    for (const { node, mapping } of filteredMappings) {
      const mid          = mapping._id?.toString();
      const hasApproved  = approvedMap.has(mid);
      const hasSubmitted = submittedMap.has(mid);

      // By node
      if (!byNode[node.id]) {
        byNode[node.id] = { nodeId: node.id, nodeLabel: node.label, totalMappings: 0, approved: 0, submitted: 0, pending: 0 };
      }
      byNode[node.id].totalMappings++;
      if (hasApproved)        byNode[node.id].approved++;
      else if (hasSubmitted)  byNode[node.id].submitted++;
      else                    byNode[node.id].pending++;

      // By metric
      byMetric.push({
        mappingId:            mid,
        metricId:             mapping.metricId,
        metricName:           mapping.metricName,
        metricCode:           mapping.metricCode,
        nodeId:               node.id,
        frequency:            mapping.frequency,
        latestApprovedPeriod: approvedMap.get(mid) || null,
        currentPeriodStatus:  hasApproved ? 'approved' : hasSubmitted ? 'in_progress' : 'pending',
      });
    }

    const total     = filteredMappings.length;
    const approved  = byMetric.filter((m) => m.currentPeriodStatus === 'approved').length;
    const submitted = byMetric.filter((m) => m.currentPeriodStatus === 'in_progress').length;
    const pending   = byMetric.filter((m) => m.currentPeriodStatus === 'pending').length;

    return res.json({
      success: true,
      data: {
        clientId,
        period: { year },
        summary: {
          totalMappings:      total,
          withApprovedData:   approved,
          withSubmittedData:  submitted,
          pendingSubmission:  pending,
          completionPercentage: total > 0 ? Math.round((approved / total) * 100) : 0,
        },
        byNode:   Object.values(byNode),
        byMetric,
      },
    });
  } catch (err) {
    console.error('[completionController.getCompletionStats]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── GET /:clientId/approved ───────────────────────────────────────────────────
async function getApprovedData(req, res) {
  try {
    const { clientId } = req.params;
    const accessCtx    = req.submissionAccessCtx;
    const latestOnly   = req.query.latestOnly !== 'false'; // default true

    const query = {
      clientId,
      workflowStatus: 'approved',
      isDeleted:      false,
    };

    if (!accessCtx.isFullAccess && !accessCtx.isViewOnly && accessCtx.assignedMappingIds) {
      query.mappingId = { $in: Array.from(accessCtx.assignedMappingIds) };
    }

    if (req.query.year)      query['period.year']        = parseInt(req.query.year, 10);
    if (req.query.nodeId)    query.nodeId                 = req.query.nodeId;
    if (req.query.mappingId) query.mappingId              = req.query.mappingId;

    let entries = await EsgDataEntry.find(query)
      .populate('metricId', 'metricCode metricName primaryUnit')
      .sort({ 'period.year': 1, updatedAt: 1 });

    // Apply latestOnly: keep only the most recently approved per (mappingId, periodLabel)
    if (latestOnly) {
      const latestMap = new Map();
      for (const e of entries) {
        const key = `${e.mappingId}::${e.period?.periodLabel}`;
        latestMap.set(key, e); // later entries (sorted by updatedAt asc) overwrite earlier
      }
      entries = Array.from(latestMap.values());
    }

    return res.json({ success: true, data: { entries, total: entries.length } });
  } catch (err) {
    console.error('[completionController.getApprovedData]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── GET /:clientId/workflow-actions/:submissionId ─────────────────────────────
async function getWorkflowActions(req, res) {
  try {
    const { clientId, submissionId } = req.params;

    const actions = await EsgWorkflowAction.find({ submissionId, clientId })
      .populate('actorId', 'userName email userType')
      .sort({ createdAt: 1 });

    return res.json({ success: true, data: { submissionId, actions } });
  } catch (err) {
    console.error('[completionController.getWorkflowActions]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

module.exports = { getCompletionStats, getApprovedData, getWorkflowActions };
