'use strict';

/**
 * formulaService.js — Common Formula Business Logic
 *
 * CLIENT SCOPE RULES
 * ------------------
 * zero_carbon  →  clientIds: [String]   one formula, many clients
 * esg_link     →  clientId:  String     single client (or null if scopeType='global')
 */

const Formula       = require('../models/Formula');
const DeleteRequest = require('../models/DeleteRequest');
const User          = require('../../../../common/models/User');

const {
  validateModuleKey,
  validateScope,
  validateExpression,
  coerceEsgLinkLabel
} = require('../utils/formulaValidation');

const {
  notifyFormulaDeleteRequested,
  notifyFormulaDeleteApproved,
  notifyFormulaDeleteRejected
} = require('../notifications/formulaNotifications');

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getFullUser(userId) {
  return User.findById(userId).lean();
}

async function getTeamIds(consultantAdminId) {
  const team = await User.find({
    $or: [
      { _id: consultantAdminId },
      { consultantAdminId, userType: 'consultant' }
    ]
  }).select('_id');
  return team.map(t => String(t._id));
}

/**
 * Build the client-scope fragment of a Mongo query, split by moduleKey.
 *
 * zero_carbon : { clientIds: clientId }      — checks array membership
 * esg_link    : { $or: [{ clientId }, { scopeType:'global' }] }
 *
 * When clientId is an array (consultant's assignedClients) use $in.
 */
function clientScopeFilter(moduleKey, clientIdOrIds) {
  if (moduleKey === 'zero_carbon') {
    const ids = Array.isArray(clientIdOrIds) ? clientIdOrIds : [clientIdOrIds];
    return { clientIds: { $in: ids } };
  }
  // esg_link
  const ids = Array.isArray(clientIdOrIds) ? clientIdOrIds : [clientIdOrIds];
  return {
    $or: [
      { clientId: { $in: ids } },
      { scopeType: 'global' }
    ]
  };
}

// ─── CREATE ───────────────────────────────────────────────────────────────────

/**
 * Normalise scope fields coming from a request body.
 *
 * - Converts the string literal "null" to actual null for clientId.
 * - Defaults scopeType:
 *     zero_carbon → always 'client'
 *     esg_link    → 'client' when clientId is present, else 'global'
 */
function resolveScope(moduleKey, { scopeType, clientId, clientIds }) {
  const normalClientId =
    clientId === 'null' || clientId === '' ? null : (clientId || null);

  const normalClientIds = Array.isArray(clientIds) ? clientIds : [];

  let resolvedScopeType;
  if (moduleKey === 'zero_carbon') {
    resolvedScopeType = 'client';
  } else {
    resolvedScopeType = scopeType || (normalClientId ? 'client' : 'global');
  }

  return { scopeType: resolvedScopeType, clientId: normalClientId, clientIds: normalClientIds };
}

async function createFormula({
  name, label, description, link, unit,
  expression, variables, version,
  moduleKey, scopeType, clientId, clientIds,
  actor
}) {
  if (!name || !expression) {
    return { doc: null, error: 'name and expression are required' };
  }

  const mkErr = validateModuleKey(moduleKey);
  if (mkErr) return { doc: null, error: mkErr };

  const resolved = resolveScope(moduleKey, { scopeType, clientId, clientIds });

  const scopeErr = validateScope(moduleKey, resolved.scopeType, {
    clientId:  resolved.clientId,
    clientIds: resolved.clientIds
  });
  if (scopeErr) return { doc: null, error: scopeErr };

  const exprResult = validateExpression(expression);
  if (!exprResult.valid) return { doc: null, error: exprResult.error };

  const resolvedLabel = coerceEsgLinkLabel(moduleKey, name, label);
  const isZeroCarbon  = moduleKey === 'zero_carbon';

  const doc = await Formula.create({
    name,
    label:         resolvedLabel,
    description:   description || '',
    link:          link || '',
    unit:          unit || '',
    expression,
    variables:     variables || [],
    version:       version || 1,
    moduleKey,
    scopeType:     resolved.scopeType,
    clientIds:     isZeroCarbon ? resolved.clientIds : [],
    clientId:      isZeroCarbon ? null : resolved.clientId,
    createdBy:     actor._id || actor.id,
    createdByRole: actor.userType || ''
  });

  return { doc, error: null };
}

// ─── LIST ─────────────────────────────────────────────────────────────────────

