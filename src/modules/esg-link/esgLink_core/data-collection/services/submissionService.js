'use strict';

const { Parser } = require('expr-eval');
const EsgDataEntry     = require('../models/EsgDataEntry');
const EsgWorkflowAction = require('../models/EsgWorkflowAction');
const EsgSubmissionThread = require('../models/EsgSubmissionThread');
const EsgLinkBoundary  = require('../../boundary/models/EsgLinkBoundary');
const { logEventFireAndForget } = require('../../../../../common/services/audit/auditLogService');
const { canSubmit }    = require('../utils/submissionPermissions');
const { triggerAllPeriodSummaryRefresh, resolvePeriodFromEntry } = require('../../summary/services/summaryService');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Load the active boundary and find a mapping by its _id string.
 * Returns { boundary, node, mapping } or null.
 */
async function resolveMapping(clientId, nodeId, mappingId) {
  const boundary = await EsgLinkBoundary.findOne({
    clientId,
    isActive:  true,
    isDeleted: false,
  });
  if (!boundary) return null;

  for (const node of boundary.nodes || []) {
    if (node.id !== nodeId) continue;
    for (const mapping of node.metricsDetails || []) {
      if (mapping._id && mapping._id.toString() === mappingId) {
        return { boundary, node, mapping };
      }
    }
  }
  return null;
}

/**
 * Evaluate formula expression using expr-eval.
 * Returns { calculatedValue, derivedFrom } or throws.
 */
function evaluateFormula(mapping, dataValues) {
  const snap = mapping.formulaSnapshot;
  if (!snap || !snap.expression) return { calculatedValue: null, derivedFrom: null };

  // Build variable value map from dataValues + variableConfigs defaults
  const vars = {};
  for (const cfg of mapping.variableConfigs || []) {
    const key = cfg.varName;
    if (dataValues && dataValues.has(key)) {
      vars[key] = Number(dataValues.get(key));
    } else if (cfg.defaultValue != null) {
      vars[key] = Number(cfg.defaultValue);
    }
  }

  const parser = new Parser();
  // Override built-in constants (e.g. E = Euler's number) with user variable values
  // so that single-letter variable names like "E" resolve to the submitted value.
  for (const [k, v] of Object.entries(vars)) {
    parser.consts[k] = v;
  }
  const expr   = parser.parse(snap.expression);
  const result = expr.evaluate(vars);

  return {
    calculatedValue: typeof result === 'number' ? result : null,
    derivedFrom: {
      formulaId:      snap.formulaId,
      expression:     snap.expression,
      variableValues: vars,
    },
  };
}

/**
 * Run mapping validationRules against submitted dataValues.
 * Returns { passed, errors }.
 */
function runValidationRules(mapping, dataValues) {
  const errors = [];
  for (const rule of mapping.validationRules || []) {
    try {
      const { validationCode, config, severity } = rule;
      if (validationCode === 'min' && config?.min != null) {
        for (const [k, v] of (dataValues || new Map()).entries()) {
          if (typeof v === 'number' && v < config.min) {
            errors.push({ field: k, message: `Value ${v} is below minimum ${config.min}`, severity: severity || 'error' });
          }
        }
      }
      if (validationCode === 'max' && config?.max != null) {
        for (const [k, v] of (dataValues || new Map()).entries()) {
          if (typeof v === 'number' && v > config.max) {
            errors.push({ field: k, message: `Value ${v} exceeds maximum ${config.max}`, severity: severity || 'warning' });
          }
        }
      }
      // Additional rule types can be added here
    } catch (_) {
      // Non-blocking — validation error in rule definition should not block submission
    }
  }
  return { passed: errors.filter((e) => e.severity === 'error').length === 0, errors };
}

// ─── Service Methods ──────────────────────────────────────────────────────────

/**
 * Create a new draft (or immediately-submitted) EsgDataEntry.
 */
