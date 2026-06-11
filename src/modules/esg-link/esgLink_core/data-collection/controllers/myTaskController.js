'use strict';

/**
 * myTaskController.js
 *
 * Provides role-aware "My Tasks" metric card data for the ESGLink data
 * collection module.  Used by the frontend My Tasks page to populate metric
 * cards for contributors, reviewers, and approvers without requiring multiple
 * separate round-trips.
 *
 * Endpoints
 *   GET /:clientId/my-task-metrics           → getMyTaskMetrics
 *   GET /:clientId/mappings/:mappingId/stats  → getMetricStats
 */

const EsgLinkBoundary     = require('../../boundary/models/EsgLinkBoundary');
const EsgDataEntry        = require('../models/EsgDataEntry');
const EsgSubmissionThread = require('../models/EsgSubmissionThread');

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Returns the active (non-deleted) boundary document for a client. */
async function _getActiveBoundary(clientId) {
  return EsgLinkBoundary.findOne({ clientId, isActive: true, isDeleted: false });
}

/**
 * For an array of EsgDataEntry documents and a userId string, compute the
 * unread comment count across all their threads.
 *
 * unread = messages whose createdAt > lastReadAt[userId] && !isDeleted
 */
async function _computeUnread(submissionIds, userId) {
  if (!submissionIds.length) return 0;

  const threads = await EsgSubmissionThread.find(
    { submissionId: { $in: submissionIds } },
    { messages: 1, lastReadAt: 1 }
  ).lean();

  let total = 0;
  for (const thread of threads) {
    // lastReadAt is a Map — lean() converts it to a plain object
    const readAt = thread.lastReadAt?.[userId] || null;
    for (const msg of thread.messages || []) {
      if (msg.isDeleted) continue;
      if (!readAt || msg.createdAt > readAt) total++;
    }
  }
  return total;
}

/**
 * Build status-count object from an array of EsgDataEntry docs.
 * Returns { total, draft, submitted, under_review, clarification_requested,
 *           resubmitted, approved, rejected }
 */
function _buildStats(entries) {
  const counts = {
    total: entries.length,
    draft: 0,
    submitted: 0,
    under_review: 0,
    clarification_requested: 0,
    resubmitted: 0,
    approved: 0,
    rejected: 0,
  };
  for (const e of entries) {
    const s = e.workflowStatus;
    if (counts[s] !== undefined) counts[s]++;
  }
  return counts;
}

// ─── GET /:clientId/my-task-metrics ─────────────────────────────────────────

/**
 * Returns an enriched list of metric mappings the current user is assigned to
 * (as contributor, reviewer, or approver), augmented with:
 *   - per-mapping submission stats
 *   - latest submission summary
 *   - unread comment count
 *
 * Query params:
 *   year  (optional)  – filter stats to a specific year (e.g. 2026)
 */