/**
 * List formulas by role, with optional moduleKey and clientId filters.
 *
 * When moduleKey is not passed, both zero_carbon and esg_link are returned
 * using a combined scope filter.
 */
async function listFormulas(user, { moduleKey, clientId } = {}) {
  const base = { isDeleted: false };
  if (moduleKey) base.moduleKey = moduleKey;

  // ── SUPER ADMIN ────────────────────────────────────────────────────────────
  if (user.userType === 'super_admin') {
    if (clientId) {
      // Filter by client across both field conventions
      const scopeQ = moduleKey
        ? clientScopeFilter(moduleKey, clientId)
        : { $or: [{ clientIds: clientId }, { clientId }, { scopeType: 'global' }] };
      return Formula.find({ ...base, ...scopeQ }).lean();
    }
    return Formula.find(base).lean();
  }

  // ── CONSULTANT_ADMIN ───────────────────────────────────────────────────────
  if (user.userType === 'consultant_admin') {
    const teamIds = await getTeamIds(user.id || user._id);
    return Formula.find({ ...base, createdBy: { $in: teamIds } }).lean();
  }

  // ── CONSULTANT ─────────────────────────────────────────────────────────────
  if (user.userType === 'consultant') {
    const fullUser      = await getFullUser(user.id || user._id);
    if (!fullUser) return [];

    const assignedClients = fullUser.assignedClients || [];
    const teamIds         = await getTeamIds(fullUser.consultantAdminId);

    const orConditions = [{ createdBy: { $in: teamIds } }];

    if (assignedClients.length > 0) {
      if (!moduleKey || moduleKey === 'zero_carbon') {
        orConditions.push({ clientIds: { $in: assignedClients } });
      }
      if (!moduleKey || moduleKey === 'esg_link') {
        orConditions.push({ clientId: { $in: assignedClients } });
        orConditions.push({ scopeType: 'global' });
      }
    } else if (!moduleKey || moduleKey === 'esg_link') {
      orConditions.push({ scopeType: 'global' });
    }

    return Formula.find({ ...base, $or: orConditions }).lean();
  }

  // ── CLIENT_ADMIN / AUDITOR ─────────────────────────────────────────────────
  if (user.userType === 'client_admin' || user.userType === 'auditor') {
    const userClientId = user.clientId;

    if (moduleKey === 'zero_carbon') {
      return Formula.find({ ...base, clientIds: userClientId }).lean();
    }
    if (moduleKey === 'esg_link') {
      return Formula.find({
        ...base,
        $or: [{ clientId: userClientId }, { scopeType: 'global' }]
      }).lean();
    }
    // No moduleKey — return both
    return Formula.find({
      ...base,
      $or: [
        { clientIds: userClientId },
        { clientId: userClientId },
        { scopeType: 'global' }
      ]
    }).lean();
  }

  return [];
}

// ─── GET BY ID ────────────────────────────────────────────────────────────────

async function getFormulaById(formulaId, user) {
  const formula = await Formula.findById(formulaId).lean();
  if (!formula || formula.isDeleted) {
    return { doc: null, error: 'Formula not found', status: 404 };
  }

  if (user.userType === 'super_admin') {
    return { doc: formula, error: null, status: 200 };
  }

  if (user.userType === 'consultant_admin') {
    const teamIds = await getTeamIds(user.id || user._id);
    if (!teamIds.includes(String(formula.createdBy))) {
      return { doc: null, error: 'You can only view formulas created by your consultant team.', status: 403 };
    }
    return { doc: formula, error: null, status: 200 };
  }

  if (user.userType === 'consultant') {
    const fullUser      = await getFullUser(user.id || user._id);
    if (!fullUser) return { doc: null, error: 'User not found', status: 404 };

    const assignedClients = fullUser.assignedClients || [];
    const teamIds         = await getTeamIds(fullUser.consultantAdminId);

    const inTeam = teamIds.includes(String(formula.createdBy));

    // zero_carbon: check clientIds array; esg_link: check clientId or global
    const inScope = formula.moduleKey === 'zero_carbon'
      ? (formula.clientIds || []).some(id => assignedClients.includes(id))
      : (assignedClients.includes(formula.clientId) || formula.scopeType === 'global');

    if (!inTeam && !inScope) {
      return { doc: null, error: 'Access denied: formula not in your scope.', status: 403 };
    }
    return { doc: formula, error: null, status: 200 };
  }

  if (user.userType === 'client_admin' || user.userType === 'auditor') {
    const userClientId = user.clientId;

    const hasAccess = formula.moduleKey === 'zero_carbon'
      ? (formula.clientIds || []).includes(userClientId)
      : (formula.clientId === userClientId || formula.scopeType === 'global');

    if (!hasAccess) {
      return { doc: null, error: 'This formula does not belong to your client.', status: 403 };
    }
    return { doc: formula, error: null, status: 200 };
  }

  return { doc: null, error: 'Forbidden', status: 403 };
}

