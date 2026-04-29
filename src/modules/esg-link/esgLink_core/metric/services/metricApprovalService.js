'use strict';
/**
 * metricApprovalService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Business logic for the global metric approval gate.
 *
 * Exported functions:
 *   createApprovalRequest  — raise a pending approval for a global metric op
 *   executeApprovedAction  — apply the deferred change to EsgMetric
 *   getPendingApprovals    — query helper for listing approvals
 */

const EsgMetricApproval = require('../models/EsgMetricApproval');
const EsgMetric         = require('../models/EsgMetric');
const { generateMetricCode, hasDefinitionChange } = require('./metricService');

/**
 * createApprovalRequest
 * Saves a new EsgMetricApproval document after checking for duplicate pending
 * requests on the same metric+action.
 *
 * @param {object} opts
 * @param {string}  opts.actionType       - 'create'|'update'|'publish'|'retire'|'delete'
 * @param {string}  [opts.metricId]       - ObjectId string; null for 'create'
 * @param {object}  [opts.proposedPayload]- Fields to apply (full body for create, delta for update)
 * @param {object}  [opts.metricSnapshot] - Lean metric doc at request time (null for create)
 * @param {object}  opts.requestedBy      - req.user object
 * @returns {Promise<EsgMetricApproval>}
 * @throws {Error} with .code === 'DUPLICATE_PENDING' when a pending request already exists
 */
const createApprovalRequest = async ({
  actionType,
  metricId = null,
  proposedPayload = {},
  metricSnapshot = null,
  requestedBy,
}) => {
  // Check for existing pending approval on the same metric + action
  if (metricId) {
    const existing = await EsgMetricApproval.findOne({
      metricId,
      actionType,
      status: 'pending',
    });
    if (existing) {
      const err = new Error(
        `A pending approval request for action '${actionType}' on this metric already exists (approvalId: ${existing._id}). ` +
        'Wait for super_admin to review the existing request before submitting a new one.',
      );
      err.code = 'DUPLICATE_PENDING';
      err.approvalId = existing._id;
      throw err;
    }
  }

  const approval = new EsgMetricApproval({
    actionType,
    metricId:        metricId || null,
    proposedPayload,
    metricSnapshot,
    requestedBy:     requestedBy._id,
    requestedByRole: requestedBy.userType,
    status:          'pending',
  });

  await approval.save();
  return approval;
};

/**
 * executeApprovedAction
 * Applies the deferred mutation stored in an approval document to EsgMetric.
 * Called by the super_admin approve endpoint after setting approval.status = 'approved'.
 *
 * @param {EsgMetricApproval} approval   - The approval document (Mongoose doc)
 * @param {object}            reviewer   - req.user (super_admin)
 * @returns {Promise<EsgMetric|null>}    - The resulting metric doc (null for delete)
 */
const executeApprovedAction = async (approval, reviewer) => {
  const { actionType, metricId, proposedPayload } = approval;

  switch (actionType) {
    case 'create': {
      // Generate a metric code now (at approval time)
      const { esgCategory, subcategoryCode } = proposedPayload;
      const metricCode = await generateMetricCode({
        esgCategory,
        subcategoryCode,
        isGlobal: true,
        clientId: null,
      });

      const metric = new EsgMetric({
        metricCode,
        metricName:           proposedPayload.metricName,
        metricDescription:    proposedPayload.metricDescription    || null,
        esgCategory,
        subcategoryCode,
        metricType:           proposedPayload.metricType,
        isGlobal:             true,
        clientId:             null,
        primaryUnit:          proposedPayload.primaryUnit          || null,
        allowedUnits:         proposedPayload.allowedUnits         || [],
        dataType:             proposedPayload.dataType             || 'number',
        formulaId:            proposedPayload.formulaId            || null,
        publishedStatus:      'draft',
        version:              1,
        isBrsrCore:           proposedPayload.isBrsrCore           || false,
        regulatorySourceRef:  proposedPayload.regulatorySourceRef  || null,
        notesForUi:           proposedPayload.notesForUi           || null,
        createdBy:            approval.requestedBy,
        updatedBy:            reviewer._id,
      });

      await metric.save();
      return metric;
    }

    case 'update': {
      const metric = await EsgMetric.findOne({ _id: metricId, isDeleted: false });
      if (!metric) throw Object.assign(new Error('Metric not found'), { code: 'METRIC_NOT_FOUND' });

      const bumpVersion = hasDefinitionChange(proposedPayload);
      if (bumpVersion) proposedPayload.version = metric.version + 1;
      proposedPayload.updatedBy = reviewer._id;

      Object.assign(metric, proposedPayload);
      await metric.save();
      return metric;
    }

    case 'publish': {
      const metric = await EsgMetric.findOne({ _id: metricId, isDeleted: false });
      if (!metric) throw Object.assign(new Error('Metric not found'), { code: 'METRIC_NOT_FOUND' });

      metric.publishedStatus = 'published';
      metric.publishedAt     = new Date();
      metric.updatedBy       = reviewer._id;
      await metric.save();
      return metric;
    }

    case 'retire': {
      const metric = await EsgMetric.findOne({ _id: metricId, isDeleted: false });
      if (!metric) throw Object.assign(new Error('Metric not found'), { code: 'METRIC_NOT_FOUND' });

      metric.publishedStatus = 'retired';
      metric.retiredAt       = new Date();
      metric.updatedBy       = reviewer._id;
      await metric.save();
      return metric;
    }

    case 'delete': {
      const metric = await EsgMetric.findOne({ _id: metricId, isDeleted: false });
      if (!metric) throw Object.assign(new Error('Metric not found'), { code: 'METRIC_NOT_FOUND' });

      metric.isDeleted  = true;
      metric.deletedAt  = new Date();
      metric.deletedBy  = reviewer._id;
      await metric.save();
      return null;
    }

    default:
      throw new Error(`Unknown actionType: ${actionType}`);
  }
};

/**
 * getPendingApprovals
 * Flexible query helper used by the list endpoint.
 *
 * @param {object} filters
 * @param {string}  [filters.status]      - 'pending'|'approved'|'rejected' (default: 'pending')
 * @param {string}  [filters.actionType]  - filter by action
 * @param {number}  [filters.page]
 * @param {number}  [filters.limit]
 * @returns {Promise<{ total, approvals }>}
 */
const getPendingApprovals = async ({ status = 'pending', actionType, page = 1, limit = 20 } = {}) => {
  const filter = { status };
  if (actionType) filter.actionType = actionType;

  const skip = (page - 1) * limit;

  const [approvals, total] = await Promise.all([
    EsgMetricApproval.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('requestedBy', 'name email userType')
      .populate('metricId', 'metricCode metricName esgCategory publishedStatus')
      .lean(),
    EsgMetricApproval.countDocuments(filter),
  ]);

  return { total, approvals };
};

module.exports = {
  createApprovalRequest,
  executeApprovedAction,
  getPendingApprovals,
};
