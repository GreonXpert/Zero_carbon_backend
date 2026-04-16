'use strict';

/**
 * formulaService.js — Common Formula Business Logic
 *
 * All database operations for the Formula domain live here.
 * Functions receive plain parameters (not req/res), keeping them
 * testable in isolation and reusable across modules.
 *
 * Modules supported: zero_carbon, esg_link (future: any moduleKey)
 */

const Formula       = require('../models/Formula');
const DeleteRequest = require('../models/DeleteRequest');
const User          = require('../../../../common/models/User');

const {
  validateModuleKey,
  validateScopeType,
  validateExpression,
  coerceEsgLinkLabel
} = require('../utils/formulaValidation');

const {
  notifyFormulaDeleteRequested,
  notifyFormulaDeleteApproved,
  notifyFormulaDeleteRejected
} = require('../notifications/formulaNotifications');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fetch full user document (auth middleware only attaches a partial object).
 */
async function getFullUser(userId) {
  return User.findById(userId).lean();
}

/**
 * Get all user _ids in a consultant_admin's team (includes the admin themselves).
 */
async function getTeamIds(consultantAdminId) {
  const team = await User.find({
    $or: [
      { _id: consultantAdminId },
      { consultantAdminId, userType: 'consultant' }
    ]
  }).select('_id');
  return team.map(t => String(t._id));
}

// ─── CREATE ───────────────────────────────────────────────────────────────────

/**
 * Create a new formula.
 *
 * @param {object} params
 * @param {string} params.name
 * @param {string} [params.label]
 * @param {string} [params.description]
 * @param {string} [params.link]
 * @param {string} [params.unit]
 * @param {string} params.expression
 * @param {Array}  [params.variables]
 * @param {number} [params.version]
 * @param {string} params.moduleKey   - 'zero_carbon' | 'esg_link'
 * @param {string} params.scopeType   - 'client' | 'team' | 'global'
 * @param {string} [params.clientId]  - required when scopeType='client'
 * @param {object} params.actor       - req.user
 * @returns {{ doc: object|null, error: string|null }}
 */
async function createFormula({
  name, label, description, link, unit,
  expression, variables, version,
  moduleKey, scopeType, clientId,
  actor
}) {
  // Field-level validation
  if (!name || !expression) {
    return { doc: null, error: 'name and expression are required' };
  }

  const mkErr = validateModuleKey(moduleKey);
  if (mkErr) return { doc: null, error: mkErr };

  const stErr = validateScopeType(scopeType, clientId);
  if (stErr) return { doc: null, error: stErr };

  const exprResult = validateExpression(expression);
  if (!exprResult.valid) return { doc: null, error: exprResult.error };

  // ESGLink: enforce label = name
  const resolvedLabel = coerceEsgLinkLabel(moduleKey, name, label);

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
    scopeType,
    clientId:      clientId || null,
    createdBy:     actor._id || actor.id,
    createdByRole: actor.userType || ''
  });

  return { doc, error: null };
}

// ─── LIST ─────────────────────────────────────────────────────────────────────

/**
 * List formulas based on role and optional filters.
 *
 * @param {object} user        - req.user (partial — may not have assignedClients)
 * @param {string} [moduleKey] - optional filter by module
 * @param {string} [clientId]  - optional filter by clientId (super_admin / consultant_admin only)
 * @returns {Array}
 */
async function listFormulas(user, { moduleKey, clientId } = {}) {
  const base = { isDeleted: false };
  if (moduleKey) base.moduleKey = moduleKey;
  if (clientId)  base.clientId  = clientId;

  // SUPER ADMIN → all formulas (optionally filtered)
  if (user.userType === 'super_admin') {
    return Formula.find(base).lean();
  }

  // CONSULTANT_ADMIN → formulas created by their team
  if (user.userType === 'consultant_admin') {
    const teamIds = await getTeamIds(user.id || user._id);
    return Formula.find({ ...base, createdBy: { $in: teamIds } }).lean();
  }

  // CONSULTANT → formulas for assigned clients OR created by team
  if (user.userType === 'consultant') {
    const fullUser = await getFullUser(user.id || user._id);
    if (!fullUser) return [];

    const assignedClients = fullUser.assignedClients || [];
    const teamIds = await getTeamIds(fullUser.consultantAdminId);

    const orConditions = [{ createdBy: { $in: teamIds } }];
    if (assignedClients.length > 0) {
      orConditions.push({ clientId: { $in: assignedClients } });
    }

    return Formula.find({ ...base, $or: orConditions }).lean();
  }

  // CLIENT_ADMIN / AUDITOR → read-only, own client only
  if (user.userType === 'client_admin' || user.userType === 'auditor') {
    return Formula.find({ ...base, clientId: user.clientId }).lean();
  }

  return [];
}

// ─── GET BY ID ────────────────────────────────────────────────────────────────

/**
 * Fetch a single formula by ID, with role-based access check.
 *
 * @param {string} formulaId
 * @param {object} user - req.user
 * @returns {{ doc: object|null, error: string|null, status: number }}
 */
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
    const fullUser = await getFullUser(user.id || user._id);
    if (!fullUser) return { doc: null, error: 'User not found', status: 404 };

    const assignedClients = fullUser.assignedClients || [];
    const teamIds = await getTeamIds(fullUser.consultantAdminId);

    const inTeam    = teamIds.includes(String(formula.createdBy));
    const inClients = assignedClients.includes(formula.clientId);

    if (!inTeam && !inClients) {
      return { doc: null, error: 'Access denied: formula not in your scope.', status: 403 };
    }
    return { doc: formula, error: null, status: 200 };
  }

  if (user.userType === 'client_admin' || user.userType === 'auditor') {
    if (formula.clientId !== user.clientId) {
      return { doc: null, error: 'This formula does not belong to your client.', status: 403 };
    }
    return { doc: formula, error: null, status: 200 };
  }

  return { doc: null, error: 'Forbidden', status: 403 };
}