// ─── UPDATE ───────────────────────────────────────────────────────────────────

async function updateFormula(formulaId, updates, actor) {
  const doc = await Formula.findById(formulaId);
  if (!doc || doc.isDeleted) return { doc: null, error: 'Formula not found' };

  const {
    name, label, description, link, unit,
    expression, variables, version,
    moduleKey, scopeType, clientId, clientIds
  } = updates;

  if (expression) {
    const exprResult = validateExpression(expression);
    if (!exprResult.valid) return { doc: null, error: exprResult.error };
  }

  if (moduleKey) {
    const mkErr = validateModuleKey(moduleKey);
    if (mkErr) return { doc: null, error: mkErr };
  }

  const effectiveModuleKey = moduleKey || doc.moduleKey;

  // Use existing doc values as fallback so partial updates work
  const resolved = resolveScope(effectiveModuleKey, {
    scopeType: scopeType   || doc.scopeType,
    clientId:  clientId    !== undefined ? clientId  : doc.clientId,
    clientIds: Array.isArray(clientIds)  ? clientIds : doc.clientIds
  });

  const scopeErr = validateScope(effectiveModuleKey, resolved.scopeType, {
    clientId:  resolved.clientId,
    clientIds: resolved.clientIds
  });
  if (scopeErr) return { doc: null, error: scopeErr };

  if (name        != null) doc.name        = name;
  if (description != null) doc.description = description;
  if (expression  != null) doc.expression  = expression;
  if (link        != null) doc.link        = link;
  if (unit        != null) doc.unit        = unit;
  if (version     != null) doc.version     = version;
  if (moduleKey   != null) doc.moduleKey   = moduleKey;
  doc.scopeType = resolved.scopeType;

  if (effectiveModuleKey === 'zero_carbon') {
    doc.clientIds = resolved.clientIds;
    doc.clientId  = null;
  } else {
    doc.clientId  = resolved.clientId;
    doc.clientIds = [];
  }

  if (Array.isArray(variables)) doc.variables = variables;

  const effectiveName = doc.name;
  const incomingLabel = label !== undefined ? label : doc.label;
  doc.label = coerceEsgLinkLabel(doc.moduleKey, effectiveName, incomingLabel);

  await doc.save();
  return { doc, error: null };
}

// ─── DELETE ───────────────────────────────────────────────────────────────────

async function requestFormulaDelete(formulaId, actor) {
  const existing = await DeleteRequest.findOne({
    formulaId,
    requestedBy: actor.id || actor._id,
    status: 'pending'
  });

  if (existing) return { result: existing, error: null, alreadyPending: true };

  const reqDoc = await DeleteRequest.create({
    formulaId,
    requestedBy: actor.id || actor._id,
    reason:      actor._reason || ''
  });

  const formula   = await Formula.findById(formulaId).lean();
  const approvers = await User.find({
    userType: { $in: ['super_admin', 'consultant_admin'] },
    isActive: true
  }).select('_id');

  await notifyFormulaDeleteRequested({
    actor,
    formula,
    approverIds: approvers.map(u => u._id)
  });

  return { result: reqDoc, error: null, alreadyPending: false };
}

async function softDeleteFormula(formulaId, actor) {
  const formula = await Formula.findById(formulaId);
  if (!formula) return { error: 'Formula not found' };

  formula.isDeleted = true;
  await formula.save();

  const requests = await DeleteRequest.find({ formulaId, status: 'pending' });
  await DeleteRequest.updateMany(
    { formulaId, status: 'pending' },
    { status: 'approved', approvedBy: actor.id || actor._id, approvedAt: new Date() }
  );

  for (const request of requests) {
    await notifyFormulaDeleteApproved({ actor, formula, request });
  }

  return { error: null };
}