async function create(payload, actor, options = {}) {
  const {
    clientId,
    nodeId,
    mappingId,
    period,
    dataValues,
    unitOfMeasurement,
    inputType = 'manual',
    submissionSource = 'contributor',
    submitImmediately = false,
  } = payload;

  // ── 1. Resolve mapping from boundary ─────────────────────────────────────
  const resolved = await resolveMapping(clientId, nodeId, mappingId);
  if (!resolved) {
    return { error: 'Mapping not found in active boundary', status: 404 };
  }
  const { boundary, node, mapping } = resolved;

  // ── 2. Permission check ───────────────────────────────────────────────────
  if (!await canSubmit(actor, mapping, clientId)) {
    return { error: 'Not authorized to submit for this mapping', status: 403 };
  }

  // ── 3. Convert plain object dataValues → Map if needed ───────────────────
  const dvMap = dataValues instanceof Map
    ? dataValues
    : new Map(Object.entries(dataValues || {}));

  // ── 4. Validation rules ───────────────────────────────────────────────────
  const validationResult = runValidationRules(mapping, dvMap);

  // ── 5. Formula evaluation (on submission) ─────────────────────────────────
  // Guard: run if a formula expression is stored in the mapping snapshot.
  // (metricType is not embedded in MetricDetailSchema — use formulaSnapshot presence instead)
  let calculatedValue = null;
  let derivedFrom     = null;
  const needsFormula  = !!(mapping.formulaSnapshot?.expression);
  if (needsFormula) {
    try {
      const evalResult = evaluateFormula(mapping, dvMap);
      calculatedValue  = evalResult.calculatedValue;
      derivedFrom      = evalResult.derivedFrom;
    } catch (err) {
      validationResult.errors.push({
        field:    'formula',
        message:  `Formula evaluation error: ${err.message}`,
        severity: 'warning',
      });
    }
  }

  // ── 6. Build period snapshot ──────────────────────────────────────────────
  const periodData = {
    year:        period?.year || new Date().getFullYear(),
    periodLabel: period?.periodLabel || '',
    frequency:   mapping.frequency,
  };

  // ── 7. Create EsgDataEntry ────────────────────────────────────────────────
  const workflowStatus = submitImmediately ? 'submitted' : 'draft';
  const now            = new Date();

  const entry = new EsgDataEntry({
    clientId,
    boundaryDocId: boundary._id,
    nodeId,
    mappingId,
    metricId:     mapping.metricId,
    period:       periodData,
    submissionSource,
    inputType,
    dataValues:         dvMap,
    unitOfMeasurement:  unitOfMeasurement || '',
    calculatedValue,
    derivedFrom,
    workflowStatus,
    submittedBy:  submitImmediately ? (actor._id || actor.id) : null,
    submittedAt:  submitImmediately ? now : null,
    validationResult,
    auditTrailRequired: true,
  });

  await entry.save();

  // ── 8. Create thread + initial system_event ───────────────────────────────
  const thread = new EsgSubmissionThread({
    submissionId: entry._id,
    clientId,
    messages: [
      {
        type:       'system_event',
        authorType: 'system',
        text:       `Submission created with status: ${workflowStatus}`,
        createdAt:  now,
      },
    ],
  });
  await thread.save();

  // ── 9. Workflow action record ─────────────────────────────────────────────
  await EsgWorkflowAction.create({
    submissionId: entry._id,
    clientId,
    action:       submitImmediately ? 'submit' : 'draft_saved',
    actorId:      actor._id || actor.id,
    actorType:    actor.userType,
    fromStatus:   null,
    toStatus:     workflowStatus,
    note:         options.note || null,
    createdAt:    now,
  });

  // ── 10. Audit log ─────────────────────────────────────────────────────────
  logEventFireAndForget({
    req:           options.req,
    actor,
    module:        'esg_data_collection',
    action:        'create',
    entityType:    'EsgDataEntry',
    entityId:      entry._id.toString(),
    clientId,
    changeSummary: `ESG data entry created (${workflowStatus}) for mapping ${mappingId}`,
    metadata:      { nodeId, mappingId, workflowStatus, inputType },
  });

  // ── 11. Trigger draft summary refresh ────────────────────────────────────
  setImmediate(() => {
    try {
      const periodDef = resolvePeriodFromEntry(periodData);
      triggerAllPeriodSummaryRefresh(clientId, boundary._id, periodData);
      if (global.broadcastEsgSummaryUpdate) {
        global.broadcastEsgSummaryUpdate(clientId, boundary._id.toString(), 'reviewer_pending_refresh', {
          periodKey:  periodDef.periodKey,
          periodType: periodDef.periodType,
          periodYear: periodDef.periodYear,
        });
      }
    } catch (_) {}
  });

  return { doc: entry };
}

