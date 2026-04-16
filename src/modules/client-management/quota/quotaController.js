// controllers/CMS/quotaController.js
// ============================================================
// Manages per-consultant-client creation quotas.
//
// EXISTING PERMISSIONS (flowchart resources):
//   GET  quota status → consultant_admin, consultant (own clients), super_admin
//   PATCH quota limits → consultant_admin (for consultants under them), super_admin
//
// NEW PERMISSIONS (userType quotas):
//   GET  userType quota  → same as above + client_admin (read-only for their own client)
//   PATCH userType quota → consultant_admin, super_admin
//   POST  userType quota reset → super_admin only
// ============================================================

'use strict';

const ConsultantClientQuota = require('./ConsultantClientQuota');
const Client                = require('../client/Client');
const User                  = require('../../../common/models/User');
const {
  getQuotaStatus,
  getUserTypeQuotaStatus,
  getUserTypeQuotaStatusFromDoc,
  USER_TYPE_TO_QUOTA_KEY,
}                           = require('./quotaService');

// ─────────────────────────────────────────────────────────────
// Allowed resource limit keys (existing LimitsSchema)
// ─────────────────────────────────────────────────────────────
const ALLOWED_LIMIT_KEYS = [
  // ZeroCarbon
  'flowchartNodes',
  'flowchartScopeDetails',
  'processNodes',
  'processScopeDetails',
  'reductionProjects',
  'transportFlows',
  'sbtiTargets',
  // ESGLink
  'esgLinkBoundaryNodes',
  'esgLinkMetrics',
  'esgLinkFormulas',
];

// ─────────────────────────────────────────────────────────────
// Allowed userType quota keys
// ─────────────────────────────────────────────────────────────
const ALLOWED_USER_TYPE_QUOTA_KEYS = [
  // ZeroCarbon
  'employeeHead', 'employee',
  // Multi-module
  'viewer', 'auditor',
  // 🆕 ESGLink
  'contributor', 'reviewer', 'approver',
];

// ─────────────────────────────────────────────────────────────
// INTERNAL HELPER: resolve + authorize consultant for a client
// ─────────────────────────────────────────────────────────────
async function resolveClientConsultant(clientId, user) {
  const client = await Client.findOne({ clientId })
    .select('stage status sandbox workflowTracking.assignedConsultantId leadInfo.assignedConsultantId leadInfo.consultantAdminId')
    .lean();
  if (!client) {
    return { error: { status: 404, message: 'Client not found' } };
  }

  // For active clients, the consultant lives in workflowTracking.
  // For sandbox/registered clients (stage === 'registered'), the consultant
  // lives in leadInfo.assignedConsultantId — fall back to that so quota
  // can be created before the client is promoted to active.
  const assignedConsultantId =
    client.workflowTracking?.assignedConsultantId ||
    client.leadInfo?.assignedConsultantId;

  if (!assignedConsultantId) {
    return {
      error: {
        status: 400,
        message: 'No consultant is currently assigned to this client.',
      },
    };
  }

  return { client, assignedConsultantId };
}

// ─────────────────────────────────────────────────────────────
// INTERNAL HELPER: verify a user can READ quotas for this client
// ─────────────────────────────────────────────────────────────
async function authorizeRead(user, clientId, assignedConsultantId) {
  const userId = (user._id || user.id).toString();

  if (user.userType === 'super_admin') return null;

  if (user.userType === 'consultant') {
    if (assignedConsultantId.toString() !== userId) {
      return 'You are not the assigned consultant for this client.';
    }
    return null;
  }

  if (user.userType === 'consultant_admin') {
    const consultant = await User.findById(assignedConsultantId)
      .select('consultantAdminId')
      .lean();
    if (!consultant || consultant.consultantAdminId?.toString() !== userId) {
      return 'The assigned consultant is not under your management.';
    }
    return null;
  }

  if (user.userType === 'client_admin') {
    if (user.clientId !== clientId) {
      return 'You can only view quotas for your own organization.';
    }
    return null;
  }

  return 'Access denied.';
}

// ─────────────────────────────────────────────────────────────
// INTERNAL HELPER: verify a user can WRITE quotas for this client
// ─────────────────────────────────────────────────────────────
async function authorizeWrite(user, assignedConsultantId) {
  if (!['super_admin', 'consultant_admin'].includes(user.userType)) {
    return 'Only Consultant Admins and Super Admins can update quotas.';
  }

  if (user.userType === 'consultant_admin') {
    const userId = (user._id || user.id).toString();
    const consultant = await User.findById(assignedConsultantId)
      .select('consultantAdminId')
      .lean();
    if (!consultant || consultant.consultantAdminId?.toString() !== userId) {
      return 'The assigned consultant is not under your management.';
    }
  }

  return null;
}