async function getMyTaskMetrics(req, res) {
  try {
    const { clientId } = req.params;
    const { year }     = req.query;
    const userId       = String(req.user._id || req.user.id);
    const userRole     = req.user.userType || req.user.role || '';

    // Only contributor / reviewer / approver use this endpoint.
    // Consultant-family roles have their own client-level views.
    const allowedRoles = ['contributor', 'reviewer', 'approver', 'super_admin', 'consultant', 'consultant_admin', 'client_admin'];
    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const boundary = await _getActiveBoundary(clientId);
    if (!boundary) {
      return res.status(404).json({ success: false, message: 'No active boundary found' });
    }

    // ── Build the list of metric assignments for this user ──────────────────
    const assignments = [];

    for (const node of boundary.nodes || []) {
      for (const mapping of node.metricsDetails || []) {
        const isContributor = (mapping.contributors || []).some(id => String(id) === userId);
        const isReviewer    = (mapping.reviewers    || []).some(id => String(id) === userId) ||
                              (mapping.inheritNodeReviewers && (node.nodeReviewerIds || []).some(id => String(id) === userId));
        const isApprover    = (mapping.approvers    || []).some(id => String(id) === userId) ||
                              (mapping.inheritNodeApprovers && (node.nodeApproverIds || []).some(id => String(id) === userId));

        // Super admin / consultant family can see everything
        const isAdminRole = ['super_admin', 'consultant', 'consultant_admin', 'client_admin'].includes(userRole);

        if (!isAdminRole && !isContributor && !isReviewer && !isApprover) continue;

        let assignedRole = isContributor ? 'contributor' : (isReviewer ? 'reviewer' : 'approver');
        if (isAdminRole) assignedRole = userRole;

        assignments.push({
          nodeId:    node.id,
          nodeName:  node.label || node.details?.name || node.id,
          role:      assignedRole,
          mapping,
        });
      }
    }

    if (!assignments.length) {
      return res.json({ success: true, data: [] });
    }

    // ── Fetch all submissions for these mappings ────────────────────────────
    const mappingIds = assignments.map(a => String(a.mapping._id));

    const submissionQuery = {
      clientId,
      mappingId: { $in: mappingIds },
      isDeleted: false,
    };
    if (year) submissionQuery['period.year'] = Number(year);

    const allEntries = await EsgDataEntry.find(submissionQuery, {
      _id: 1, mappingId: 1, workflowStatus: 1, period: 1,
      submittedAt: 1, calculatedValue: 1, evidence: 1, createdAt: 1,
    }).sort({ createdAt: -1 }).lean();

    // Group entries by mappingId
    const entriesByMapping = {};
    for (const e of allEntries) {
      const mid = String(e.mappingId);
      if (!entriesByMapping[mid]) entriesByMapping[mid] = [];
      entriesByMapping[mid].push(e);
    }

    // ── Compute unread counts ──────────────────────────────────────────────
    const allSubmissionIds = allEntries.map(e => e._id);
    const threads = await EsgSubmissionThread.find(
      { submissionId: { $in: allSubmissionIds } },
      { submissionId: 1, messages: 1, lastReadAt: 1 }
    ).lean();

    // Map submissionId → unread count for this user
    const unreadBySubmission = {};
    for (const thread of threads) {
      const sid  = String(thread.submissionId);
      const readAt = thread.lastReadAt?.[userId] || null;
      let count = 0;
      for (const msg of thread.messages || []) {
        if (msg.isDeleted) continue;
        if (!readAt || msg.createdAt > readAt) count++;
      }
      unreadBySubmission[sid] = count;
    }

    // ── Build response items ───────────────────────────────────────────────
    const data = assignments.map(({ nodeId, nodeName, role, mapping }) => {
      const mid     = String(mapping._id);
      const entries = entriesByMapping[mid] || [];

      const stats   = _buildStats(entries);
      const latest  = entries[0] || null; // already sorted by createdAt desc

      const unreadComments = entries.reduce((sum, e) => {
        return sum + (unreadBySubmission[String(e._id)] || 0);
      }, 0);

      return {
        nodeId,
        nodeName,
        mappingId:          mid,
        metricId:           String(mapping.metricId || ''),
        metricName:         mapping.metricName    || '',
        metricCode:         mapping.metricCode    || '',
        metricType:         mapping.metricType    || '',
        frequency:          mapping.frequency     || 'monthly',
        mappingStatus:      mapping.mappingStatus || '',
        defaultSourceType:  mapping.defaultSourceType  || 'manual',
        allowedSourceTypes: mapping.allowedSourceTypes || ['manual'],
        evidenceRequirement: mapping.evidenceRequirement || 'none',
        evidenceTypeNote:   mapping.evidenceTypeNote   || '',
        formulaSnapshot:    mapping.formulaSnapshot    || null,
        variableConfigs:    mapping.variableConfigs    || [],
        assignedRole:       role,
        latestSubmission:   latest ? {
          _id:            String(latest._id),
          workflowStatus: latest.workflowStatus,
          period:         latest.period,
          submittedAt:    latest.submittedAt,
          calculatedValue: latest.calculatedValue,
        } : null,
        stats,
        unreadComments,
      };
    });

    return res.json({ success: true, data });
  } catch (err) {
    console.error('[myTaskController.getMyTaskMetrics]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ─── GET /:clientId/mappings/:mappingId/stats ────────────────────────────────

/**
 * Returns per-status submission counts for a single metric mapping.
 * Used by the MetricDetailPage top stats bar.
 *
 * Query params:
 *   year    (optional)
 *   nodeId  (optional, for documentation purposes — mappingId is already unique)
 */
async function getMetricStats(req, res) {
  try {
    const { clientId, mappingId } = req.params;
    const { year, nodeId } = req.query;
    const userId = String(req.user._id || req.user.id);

    const query = { clientId, mappingId, isDeleted: false };
    if (year)                             query['period.year'] = Number(year);
    if (nodeId && nodeId !== 'undefined') query.nodeId = nodeId;

    const entries = await EsgDataEntry.find(query, {
      _id: 1, workflowStatus: 1, evidence: 1, createdAt: 1,
    }).lean();

    const stats = _buildStats(entries);

    // Count submissions where evidence is missing but required
    // (we check evidenceRequirement via the boundary mapping)
    let evidenceMissing = 0;
    const boundary = await _getActiveBoundary(clientId);
    if (boundary) {
      for (const node of boundary.nodes || []) {
        const mapping = (node.metricsDetails || []).find(m => String(m._id) === mappingId);
        if (mapping && mapping.evidenceRequirement === 'required') {
          evidenceMissing = entries.filter(e => !e.evidence || e.evidence.length === 0).length;
          break;
        }
      }
    }

    // Compute unread comments across all submissions for this mapping
    const submissionIds = entries.map(e => e._id);
    const unreadComments = await _computeUnread(submissionIds, userId);

    return res.json({
      success: true,
      data: { ...stats, evidenceMissing, unreadComments },
    });
  } catch (err) {
    console.error('[myTaskController.getMetricStats]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

module.exports = { getMyTaskMetrics, getMetricStats };
