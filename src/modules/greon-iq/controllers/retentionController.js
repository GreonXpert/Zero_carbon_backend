'use strict';

// ============================================================================
// retentionController.js — Chat retention settings
//
// GET  /api/greon-iq/retention         — view current limit + session count
// PATCH /api/greon-iq/retention        — update chatRetentionLimit for a user
// ============================================================================

const { getChatRetentionLimit }  = require('../services/quotaResolutionService');
const { update, getAllocationForUser } = require('../services/quotaAllocationService');
const ChatSession                = require('../models/ChatSession');

const ADMIN_ROLES = new Set(['consultant_admin', 'consultant', 'client_admin']);

// GET /api/greon-iq/retention
async function getRetention(req, res) {
  try {
    const user     = req.user;
    const clientId = user.clientId || req.query.clientId;
    if (!clientId) {
      return res.status(400).json({ success: false, code: 'MISSING_CLIENT_ID' });
    }

    const [limit, sessionCount] = await Promise.all([
      getChatRetentionLimit(user, clientId),
      ChatSession.countDocuments({ userId: user._id, clientId }),
    ]);

    return res.status(200).json({
      success: true,
      chatRetentionLimit: limit,
      currentSessionCount: sessionCount,
      remainingSlots: Math.max(0, limit - sessionCount),
    });
  } catch (err) {
    console.error('[GreOnIQ] getRetention error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

// PATCH /api/greon-iq/retention
async function updateRetention(req, res) {
  try {
    const user = req.user;
    if (!ADMIN_ROLES.has(user.userType)) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Only admins can update retention limits.' });
    }

    const { targetUserId, clientId, chatRetentionLimit } = req.body;
    if (!targetUserId || !clientId || chatRetentionLimit === undefined) {
      return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'targetUserId, clientId, and chatRetentionLimit are required.' });
    }

    const clamped = Math.min(Math.max(parseInt(chatRetentionLimit, 10), 10), 100);
    const allocation = await getAllocationForUser(targetUserId, clientId);
    if (!allocation) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'No active allocation found for this user.' });
    }

    const result = await update(String(allocation._id), { chatRetentionLimit: clamped });
    if (result.error) {
      return res.status(400).json({ success: false, ...result });
    }

    return res.status(200).json({
      success: true,
      chatRetentionLimit: clamped,
      message: 'Retention limit updated.',
    });
  } catch (err) {
    console.error('[GreOnIQ] updateRetention error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

module.exports = { getRetention, updateRetention };