async function hardDeleteFormula(formulaId, actor) {
  const Reduction = require('../../../zero-carbon/reduction/models/Reduction');

  const formula = await Formula.findById(formulaId);
  if (!formula) return { error: 'Formula not found' };

  const attached = await Reduction.exists({
    isDeleted: false,
    'm2.formulaRef.formulaId': formulaId
  });

  if (attached) {
    return { error: 'Cannot hard delete: formula is attached to active reduction projects.' };
  }

  await Formula.deleteOne({ _id: formulaId });

  const requests = await DeleteRequest.find({ formulaId, status: 'pending' });
  await DeleteRequest.updateMany(
    { formulaId, status: 'pending' },
    { status: 'approved', approvedBy: actor.id || actor._id, approvedAt: new Date() }
  );

  for (const request of requests) {
    await notifyFormulaDeleteApproved({ actor, formula, request });
  }

  return { error: null };
}

// ─── DELETE REQUESTS ──────────────────────────────────────────────────────────

async function approveDeleteRequest(requestId, actor) {
  const request = await DeleteRequest.findById(requestId);
  if (!request || request.status !== 'pending') {
    return { error: 'Request not found or already processed' };
  }

  const formula = await Formula.findById(request.formulaId);
  if (!formula) return { error: 'Formula does not exist' };

  formula.isDeleted = true;
  await formula.save();

  request.status     = 'approved';
  request.approvedBy = actor.id || actor._id;
  request.approvedAt = new Date();
  await request.save();

  await notifyFormulaDeleteApproved({ actor, formula, request });
  return { error: null };
}

async function rejectDeleteRequest(requestId, actor) {
  const request = await DeleteRequest.findById(requestId)
    .populate('requestedBy', 'userName email');

  if (!request) return { error: 'Delete request not found.' };
  if (request.status !== 'pending') return { error: 'This request is already processed.' };

  const formula = await Formula.findById(request.formulaId).lean();
  if (!formula) return { error: 'Formula does not exist anymore' };

  request.status     = 'rejected';
  request.approvedBy = actor.id || actor._id;
  request.approvedAt = new Date();
  await request.save();

  await notifyFormulaDeleteRejected({ actor, formula, request });
  return { error: null };
}

async function listDeleteRequests(user, filters = {}) {
  let query = {};

  if (user.userType === 'consultant_admin') {
    const teamIds = await getTeamIds(user.id || user._id);
    query.requestedBy = { $in: teamIds };
  } else if (user.userType === 'consultant') {
    query.requestedBy = user.id || user._id;
  }

  const { status, formulaId, requestedBy, clientId, fromDate, toDate } = filters;

  if (status)      query.status    = status;
  if (formulaId)   query.formulaId = formulaId;
  if (requestedBy) query.requestedBy = requestedBy;

  if (fromDate || toDate) {
    query.createdAt = {};
    if (fromDate) query.createdAt.$gte = new Date(fromDate);
    if (toDate)   query.createdAt.$lte = new Date(toDate);
  }

  if (clientId) {
    const formulas = await Formula.find({
      $or: [{ clientIds: clientId }, { clientId }]
    }).select('_id');
    query.formulaId = { $in: formulas.map(f => f._id.toString()) };
  }

  return DeleteRequest.find(query).populate('requestedBy', 'userName email').lean();
}

async function getDeleteRequestById(requestId, user) {
  const request = await DeleteRequest.findById(requestId)
    .populate('requestedBy', 'userName email')
    .lean();

  if (!request) return { doc: null, error: 'Not found', status: 404 };

  if (user.userType === 'super_admin') {
    return { doc: request, error: null, status: 200 };
  }

  if (user.userType === 'consultant_admin') {
    const teamIds = await getTeamIds(user.id || user._id);
    const requestedById = request.requestedBy?._id
      ? String(request.requestedBy._id)
      : String(request.requestedBy);
    if (!teamIds.includes(requestedById)) {
      return { doc: null, error: 'Not your team request', status: 403 };
    }
    return { doc: request, error: null, status: 200 };
  }

  if (user.userType === 'consultant') {
    const requestedById = request.requestedBy?._id
      ? String(request.requestedBy._id)
      : String(request.requestedBy);
    if (requestedById !== String(user.id || user._id)) {
      return { doc: null, error: 'Forbidden', status: 403 };
    }
    return { doc: request, error: null, status: 200 };
  }

  return { doc: null, error: 'Forbidden', status: 403 };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  createFormula,
  listFormulas,
  getFormulaById,
  updateFormula,
  requestFormulaDelete,
  softDeleteFormula,
  hardDeleteFormula,
  approveDeleteRequest,
  rejectDeleteRequest,
  listDeleteRequests,
  getDeleteRequestById
};