// ═════════════════════════════════════════════════════════════
// EXISTING ENDPOINTS (resource quotas — unchanged behaviour)
// ═════════════════════════════════════════════════════════════

// GET /clients/:clientId/quota
exports.getClientQuota = async (req, res) => {
  try {
    const { clientId } = req.params;
    const user         = req.user;

    const { client, assignedConsultantId, error } = await resolveClientConsultant(clientId, user);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    const authError = await authorizeRead(user, clientId, assignedConsultantId);
    if (authError) return res.status(403).json({ success: false, message: authError });

    const status = await getQuotaStatus(clientId, assignedConsultantId);

    return res.status(200).json({ success: true, data: status });
  } catch (err) {
    console.error('❌ getClientQuota error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PATCH /clients/:clientId/quota
exports.updateClientQuota = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { limits, notes } = req.body;
    const user = req.user;

    if (!['super_admin', 'consultant_admin'].includes(user.userType)) {
      return res.status(403).json({
        success: false,
        message: 'Only Consultant Admins and Super Admins can update quotas.',
      });
    }

    if (!limits || typeof limits !== 'object') {
      return res.status(400).json({ success: false, message: '`limits` must be a non-null object.' });
    }

    const invalidKeys = Object.keys(limits).filter((k) => !ALLOWED_LIMIT_KEYS.includes(k));
    if (invalidKeys.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Invalid limit keys: ${invalidKeys.join(', ')}. Allowed: ${ALLOWED_LIMIT_KEYS.join(', ')}`,
      });
    }

    for (const [key, value] of Object.entries(limits)) {
      if (value !== null && value !== undefined) {
        if (!Number.isInteger(value) || value < 0) {
          return res.status(400).json({
            success: false,
            message: `Invalid value for "${key}": must be a non-negative integer or null (unlimited). Got: ${value}`,
          });
        }
      }
    }

    const { client, assignedConsultantId, error } = await resolveClientConsultant(clientId, user);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    const authWriteError = await authorizeWrite(user, assignedConsultantId);
    if (authWriteError) return res.status(403).json({ success: false, message: authWriteError });

    const setPayload = {};
    for (const [key, value] of Object.entries(limits)) {
      setPayload[`limits.${key}`] = value ?? null;
    }
    if (notes !== undefined) setPayload.notes = notes;
    setPayload.setBy = user._id || user.id;
    setPayload.setAt = new Date();

    await ConsultantClientQuota.findOneAndUpdate(
      { clientId, consultantId: assignedConsultantId },
      { $set: setPayload },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );

    const status = await getQuotaStatus(clientId, assignedConsultantId);

    return res.status(200).json({
      success: true,
      message: 'Quota updated successfully.',
      data:    status,
    });
  } catch (err) {
    console.error('❌ updateClientQuota error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /clients/:clientId/quota/reset
exports.resetClientQuota = async (req, res) => {
  try {
    const { clientId } = req.params;
    const user = req.user;

    if (user.userType !== 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Only Super Admin can reset all quotas to unlimited.',
      });
    }

    const { client, assignedConsultantId, error } = await resolveClientConsultant(clientId, user);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    const unlimitedLimits = {};
    ALLOWED_LIMIT_KEYS.forEach((k) => { unlimitedLimits[`limits.${k}`] = null; });
    unlimitedLimits.setBy  = user._id || user.id;
    unlimitedLimits.setAt  = new Date();
    unlimitedLimits.notes  = 'Reset to unlimited by super_admin.';

    await ConsultantClientQuota.findOneAndUpdate(
      { clientId, consultantId: assignedConsultantId },
      { $set: unlimitedLimits },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.status(200).json({
      success:      true,
      message:      'All resource quotas reset to unlimited.',
      clientId,
      consultantId: assignedConsultantId.toString(),
    });
  } catch (err) {
    console.error('❌ resetClientQuota error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ═════════════════════════════════════════════════════════════
// NEW ENDPOINTS: User Type Quotas
// ═════════════════════════════════════════════════════════════

// GET /clients/:clientId/quota/user-types
exports.getUserTypeQuota = async (req, res) => {
  try {
    const { clientId } = req.params;
    const user         = req.user;

    const { assignedConsultantId, error } = await resolveClientConsultant(clientId, user);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    const authError = await authorizeRead(user, clientId, assignedConsultantId);
    if (authError) return res.status(403).json({ success: false, message: authError });

    const status = await getUserTypeQuotaStatus(clientId, assignedConsultantId);

    return res.status(200).json({ success: true, data: status });
  } catch (err) {
    console.error('❌ getUserTypeQuota error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PATCH /clients/:clientId/quota/user-types
exports.updateUserTypeQuota = async (req, res) => {
  try {
    const { clientId }                  = req.params;
    const { userTypeQuotas: body, notes } = req.body;
    const user                          = req.user;

    if (!['super_admin', 'consultant_admin'].includes(user.userType)) {
      return res.status(403).json({
        success: false,
        message: 'Only Consultant Admins and Super Admins can update user type quotas.',
      });
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({
        success: false,
        message: '`userTypeQuotas` must be a non-null object.',
      });
    }

    const invalidTypeKeys = Object.keys(body).filter(
      (k) => !ALLOWED_USER_TYPE_QUOTA_KEYS.includes(k)
    );
    if (invalidTypeKeys.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Invalid userType quota keys: ${invalidTypeKeys.join(', ')}. Allowed: ${ALLOWED_USER_TYPE_QUOTA_KEYS.join(', ')}`,
      });
    }

    const EDITABLE_ENTRY_FIELDS = ['maxCount', 'concurrentLoginLimit'];
    for (const [typeKey, entry] of Object.entries(body)) {
      if (!entry || typeof entry !== 'object') {
        return res.status(400).json({
          success: false,
          message: `Entry for "${typeKey}" must be an object with maxCount and/or concurrentLoginLimit.`,
        });
      }

      const badFields = Object.keys(entry).filter((f) => !EDITABLE_ENTRY_FIELDS.includes(f));
      if (badFields.length) {
        return res.status(400).json({
          success: false,
          message: `Unknown fields in "${typeKey}": ${badFields.join(', ')}. Allowed: ${EDITABLE_ENTRY_FIELDS.join(', ')}`,
        });
      }

      if ('maxCount' in entry) {
        const v = entry.maxCount;
        if (v !== null && v !== undefined && (!Number.isInteger(v) || v < 0)) {
          return res.status(400).json({
            success: false,
            message: `"${typeKey}.maxCount" must be a non-negative integer or null. Got: ${v}`,
          });
        }
      }

      if ('concurrentLoginLimit' in entry) {
        const v = entry.concurrentLoginLimit;
        if (v !== null && v !== undefined && (!Number.isInteger(v) || v < 0)) {
          return res.status(400).json({
            success: false,
            message: `"${typeKey}.concurrentLoginLimit" must be a non-negative integer or null. Got: ${v}`,
          });
        }
      }
    }

    const { assignedConsultantId, error } = await resolveClientConsultant(clientId, user);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    const authWriteError = await authorizeWrite(user, assignedConsultantId);
    if (authWriteError) return res.status(403).json({ success: false, message: authWriteError });

    const setPayload = {};
    for (const [typeKey, entry] of Object.entries(body)) {
      if ('maxCount' in entry) {
        setPayload[`userTypeQuotas.${typeKey}.maxCount`] = entry.maxCount ?? null;
      }
      if ('concurrentLoginLimit' in entry) {
        setPayload[`userTypeQuotas.${typeKey}.concurrentLoginLimit`] = entry.concurrentLoginLimit ?? null;
      }
    }

    if (notes !== undefined) setPayload.notes = notes;
    setPayload.setBy = user._id || user.id;
    setPayload.setAt = new Date();

    const updated = await ConsultantClientQuota.findOneAndUpdate(
      { clientId, consultantId: assignedConsultantId },
      { $set: setPayload },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );

    const status = await getUserTypeQuotaStatus(clientId, assignedConsultantId);

    return res.status(200).json({
      success: true,
      message: 'User type quotas updated successfully.',
      data:    status,
    });
  } catch (err) {
    console.error('❌ updateUserTypeQuota error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /clients/:clientId/quota/user-types/reset
// NOTE: usedCount is NOT reset — it reflects actual existing users.
exports.resetUserTypeQuota = async (req, res) => {
  try {
    const { clientId } = req.params;
    const user         = req.user;

    if (user.userType !== 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Only Super Admin can reset user type quotas.',
      });
    }

    const { assignedConsultantId, error } = await resolveClientConsultant(clientId, user);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    const setPayload = {};
    for (const key of ALLOWED_USER_TYPE_QUOTA_KEYS) {
      setPayload[`userTypeQuotas.${key}.maxCount`]             = 1;
      setPayload[`userTypeQuotas.${key}.concurrentLoginLimit`] = null;
      // usedCount is NOT reset — do not touch it
    }
    setPayload.setBy  = user._id || user.id;
    setPayload.setAt  = new Date();
    setPayload.notes  = 'User type quotas reset to defaults (maxCount=1) by super_admin.';

    await ConsultantClientQuota.findOneAndUpdate(
      { clientId, consultantId: assignedConsultantId },
      { $set: setPayload },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const status = await getUserTypeQuotaStatus(clientId, assignedConsultantId);

    return res.status(200).json({
      success: true,
      message: 'User type quotas reset to defaults (maxCount=1, concurrentLoginLimit=unlimited).',
      data:    status,
    });
  } catch (err) {
    console.error('❌ resetUserTypeQuota error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /clients/:clientId/quota/user-types/sync-counts
//
// Recalculate usedCount for all userTypes from actual DB counts.
// Useful for: initial migration, manual correction after bulk ops.
//
// FIX (Bug #5): Added isDeleted: { $ne: true } filter to correctly
//   exclude soft-deleted users. Without this, a user who was soft-deleted
//   but had isActive: false (not the expected true) could be incorrectly
//   included or excluded inconsistently.
//
// FIX (Bug #6): Added setDefaultsOnInsert: true so that if a quota doc
//   is created fresh during sync, all schema defaults (maxCount, etc.) are
//   applied — preventing undefined fields that would break enforcement logic.
// ─────────────────────────────────────────────────────────────
exports.syncUserTypeUsedCounts = async (req, res) => {
  try {
    const { clientId } = req.params;
    const user         = req.user;

    if (!['super_admin', 'consultant_admin'].includes(user.userType)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied.',
      });
    }

    const { assignedConsultantId, error } = await resolveClientConsultant(clientId, user);
    if (error) return res.status(error.status).json({ success: false, message: error.message });

    const authWriteError = await authorizeWrite(user, assignedConsultantId);
    if (authWriteError) return res.status(403).json({ success: false, message: authWriteError });

    // ── FIX Bug #5: Count only active AND non-deleted users.
    // The usedCount tracks users that are genuinely occupying a slot:
    // i.e. they were created (increment) and not yet deleted (decrement).
    // A soft-deleted user has isActive: false AND isDeleted: true.
    // Adding isDeleted: { $ne: true } makes the sync criteria consistent
    // with what the atomic usedCount actually tracks.
    const [ehCount, empCount, viewerCount, auditorCount, contributorCount, reviewerCount, approverCount] = await Promise.all([
      User.countDocuments({ clientId, userType: 'client_employee_head', isActive: true, isDeleted: { $ne: true } }),
      User.countDocuments({ clientId, userType: 'employee',             isActive: true, isDeleted: { $ne: true } }),
      User.countDocuments({ clientId, userType: 'viewer',               isActive: true, isDeleted: { $ne: true } }),
      User.countDocuments({ clientId, userType: 'auditor',              isActive: true, isDeleted: { $ne: true } }),
      // 🆕 ESGLink user types
      User.countDocuments({ clientId, userType: 'contributor',          isActive: true, isDeleted: { $ne: true } }),
      User.countDocuments({ clientId, userType: 'reviewer',             isActive: true, isDeleted: { $ne: true } }),
      User.countDocuments({ clientId, userType: 'approver',             isActive: true, isDeleted: { $ne: true } }),
    ]);

    const syncPayload = {
      'userTypeQuotas.employeeHead.usedCount':  ehCount,
      'userTypeQuotas.employee.usedCount':      empCount,
      'userTypeQuotas.viewer.usedCount':        viewerCount,
      'userTypeQuotas.auditor.usedCount':       auditorCount,
      // 🆕 ESGLink
      'userTypeQuotas.contributor.usedCount':   contributorCount,
      'userTypeQuotas.reviewer.usedCount':      reviewerCount,
      'userTypeQuotas.approver.usedCount':      approverCount,
      setBy: user._id || user.id,
      setAt: new Date(),
    };

    // ── FIX Bug #6: setDefaultsOnInsert: true ensures a freshly-created quota
    // doc (upsert path) gets all schema defaults (maxCount = 1, etc.) applied.
    // Without this, the new doc would have undefined maxCount fields, which
    // breaks the atomic guard ($lt: undefined → always matches in some drivers).
    await ConsultantClientQuota.findOneAndUpdate(
      { clientId, consultantId: assignedConsultantId },
      { $set: syncPayload },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const status = await getUserTypeQuotaStatus(clientId, assignedConsultantId);

    return res.status(200).json({
      success: true,
      message: 'usedCounts synced from live user counts.',
      synced: {
        employeeHead: ehCount,
        employee:     empCount,
        viewer:       viewerCount,
        auditor:      auditorCount,
        contributor:  contributorCount,
        reviewer:     reviewerCount,
        approver:     approverCount,
      },
      data: status,
    });
  } catch (err) {
    console.error('❌ syncUserTypeUsedCounts error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};