/**
 * List submissions for a client with role-based filtering.
 */
async function list(clientId, accessCtx, filters = {}) {
  const query = { clientId, isDeleted: false };

  if (!accessCtx.isFullAccess && !accessCtx.isViewOnly) {
    if (accessCtx.assignedMappingIds && accessCtx.assignedMappingIds.size > 0) {
      query.mappingId = { $in: Array.from(accessCtx.assignedMappingIds) };
    } else {
      return { docs: [], total: 0 };
    }
  }

  if (filters.nodeId)        query.nodeId = filters.nodeId;
  if (filters.mappingId)     query.mappingId = filters.mappingId;
  if (filters.workflowStatus) query.workflowStatus = filters.workflowStatus;
  if (filters.year)          query['period.year'] = Number(filters.year);
  if (filters.periodLabel)   query['period.periodLabel'] = filters.periodLabel;

  const page  = Math.max(1, parseInt(filters.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(filters.limit, 10) || 20));
  const skip  = (page - 1) * limit;

  const [docs, total] = await Promise.all([
    EsgDataEntry.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
    EsgDataEntry.countDocuments(query),
  ]);

  return { docs, total, page, limit };
}

/**
 * Get one submission by ID with permission check.
 */
async function getOne(submissionId, user, clientId) {
  const doc = await EsgDataEntry.findOne({
    _id:       submissionId,
    clientId,
    isDeleted: false,
  });
  if (!doc) return { error: 'Submission not found', status: 404 };
  return { doc };
}

/**
 * Update a draft submission (dataValues + unit only).
 */
async function updateDraft(submissionId, payload, actor, options = {}) {
  const doc = await EsgDataEntry.findOne({
    _id:       submissionId,
    clientId:  payload.clientId,
    isDeleted: false,
  });
  if (!doc) return { error: 'Submission not found', status: 404 };
  if (doc.workflowStatus !== 'draft') {
    return { error: 'Only draft submissions can be updated', status: 400 };
  }

  const dvMap = payload.dataValues instanceof Map
    ? payload.dataValues
    : new Map(Object.entries(payload.dataValues || {}));

  if (payload.dataValues) doc.dataValues = dvMap;
  if (payload.unitOfMeasurement != null) doc.unitOfMeasurement = payload.unitOfMeasurement;

  // Re-evaluate formula on draft update
  const resolved = await resolveMapping(doc.clientId, doc.nodeId, doc.mappingId);
  if (resolved) {
    const { mapping } = resolved;
    const validationResult = runValidationRules(mapping, dvMap);
    doc.validationResult = validationResult;

    const needsFormula = ['derived', 'intensity'].includes(mapping.metricType);
    if (needsFormula) {
      try {
        const evalResult     = evaluateFormula(mapping, dvMap);
        doc.calculatedValue  = evalResult.calculatedValue;
        doc.derivedFrom      = evalResult.derivedFrom;
      } catch (_) {}
    }
  }

  await doc.save();

  logEventFireAndForget({
    req:           options.req,
    actor,
    module:        'esg_data_collection',
    action:        'update',
    entityType:    'EsgDataEntry',
    entityId:      doc._id.toString(),
    clientId:      doc.clientId,
    changeSummary: `Draft updated for mapping ${doc.mappingId}`,
  });

  return { doc };
}

/**
 * Soft-delete a draft submission.
 */
async function softDelete(submissionId, clientId, actor, options = {}) {
  const doc = await EsgDataEntry.findOne({
    _id:       submissionId,
    clientId,
    isDeleted: false,
  });
  if (!doc) return { error: 'Submission not found', status: 404 };
  if (doc.workflowStatus !== 'draft') {
    return { error: 'Only draft submissions can be deleted', status: 400 };
  }

  doc.isDeleted = true;
  doc.deletedAt = new Date();
  doc.deletedBy = actor._id || actor.id;
  await doc.save();

  logEventFireAndForget({
    req:           options.req,
    actor,
    module:        'esg_data_collection',
    action:        'delete',
    entityType:    'EsgDataEntry',
    entityId:      doc._id.toString(),
    clientId,
    changeSummary: `Draft submission deleted`,
  });

  return { success: true };
}

module.exports = {
  create,
  list,
  getOne,
  updateDraft,
  softDelete,
  resolveMapping,
  runValidationRules,
  evaluateFormula,
};
