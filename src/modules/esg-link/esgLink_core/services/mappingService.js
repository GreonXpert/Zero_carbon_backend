'use strict';
/**
 * mappingService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Service helpers for ESGLink Core Step 3 — Metric Mapping.
 *
 * Exported functions:
 *   buildFormulaSnapshot(formulaId)          → captures formula at assignment time
 *   buildMappingEntry(payload, actor, metric) → assembles a new MetricDetailSchema entry
 *   hasMeaningfulChange(updatePayload)        → returns true if version should bump
 *   appendVersionHistory(mapping, actor, summary) → bumps version + appends history
 *   resolveEffectiveReviewers(mapping, node)  → applies inheritNodeReviewers logic
 *   resolveEffectiveApprovers(mapping, node)  → applies inheritNodeApprovers logic
 *   validateAssignees(userIds, clientId, User) → checks consultant + assigned context
 */

const mongoose = require('mongoose');

// Fields whose change triggers a mappingVersion increment
const VERSION_BUMP_FIELDS = [
  'frequency',
  'boundaryScope',
  'rollUpBehavior',
  'allowedSourceTypes',
  'defaultSourceType',
  'variableConfigs',
  'validationRules',
  'evidenceRequirement',
  'evidenceTypeNote',
  'contributors',
  'reviewers',
  'approvers',
  'inheritNodeReviewers',
  'inheritNodeApprovers',
  'zeroCarbonReference',
  'zeroCarbonLink',
];

/**
 * buildFormulaSnapshot
 * Fetches formula from DB and returns snapshot fields for mapping storage.
 * Used when metricType is 'derived' or 'intensity'.
 *
 * @param {string|ObjectId} formulaId
 * @param {Model} FormulaModel  - pass-in to avoid circular requires
 * @returns {{ formulaVersionAtAssignment: number, formulaSnapshot: object }}
 */
const buildFormulaSnapshot = async (formulaId, FormulaModel) => {
  if (!formulaId) return { formulaVersionAtAssignment: null, formulaSnapshot: null };

  const formula = await FormulaModel.findOne({
    _id: formulaId,
    isDeleted: { $ne: true },
  }).select('_id name expression variables version').lean();

  if (!formula) throw new Error('Formula not found or deleted');

  return {
    formulaVersionAtAssignment: formula.version || 1,
    formulaSnapshot: {
      formulaId:  formula._id,
      name:       formula.name,
      expression: formula.expression,
      variables:  (formula.variables || []).map(v => ({
        name:  v.name,
        label: v.label || '',
        unit:  v.unit  || '',
      })),
    },
  };
};

/**
 * buildMappingEntry
 * Assembles a new metricsDetails entry from request payload + backend stamps.
 * Sets auditTrailRequired: true always.
 * Sets validationRuleId: null inside each validationRules entry.
 *
 * @param {object} payload   - req.body (caller-supplied fields)
 * @param {object} actor     - req.user
 * @param {object} metric    - EsgMetric document (lean)
 * @param {object} formulaSnap - result of buildFormulaSnapshot (or nulls)
 * @returns {object}  ready-to-push MetricDetailSchema entry
 */
const buildMappingEntry = (payload, actor, metric, formulaSnap = {}) => {
  const now = new Date();

  // Sanitise validationRules — always null validationRuleId
  const validationRules = (payload.validationRules || []).map(rule => ({
    validationRuleId:    null,
    validationRuleName:  rule.validationRuleName  || '',
    validationCode:      rule.validationCode      || '',
    thresholdLogic:      rule.thresholdLogic      || '',
    anomalyFlagBehavior: rule.anomalyFlagBehavior || '',
    missingDataBehavior: rule.missingDataBehavior || '',
    config:              rule.config              || {},
    severity:            rule.severity            || 'info',
  }));

  return {
    metricId:   metric._id,
    metricCode: metric.metricCode || '',
    metricName: metric.metricName || '',

    mappingStatus: payload.mappingStatus || 'draft',

    // §2.3
    frequency:          payload.frequency          || '',
    boundaryScope:      payload.boundaryScope      || '',
    rollUpBehavior:     payload.rollUpBehavior     || '',
    reportingLevelNote: payload.reportingLevelNote || '',

    // §2.4
    allowedSourceTypes:    payload.allowedSourceTypes    || [],
    defaultSourceType:     payload.defaultSourceType     || null,
    zeroCarbonReference:   payload.zeroCarbonReference   || false,
    zeroCarbonLink:        payload.zeroCarbonLink        || {},
    ingestionInstructions: payload.ingestionInstructions || '',

    // §2.5 — backend-filled
    formulaVersionAtAssignment: formulaSnap.formulaVersionAtAssignment || null,
    formulaSnapshot:            formulaSnap.formulaSnapshot            || null,
    variableConfigs:            payload.variableConfigs                || [],

    // §2.6
    validationRules,

    // §2.7
    evidenceRequirement: payload.evidenceRequirement || 'none',
    evidenceTypeNote:    payload.evidenceTypeNote    || '',
    auditTrailRequired:  true,   // always hardcoded

    // §2.8
    contributors:         payload.contributors         || [],
    reviewers:            payload.reviewers             || [],
    approvers:            payload.approvers             || [],
    inheritNodeReviewers: payload.inheritNodeReviewers !== false,
    inheritNodeApprovers: payload.inheritNodeApprovers !== false,
    approvalLevel:        payload.approvalLevel         || 'single',

    // §2.10 — backend-stamped
    createdBy:      actor._id,
    createdAt:      now,
    updatedBy:      actor._id,
    updatedAt:      now,
    mappingVersion: 1,
    versionHistory: [],
  };
};

