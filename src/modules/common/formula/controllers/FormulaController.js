'use strict';

/**
 * FormulaController.js — Common Formula HTTP Adapter
 *
 * Thin layer: validates HTTP inputs, calls formulaService, returns responses.
 * Contains no Mongoose queries — all business logic is in formulaService.js.
 *
 * Export names are intentionally identical to the old reduction controller
 * so the route files are a drop-in replacement.
 */

const service = require('../services/formulaService');
const { resolveClientId } = require('../utils/formulaValidation');

// Roles that can write (create / update / delete)
const WRITE_ROLES = new Set(['super_admin', 'consultant_admin', 'consultant']);
// Roles that can read (includes read-only client roles)
const READ_ROLES  = new Set(['super_admin', 'consultant_admin', 'consultant', 'client_admin', 'auditor']);

function ensureWriteRole(req) {
  if (!req.user)                           return { status: 401, message: 'Unauthenticated' };
  if (!WRITE_ROLES.has(req.user.userType)) return { status: 403, message: 'Forbidden' };
  return null;
}

function ensureReadRole(req) {
  if (!req.user)                          return { status: 401, message: 'Unauthenticated' };
  if (!READ_ROLES.has(req.user.userType)) return { status: 403, message: 'Forbidden' };
  return null;
}

// ─── CREATE ───────────────────────────────────────────────────────────────────

exports.createFormula = async (req, res) => {
  try {
    const roleErr = ensureWriteRole(req);
    if (roleErr) return res.status(roleErr.status).json({ success: false, message: roleErr.message });

    const {
      name, label, description, link, unit,
      expression, variables, version,
      moduleKey, scopeType
    } = req.body;

    // Transitional: accept clientIds[] if clientId not provided
    const { clientId, deprecated } = resolveClientId(req.body);
    if (deprecated) {
      console.warn(`[DEPRECATION] /api/formulas POST: clientIds[] used by user ${req.user.id}. Please switch to clientId (string).`);
    }

    const { doc, error } = await service.createFormula({
      name, label, description, link, unit,
      expression, variables, version,
      moduleKey, scopeType, clientId,
      actor: req.user
    });

    if (error) return res.status(400).json({ success: false, message: error });
    return res.status(201).json({ success: true, data: doc });

  } catch (e) {
    return res.status(500).json({ success: false, message: 'Failed to create formula', error: e.message });
  }
};

// ─── LIST ─────────────────────────────────────────────────────────────────────

exports.listFormulas = async (req, res) => {
  try {
    const roleErr = ensureReadRole(req);
    if (roleErr) return res.status(roleErr.status).json({ success: false, message: roleErr.message });

    const { moduleKey, clientId } = req.query;

    const formulas = await service.listFormulas(req.user, { moduleKey, clientId });
    return res.status(200).json({ success: true, data: formulas });

  } catch (e) {
    return res.status(500).json({ success: false, message: 'Failed to list formulas', error: e.message });
  }
};

// ─── GET BY ID ────────────────────────────────────────────────────────────────

exports.getFormula = async (req, res) => {
  try {
    const roleErr = ensureReadRole(req);
    if (roleErr) return res.status(roleErr.status).json({ success: false, message: roleErr.message });

    const { formulaId } = req.params;
    const { doc, error, status } = await service.getFormulaById(formulaId, req.user);

    if (error) return res.status(status).json({ success: false, message: error });
    return res.status(200).json({ success: true, data: doc });

  } catch (e) {
    return res.status(500).json({ success: false, message: 'Failed to fetch formula', error: e.message });
  }
};

// ─── UPDATE ───────────────────────────────────────────────────────────────────

exports.updateFormula = async (req, res) => {
  try {
    const roleErr = ensureWriteRole(req);
    if (roleErr) return res.status(roleErr.status).json({ success: false, message: roleErr.message });

    const { formulaId } = req.params;

    // Transitional: map clientIds[0] → clientId if needed
    const { clientId } = resolveClientId(req.body);
    const updates = { ...req.body, clientId };

    const { doc, error } = await service.updateFormula(formulaId, updates, req.user);

    if (error) return res.status(400).json({ success: false, message: error });
    return res.status(200).json({ success: true, data: doc });

  } catch (e) {
    return res.status(500).json({ success: false, message: 'Failed to update formula', error: e.message });
  }
};

// ─── DELETE ───────────────────────────────────────────────────────────────────