// ─── UPDATE ───────────────────────────────────────────────────────────────────

/**
 * Update an existing formula.
 *
 * Note: clientId is now a single string — no addClientIds/removeClientIds.
 * Passing a new clientId replaces the existing one.
 *
 * @param {string} formulaId
 * @param {object} updates  - body fields
 * @param {object} actor    - req.user
 * @returns {{ doc: object|null, error: string|null }}
 */
async function updateFormula(formulaId, updates, actor) {
  const doc = await Formula.findById(formulaId);
  if (!doc || doc.isDeleted) return { doc: null, error: 'Formula not found' };

  const {
    name, label, description, link, unit,
    expression, variables, version,
    moduleKey, scopeType, clientId
  } = updates;

  // Validate expression if provided
  if (expression) {
    const exprResult = validateExpression(expression);
    if (!exprResult.valid) return { doc: null, error: exprResult.error };
  }

  // Validate moduleKey change if provided
  if (moduleKey) {
    const mkErr = validateModuleKey(moduleKey);
    if (mkErr) return { doc: null, error: mkErr };
  }

  // Validate scopeType/clientId change if provided
  const newScopeType = scopeType || doc.scopeType;
  const newClientId  = clientId !== undefined ? clientId : doc.clientId;
  const stErr = validateScopeType(newScopeType, newClientId);
  if (stErr) return { doc: null, error: stErr };

  // Apply updates
  if (name        != null) doc.name        = name;
  if (description != null) doc.description = description;
  if (expression  != null) doc.expression  = expression;
  if (link        != null) doc.link        = link;
  if (unit        != null) doc.unit        = unit;
  if (version     != null) doc.version     = version;
  if (moduleKey   != null) doc.moduleKey   = moduleKey;
  if (scopeType   != null) doc.scopeType   = scopeType;
  if (clientId    !== undefined) doc.clientId = clientId;
  if (Array.isArray(variables)) doc.variables = variables;

  // Resolve label — enforce esg_link rule after all fields are applied
  const effectiveName      = doc.name;
  const effectiveModuleKey = doc.moduleKey;
  const incomingLabel      = label !== undefined ? label : doc.label;
  doc.label = coerceEsgLinkLabel(effectiveModuleKey, effectiveName, incomingLabel);

  await doc.save();
  return { doc, error: null };
}

// ─── DELETE ───────────────────────────────────────────────────────────────────

/**
 * Consultant submits a delete request.
 * @returns {{ result: object|null, error: string|null, alreadyPending: boolean }}
 */
async function requestFormulaDelete(formulaId, actor) {
  const existing = await DeleteRequest.findOne({
    formulaId,
    requestedBy: actor.id || actor._id,
    status: 'pending'
  });

  if (existing) {
    return { result: existing, error: null, alreadyPending: true };
  }

  const reqDoc = await DeleteRequest.create({
    formulaId,
    requestedBy: actor.id || actor._id,
    reason:      actor._reason || ''
  });

  // Notify all approvers
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

/**
 * Admin soft-deletes a formula directly (no approval needed).
 * Auto-approves all pending delete requests for this formula.
 */
async function softDeleteFormula(formulaId, actor) {
  const formula = await Formula.findById(formulaId);
  if (!formula) return { error: 'Formula not found' };

  formula.isDeleted = true;
  await formula.save();

  // Auto-approve pending requests
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

/**
 * Admin hard-deletes a formula (permanent).
 * Blocked if formula is attached to any active Reduction project.
 */
async function hardDeleteFormula(formulaId, actor) {
  // Dynamic require to avoid circular deps — Reduction is a zero-carbon model
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

  // Auto-approve pending requests
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

// ─── DELETE REQUESTS ─────────────────────────────────────────────────────────

/**
 * Approve a pending delete request (soft-deletes the formula).
 */
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

/**
 * Reject a pending delete request.
 */
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

/**
 * List delete requests, filtered by role.
 */
async function listDeleteRequests(user, filters = {}) {
  let query = {};

  // Scope by role
  if (user.userType === 'consultant_admin') {
    const teamIds = await getTeamIds(user.id || user._id);
    query.requestedBy = { $in: teamIds };
  } else if (user.userType === 'consultant') {
    query.requestedBy = user.id || user._id;
  }
  // super_admin: no restriction

  // Apply optional filters
  const { status, formulaId, requestedBy, clientId, fromDate, toDate } = filters;

  if (status)      query.status    = status;
  if (formulaId)   query.formulaId = formulaId;
  if (requestedBy) query.requestedBy = requestedBy;

  if (fromDate || toDate) {
    query.createdAt = {};
    if (fromDate) query.createdAt.$gte = new Date(fromDate);
    if (toDate)   query.createdAt.$lte = new Date(toDate);
  }

  // Filter by clientId: find formula _ids for this client first
  if (clientId) {
    const formulas = await Formula.find({ clientId }).select('_id');
    query.formulaId = { $in: formulas.map(f => f._id.toString()) };
  }

  return DeleteRequest.find(query).populate('requestedBy', 'userName email').lean();
}

/**
 * Get a single delete request with role-based access check.
 */
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