/**
 * hasMeaningfulChange
 * Returns true if any VERSION_BUMP_FIELDS key is present in the update payload.
 *
 * @param {object} updatePayload
 * @returns {boolean}
 */
const hasMeaningfulChange = (updatePayload) => {
  return VERSION_BUMP_FIELDS.some(field =>
    Object.prototype.hasOwnProperty.call(updatePayload, field)
  );
};

/**
 * appendVersionHistory
 * Saves current state to versionHistory then increments mappingVersion.
 * Must be called BEFORE applying the update to the mapping object.
 *
 * @param {object} mapping      - the metricsDetails entry (mutable)
 * @param {object} actor        - req.user
 * @param {string} changeSummary
 */
const appendVersionHistory = (mapping, actor, changeSummary) => {
  // Snapshot current state before increment
  const snapshot = {
    mappingVersion:            mapping.mappingVersion,
    mappingStatus:             mapping.mappingStatus,
    frequency:                 mapping.frequency,
    boundaryScope:             mapping.boundaryScope,
    rollUpBehavior:            mapping.rollUpBehavior,
    allowedSourceTypes:        mapping.allowedSourceTypes,
    defaultSourceType:         mapping.defaultSourceType,
    zeroCarbonReference:       mapping.zeroCarbonReference,
    variableConfigs:           mapping.variableConfigs,
    validationRules:           mapping.validationRules,
    evidenceRequirement:       mapping.evidenceRequirement,
    contributors:              mapping.contributors,
    reviewers:                 mapping.reviewers,
    approvers:                 mapping.approvers,
    inheritNodeReviewers:      mapping.inheritNodeReviewers,
    inheritNodeApprovers:      mapping.inheritNodeApprovers,
  };

  mapping.versionHistory.push({
    mappingVersion: mapping.mappingVersion,
    changedBy:      actor._id,
    changedAt:      new Date(),
    changeSummary,
    snapshot,
  });

  mapping.mappingVersion = (mapping.mappingVersion || 1) + 1;
};

/**
 * resolveEffectiveReviewers
 * Returns the effective reviewer list after applying inheritance.
 *
 * @param {object} mapping - metricsDetails entry
 * @param {object} node    - BoundaryNodeSchema entry
 * @returns {Array<ObjectId>}
 */
const resolveEffectiveReviewers = (mapping, node) => {
  if (mapping.inheritNodeReviewers) return node.nodeReviewerIds || [];
  return mapping.reviewers || [];
};

/**
 * resolveEffectiveApprovers
 * Returns the effective approver list after applying inheritance.
 *
 * @param {object} mapping - metricsDetails entry
 * @param {object} node    - BoundaryNodeSchema entry
 * @returns {Array<ObjectId>}
 */
const resolveEffectiveApprovers = (mapping, node) => {
  if (mapping.inheritNodeApprovers) return node.nodeApproverIds || [];
  return mapping.approvers || [];
};

/**
 * validateAssignees
 * Checks that all provided user IDs are:
 *   1. Valid ObjectIds
 *   2. Exist in DB with userType 'consultant'
 *   3. Are assigned to the given clientId (via consultantInfo.assignedClients)
 *
 * Returns { valid: true } or { valid: false, message: string }
 *
 * @param {string[]} userIds   - array of user id strings
 * @param {string}   clientId
 * @param {Model}    UserModel - pass-in to avoid circular requires
 */
const validateAssignees = async (userIds, clientId, UserModel) => {
  if (!userIds || userIds.length === 0) return { valid: true };

  for (const id of userIds) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return { valid: false, message: `Invalid user ID: ${id}` };
    }
  }

  const users = await UserModel.find({
    _id: { $in: userIds },
    userType: 'consultant',
    isDeleted: { $ne: true },
  }).select('_id userType consultantInfo').lean();

  if (users.length !== userIds.length) {
    return {
      valid: false,
      message: 'One or more assignee IDs not found or not of type consultant',
    };
  }

  // Check each consultant is assigned to this client
  for (const u of users) {
    const assignedClients = u.assignedClients || [];
    const isAssigned = assignedClients.some(c => String(c) === String(clientId));
    if (!isAssigned) {
      return {
        valid: false,
        message: `User ${u._id} is not assigned to client ${clientId}`,
      };
    }
  }

  return { valid: true };
};

module.exports = {
  buildFormulaSnapshot,
  buildMappingEntry,
  hasMeaningfulChange,
  appendVersionHistory,
  resolveEffectiveReviewers,
  resolveEffectiveApprovers,
  validateAssignees,
};
