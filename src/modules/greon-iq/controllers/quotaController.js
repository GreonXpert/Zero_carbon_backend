'use strict';

// ============================================================================
// quotaController.js — Quota / credit wallet management endpoints
//
// GET  /api/greon-iq/quota                  — own wallet balance + stats
// GET  /api/greon-iq/usage                  — own usage summary
// GET  /api/greon-iq/quota/:userId          — view another user's wallet
// POST /api/greon-iq/quota/adjust           — manually adjust credits
// GET  /api/greon-iq/quota/transactions     — own credit transaction history
// GET  /api/greon-iq/allowed-clients        — clients this user may query
// ============================================================================

const { isGreonIQEnabled }                    = require('../services/quotaResolutionService');
const { getUsageSummary }                     = require('../services/quotaUsageService');
const { getWallet, manualAdjust, getOrCreateWallet } = require('../services/creditWalletService');
const { resolveClientScope, resolveAccessibleClients } = require('../services/clientScopeResolver');
const GreonIQCreditTransaction                = require('../models/GreonIQCreditTransaction');
const GreonIQCreditWallet                     = require('../models/GreonIQCreditWallet');
const User                                    = require('../../../common/models/User');

const ADMIN_ROLES = new Set(['super_admin', 'consultant_admin']);

// GET /api/greon-iq/quota — own wallet balance + enablement status
async function getQuota(req, res) {
  try {
    const user = req.user;
    const enabledCheck = await isGreonIQEnabled(user, user.clientId);
    const usage        = await getUsageSummary(String(user._id), user.clientId);

    return res.status(200).json({
      success:     true,
      isUnlimited: enabledCheck.isUnlimited,
      enabled:     enabledCheck.enabled,
      balance:     enabledCheck.isUnlimited ? null : (enabledCheck.balance ?? 0),
      lifetime: enabledCheck.isUnlimited ? null : {
        added: usage.lifetimeAdded,
        used:  usage.lifetimeUsed,
      },
      totalQueries: usage.totalQueries,
    });
  } catch (err) {
    console.error('[GreOnIQ] getQuota error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

// GET /api/greon-iq/usage — own usage summary
async function getUsage(req, res) {
  try {
    const usage = await getUsageSummary(String(req.user._id), req.user.clientId);
    return res.status(200).json({ success: true, usage });
  } catch (err) {
    console.error('[GreOnIQ] getUsage error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

// GET /api/greon-iq/quota/:userId — view another user's wallet (admin only)
async function getWalletByUser(req, res) {
  try {
    if (!ADMIN_ROLES.has(req.user.userType)) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN' });
    }
    const { userId } = req.params;
    const targetUser = await User.findById(userId, { userType: 1, clientId: 1 }).lean();
    if (!targetUser) {
      return res.status(404).json({ success: false, code: 'USER_NOT_FOUND' });
    }

    const enabledCheck = await isGreonIQEnabled(targetUser, targetUser.clientId);
    if (enabledCheck.isUnlimited) {
      return res.status(200).json({ success: true, isUnlimited: true, balance: null });
    }

    const wallet = await getWallet(userId);
    return res.status(200).json({
      success:       true,
      isUnlimited:   false,
      balance:       wallet?.balance       ?? 0,
      lifetimeAdded: wallet?.lifetimeAdded ?? 0,
      lifetimeUsed:  wallet?.lifetimeUsed  ?? 0,
    });
  } catch (err) {
    console.error('[GreOnIQ] getWalletByUser error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

// POST /api/greon-iq/quota/adjust — manually add or remove credits
async function adjustCredits(req, res) {
  try {
    if (!ADMIN_ROLES.has(req.user.userType)) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Only super_admin or consultant_admin can adjust credits.' });
    }

    const { targetUserId, amount, reason } = req.body;
    if (!targetUserId) {
      return res.status(400).json({ success: false, code: 'MISSING_TARGET_USER' });
    }
    if (typeof amount !== 'number' || amount === 0) {
      return res.status(400).json({ success: false, code: 'INVALID_AMOUNT', message: 'amount must be a non-zero number.' });
    }
    if (!reason || !reason.trim()) {
      return res.status(400).json({ success: false, code: 'MISSING_REASON' });
    }

    const targetUser = await User.findById(targetUserId, { userType: 1, clientId: 1 }).lean();
    if (!targetUser) {
      return res.status(404).json({ success: false, code: 'USER_NOT_FOUND' });
    }

    // Ensure wallet exists before adjusting
    await getOrCreateWallet(targetUserId, targetUser.userType, targetUser.clientId || null);

    const result = await manualAdjust(targetUserId, amount, reason.trim(), req.user._id);
    return res.status(200).json({
      success:       true,
      newBalance:    result.newBalance,
      transactionId: result.transactionId,
      amount,
      reason: reason.trim(),
    });
  } catch (err) {
    if (err.code === 'QUOTA_EXHAUSTED') {
      return res.status(400).json({
        success: false,
        code:    'INSUFFICIENT_BALANCE',
        message: err.message,
      });
    }
    console.error('[GreOnIQ] adjustCredits error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

// GET /api/greon-iq/quota/transactions — own credit transaction history
async function getTransactions(req, res) {
  try {
    const userId = String(req.user._id);
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 20);
    const skip   = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      GreonIQCreditTransaction.find({ userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      GreonIQCreditTransaction.countDocuments({ userId }),
    ]);

    return res.status(200).json({
      success: true,
      transactions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[GreOnIQ] getTransactions error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

// GET /api/greon-iq/allowed-clients — list clients this user may query
async function getAllowedClients(req, res) {
  try {
    const user = req.user;
    if (user.clientId) {
      const Client = require('../../client-management/client/Client');
      const doc = await Client.findOne(
        { clientId: user.clientId, isDeleted: { $ne: true } },
        { clientId: 1, 'leadInfo.companyName': 1 }
      ).lean();
      const result = doc
        ? [{ clientId: doc.clientId, companyName: doc.leadInfo?.companyName || doc.clientId }]
        : [{ clientId: user.clientId, companyName: user.clientId }];
      return res.status(200).json({ success: true, clients: result });
    }
    const clients = await resolveAccessibleClients(user);
    return res.status(200).json({ success: true, clients });
  } catch (err) {
    console.error('[GreOnIQ] getAllowedClients error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

// Keep legacy stubs so old route references don't crash during transition
function allocateQuota(req, res) {
  return res.status(410).json({
    success: false,
    code:    'DEPRECATED',
    message: 'Period-based quota allocation is replaced by the credit wallet system. Use POST /quota/adjust.',
  });
}
function getUserPolicy(req, res) {
  return res.status(410).json({ success: false, code: 'DEPRECATED', message: 'Use GET /quota/transactions instead.' });
}
function revokeAllocation(req, res) {
  return res.status(410).json({ success: false, code: 'DEPRECATED' });
}

module.exports = {
  getQuota,
  getUsage,
  getWalletByUser,
  adjustCredits,
  getTransactions,
  getAllowedClients,
  // Legacy stubs
  allocateQuota,
  getUserPolicy,
  revokeAllocation,
};