exports.deleteFormula = async (req, res) => {
  try {
    const roleErr = ensureWriteRole(req);
    if (roleErr) return res.status(roleErr.status).json({ success: false, message: roleErr.message });

    const user          = req.user;
    const { formulaId } = req.params;

    // CONSULTANT → submit delete request
    if (user.userType === 'consultant') {
      const actor = { ...user, _reason: req.body.reason || '' };
      const { result, error, alreadyPending } = await service.requestFormulaDelete(formulaId, actor);

      if (error) return res.status(400).json({ success: false, message: error });
      if (alreadyPending) {
        return res.status(200).json({ success: true, message: 'Delete request already submitted and pending approval.' });
      }
      return res.status(200).json({ success: true, message: 'Delete request submitted to Consultant Admin / Super Admin.' });
    }

    // CONSULTANT_ADMIN / SUPER_ADMIN → delete directly
    if (user.userType === 'consultant_admin' || user.userType === 'super_admin') {
      const modeParam = ((req.params.mode || req.query.mode || '')).toString().toLowerCase();
      const isHard    = modeParam === 'hard';

      if (isHard) {
        const { error } = await service.hardDeleteFormula(formulaId, user);
        if (error) return res.status(409).json({ success: false, message: error });
        return res.status(200).json({ success: true, message: 'Formula deleted permanently (hard) by admin.' });
      } else {
        const { error } = await service.softDeleteFormula(formulaId, user);
        if (error) return res.status(404).json({ success: false, message: error });
        return res.status(200).json({ success: true, message: 'Formula deleted (soft) by admin.' });
      }
    }

    return res.status(403).json({ success: false, message: 'You are not allowed to delete formulas.' });

  } catch (e) {
    return res.status(500).json({ success: false, message: 'Failed to delete formula', error: e.message });
  }
};

// ─── DELETE REQUEST: APPROVE ──────────────────────────────────────────────────

exports.approveDeleteRequest = async (req, res) => {
  try {
    const user = req.user;
    if (!['super_admin', 'consultant_admin'].includes(user.userType)) {
      return res.status(403).json({ success: false, message: 'Only Consultant Admin / Super Admin can approve' });
    }

    const { requestId } = req.params;
    const { error } = await service.approveDeleteRequest(requestId, user);

    if (error) return res.status(404).json({ success: false, message: error });
    return res.status(200).json({ success: true, message: 'Delete request approved & formula deleted.' });

  } catch (e) {
    return res.status(500).json({ success: false, message: 'Failed to approve request', error: e.message });
  }
};

// ─── DELETE REQUEST: REJECT ───────────────────────────────────────────────────

exports.rejectDeleteRequest = async (req, res) => {
  try {
    const user = req.user;
    if (!['super_admin', 'consultant_admin'].includes(user.userType)) {
      return res.status(403).json({ success: false, message: 'Only Consultant Admin or Super Admin can reject delete requests.' });
    }

    const { requestId } = req.params;
    const { error } = await service.rejectDeleteRequest(requestId, user);

    if (error) return res.status(404).json({ success: false, message: error });
    return res.status(200).json({ success: true, message: 'Delete request rejected successfully.' });

  } catch (e) {
    return res.status(500).json({ success: false, message: 'Failed to reject delete request', error: e.message });
  }
};

// ─── DELETE REQUESTS: LIST ────────────────────────────────────────────────────

exports.getDeleteRequestedIds = async (req, res) => {
  try {
    const user = req.user;
    if (!WRITE_ROLES.has(user.userType)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const data = await service.listDeleteRequests(user, {});
    return res.status(200).json({ success: true, data });

  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

// ─── DELETE REQUESTS: FILTER ──────────────────────────────────────────────────

exports.filterDeleteRequested = async (req, res) => {
  try {
    const user = req.user;
    if (!WRITE_ROLES.has(user.userType)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const data = await service.listDeleteRequests(user, req.query);
    return res.status(200).json({ success: true, data });

  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

// ─── DELETE REQUESTS: GET BY ID ───────────────────────────────────────────────

exports.getDeleteRequestedById = async (req, res) => {
  try {
    const user = req.user;
    if (!WRITE_ROLES.has(user.userType)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const { requestId } = req.params;
    const { doc, error, status } = await service.getDeleteRequestById(requestId, user);

    if (error) return res.status(status).json({ success: false, message: error });
    return res.status(200).json({ success: true, data: doc });

  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};
