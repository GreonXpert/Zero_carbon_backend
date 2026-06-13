'use strict';

const mongoose     = require('mongoose');
const { Parser }   = require('expr-eval');
const EsgDataEntry = require('../models/EsgDataEntry');
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

  // Build variable value map from dataValues + variableConfigs defaults.
  // Case-insensitive key lookup: API payloads may send "emission" while the
  // mapping variableConfig stores varName "Emission" (or vice-versa).
  const vars = {};

  // Build a lowercase → original-key index of the dataValues Map once
  const dvLowerIndex = {};
  if (dataValues) {
    for (const [k] of dataValues.entries()) {
      dvLowerIndex[k.toLowerCase()] = k;
    }
  }

  for (const cfg of mapping.variableConfigs || []) {
    const key = cfg.varName;
    // Exact match first; fall back to case-insensitive match
    let actualKey = null;
    if (dataValues && dataValues.has(key)) {
      actualKey = key;
    } else {
      const lower = key.toLowerCase();
      if (dvLowerIndex[lower]) actualKey = dvLowerIndex[lower];
    }

    if (actualKey != null) {
      vars[key] = Number(dataValues.get(actualKey));
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

  // Guard 1: MongoDB does NOT support NaN or Infinity as Number field values.
  // typeof NaN === 'number' is true in JS, so the old `typeof result === 'number'`
  // check was insufficient and caused Mongoose to throw on entry.save().
  // Use Number.isFinite() to accept only real, finite numeric results.
  const calculatedValue = Number.isFinite(result) ? result : null;

  // Guard 2: EsgDataEntry.derivedFrom.formulaId is ObjectId — only set it when the
  // value stored in the snapshot is a valid 24-char hex ObjectId string.
  // A non-ObjectId string (e.g. a UUID or legacy custom ID) would cause a
  // Mongoose CastError on entry.save(), surfacing as an unexpected 500.
  const rawFormulaId = snap.formulaId;
  const safeFormulaId =
    rawFormulaId && mongoose.Types.ObjectId.isValid(String(rawFormulaId))
      ? rawFormulaId
      : null;

  return {
    calculatedValue,
    derivedFrom: {
      formulaId:      safeFormulaId,
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

  // ── 2a. Duplicate period check ────────────────────────────────────────────
  // Returns 409 if a non-deleted submission already exists for the same
  // clientId + nodeId + mappingId + period.periodLabel, UNLESS the caller
  // sets skipDuplicateCheck: true (user confirmed they want a new entry).
  const skipDuplicateCheck = payload.skipDuplicateCheck === true;
  if (!skipDuplicateCheck && period?.periodLabel) {
    const dup = await EsgDataEntry.findOne({
      clientId,
      nodeId,
      mappingId,
      'period.periodLabel': period.periodLabel,
      isDeleted: false,
    }).select('_id workflowStatus period').lean();

    if (dup) {
      return {
        error:  `A submission for period "${period.periodLabel}" already exists (status: ${dup.workflowStatus}).`,
        status: 409,
        code:   'DUPLICATE_PERIOD',
        existing: {
          _id:           String(dup._id),
          workflowStatus: dup.workflowStatus,
          periodLabel:   period.periodLabel,
        },
      };
    }
  }

  // ── 2b. Source type validation ────────────────────────────────────────────
  const allowedSrcTypes = mapping.allowedSourceTypes || [];
  const MANUAL_FAMILY   = ['manual', 'ocr', 'csv', 'excel'];
  let requiredSrcType   = null;
  if (MANUAL_FAMILY.includes(inputType))  requiredSrcType = 'manual';
  else if (inputType === 'api')            requiredSrcType = 'api';
  else if (inputType === 'iot')            requiredSrcType = 'iot';

  if (requiredSrcType && !allowedSrcTypes.includes(requiredSrcType)) {
    // For OCR input, also accept when 'ocr' is explicitly in allowedSourceTypes
    const ocrExplicitlyAllowed = inputType === 'ocr' && allowedSrcTypes.includes('ocr');
    if (!ocrExplicitlyAllowed) {
      return {
        error: `Source type '${inputType}' is not allowed for this mapping (allowed: ${allowedSrcTypes.join(', ') || 'none'})`,
        status: 403,
      };
    }
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

      // Persist resolved frozen/default variable values into dataValues so they
      // display correctly in the submission table — matches manual entry, which
      // already includes frozen variable values in its submitted dataValues.
      if (derivedFrom?.variableValues) {
        for (const [k, v] of Object.entries(derivedFrom.variableValues)) {
          if (!dvMap.has(k) && v != null) dvMap.set(k, v);
        }
      }
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
  const now = new Date();

  // Resolve reviewer/approver IDs from the mapping to decide whether to
  // skip the reviewer step (same logic as workflowService.transition).
  const extractId = (entry) => {
    if (!entry) return null;
    return entry._id ? entry._id.toString() : entry.toString();
  };
  const mappingReviewers = (mapping.reviewers || []).map(extractId).filter(Boolean);
  const mappingApprovers = (mapping.approvers || []).map(extractId).filter(Boolean);

  const autoSkipReviewer =
    submitImmediately &&
    mappingReviewers.length === 0 &&
    mappingApprovers.length > 0;

  const workflowStatus = submitImmediately
    ? (autoSkipReviewer ? 'under_review' : 'submitted')
    : 'draft';

  const initialApprovalDecisions = autoSkipReviewer
    ? mappingApprovers.map((approverId) => ({ approverId, approverType: 'approver', decision: 'pending' }))
    : [];

  // Guard metricId: if the value stored on the boundary mapping is not a
  // valid ObjectId, set null rather than letting Mongoose throw a CastError.
  const rawMetricId = mapping.metricId;
  const safeMetricId =
    rawMetricId && mongoose.Types.ObjectId.isValid(String(rawMetricId))
      ? rawMetricId
      : null;

  const entry = new EsgDataEntry({
    clientId,
    boundaryDocId: boundary._id,
    nodeId,
    mappingId,
    metricId:     safeMetricId,
    period:       periodData,
    submissionSource,
    inputType,
    dataValues:         dvMap,
    unitOfMeasurement:  unitOfMeasurement || '',
    calculatedValue,
    derivedFrom,
    workflowStatus,
    submittedBy:        submitImmediately ? (actor._id || actor.id) : null,
    submittedAt:        submitImmediately ? now : null,
    underReviewAt:      autoSkipReviewer ? now : null,
    approvalDecisions:  initialApprovalDecisions,
    validationResult,
    auditTrailRequired: true,
  });

  try {
    await entry.save();
  } catch (saveErr) {
    console.error('[submissionService.create] entry.save() failed:', saveErr.message, saveErr.errors || '');
    throw saveErr;
  }

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
  try {
    await thread.save();
  } catch (threadErr) {
    console.error('[submissionService.create] thread.save() failed:', threadErr.message);
    throw threadErr;
  }

  // ── 9. Workflow action record ─────────────────────────────────────────────
  try {
    await EsgWorkflowAction.create({
      submissionId: entry._id,
      clientId,
      action:       submitImmediately
        ? (autoSkipReviewer ? 'review_pass' : 'submit')
        : 'draft_saved',
      actorId:      actor._id || actor.id,
      actorType:    actor.userType,
      fromStatus:   null,
      toStatus:     workflowStatus,
      note:         options.note || null,
      createdAt:    now,
    });
  } catch (wfErr) {
    console.error('[submissionService.create] EsgWorkflowAction.create() failed:', wfErr.message);
    throw wfErr;
  }

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

  if (filters.nodeId && filters.nodeId !== 'undefined') query.nodeId = filters.nodeId;
  if (filters.mappingId)     query.mappingId = filters.mappingId;
  if (filters.workflowStatus) query.workflowStatus = filters.workflowStatus;
  if (filters.year)          query['period.year'] = Number(filters.year);
  if (filters.periodLabel)   query['period.periodLabel'] = filters.periodLabel;

  const page  = Math.max(1, parseInt(filters.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(filters.limit, 10) || 20));
  const skip  = (page - 1) * limit;

  const [docs, total] = await Promise.all([
    EsgDataEntry.find(query)
      .populate('metricId', 'metricName metricCode')
      .populate('submittedBy', 'userName email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
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
  })
    .populate('metricId', 'metricName metricCode')
    .populate('submittedBy', 'userName email');
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

    // Use formulaSnapshot presence (consistent with create()), since metricType is not
    // embedded in MetricDetailSchema and may not be available on the mapping object.
    const needsFormula = !!(mapping.formulaSnapshot?.expression);
    if (needsFormula) {
      try {
        const evalResult     = evaluateFormula(mapping, dvMap);
        doc.calculatedValue  = evalResult.calculatedValue;
        doc.derivedFrom      = evalResult.derivedFrom;

        // Persist resolved frozen/default variable values into dataValues so they
        // display correctly in the submission table (see create()).
        if (evalResult.derivedFrom?.variableValues) {
          for (const [k, v] of Object.entries(evalResult.derivedFrom.variableValues)) {
            if (!dvMap.has(k) && v != null) dvMap.set(k, v);
          }
          doc.dataValues = dvMap;
        }
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

  setImmediate(() =>
    triggerAllPeriodSummaryRefresh(doc.clientId, doc.boundaryDocId, doc.period)
  );

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

  setImmediate(() =>
    triggerAllPeriodSummaryRefresh(doc.clientId, doc.boundaryDocId, doc.period)
  );

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
