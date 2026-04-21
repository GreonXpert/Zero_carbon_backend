'use strict';

// ============================================================================
// quotaController.js — Quota management endpoints
//
// GET  /api/greon-iq/quota                — own effective quota + usage
// GET  /api/greon-iq/usage               — own usage breakdown
// POST /api/greon-iq/quota/allocate      — allocate to subordinate user
// GET  /api/greon-iq/quota/user-policy   — list allocations by this allocator
// ============================================================================

const { isGreonIQEnabled }           = require('../services/quotaResolutionService');
const { getUsageSummary }            = require('../services/quotaUsageService');
const { allocate, revoke, update, listByAllocator, getAllocationForUser } = require('../services/quotaAllocationService');
const { resolveClientScope }         = require('../services/clientScopeResolver');

const ALLOCATOR_ROLES = new Set(['super_admin', 'consultant_admin', 'consultant', 'client_admin']);

// GET /api/greon-iq/quota — own effective quota + current usage
async function getQuota(req, res) {
  try {
    const user = req.user;
    const scopeResult = await resolveClientScope(user, req.query.clientId);
    if (scopeResult.error) {
      return res.status(400).json({ success: false, code: scopeResult.code, message: scopeResult.error });
    }
    const { clientId } = scopeResult;

    const [enabledCheck, usage] = await Promise.all([
      isGreonIQEnabled(user, clientId),
      getUsageSummary(String(user._id), String(clientId)),
    ]);

    return res.status(200).json({
      success: true,
      clientId,
      enabled:      enabledCheck.enabled,
      isUnlimited:  enabledCheck.isUnlimited,
      limits: {
        monthly: enabledCheck.monthlyLimit,
        weekly:  enabledCheck.weeklyLimit,
        daily:   enabledCheck.dailyLimit,
      },
      usage: {
        monthly: usage.monthly,
        weekly:  usage.weekly,
        daily:   usage.daily,
      },
      remaining: enabledCheck.isUnlimited ? null : {
        monthly: Math.max(0, (enabledCheck.monthlyLimit || 0) - usage.monthly),
        weekly:  Math.max(0, (enabledCheck.weeklyLimit  || 0) - usage.weekly),
        daily:   Math.max(0, (enabledCheck.dailyLimit   || 0) - usage.daily),
      },
    });
  } catch (err) {
    console.error('[GreOnIQ] getQuota error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

// GET /api/greon-iq/usage — own usage breakdown
async function getUsage(req, res) {
  try {
    const user = req.user;
    const scopeResult = await resolveClientScope(user, req.query.clientId);
    if (scopeResult.error) {
      return res.status(400).json({ success: false, code: scopeResult.code, message: scopeResult.error });
    }
    const usage = await getUsageSummary(String(user._id), String(scopeResult.clientId));
    return res.status(200).json({ success: true, clientId: scopeResult.clientId, usage });
  } catch (err) {
    console.error('[GreOnIQ] getUsage error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

// POST /api/greon-iq/quota/allocate — allocate credits to a user
async function allocateQuota(req, res) {
  try {
    const user = req.user;
    if (!ALLOCATOR_ROLES.has(user.userType)) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Your role cannot allocate GreOn IQ credits.' });
    }

    const result = await allocate(user, req.body);
    if (result.error) {
      const status = result.code === 'FORBIDDEN' ? 403 : 400;
      return res.status(status).json({ success: false, ...result });
    }
    return res.status(201).json({ success: true, allocation: result.allocation });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        code:    'CONFLICT',
        message: 'An active allocation already exists for this user and client. Revoke it first or update the existing one.',
      });
    }
    console.error('[GreOnIQ] allocateQuota error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

// GET /api/greon-iq/quota/user-policy — list allocations by allocator
async function getUserPolicy(req, res) {
  try {
    const user = req.user;
    if (!ALLOCATOR_ROLES.has(user.userType)) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN' });
    }
    const clientId     = req.query.clientId || null;
    const allocations  = await listByAllocator(user._id, clientId);
    return res.status(200).json({ success: true, allocations });
  } catch (err) {
    console.error('[GreOnIQ] getUserPolicy error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

// DELETE /api/greon-iq/quota/allocate/:targetUserId — revoke allocation
async function revokeAllocation(req, res) {
  try {
    const user = req.user;
    if (!ALLOCATOR_ROLES.has(user.userType)) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN' });
    }
    const { targetUserId } = req.params;
    const { clientId }     = req.body;
    if (!clientId) {
      return res.status(400).json({ success: false, code: 'MISSING_CLIENT_ID' });
    }
    await revoke(targetUserId, clientId);
    return res.status(200).json({ success: true, message: 'Allocation revoked.' });
  } catch (err) {
    console.error('[GreOnIQ] revokeAllocation error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

module.exports = { getQuota, getUsage, allocateQuota, getUserPolicy, revokeAllocation };
