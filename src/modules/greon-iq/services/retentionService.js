'use strict';

// ============================================================================
// retentionService.js — Session-count-based retention enforcement
//
// Rules:
//   - Count basis: sessions (not messages)
//   - Minimum: 10 | Maximum: 100 | Default: 10 per user
//   - When count exceeds limit: delete oldest sessions (ChatSession + ChatMessage)
//   - Audit logs (ChatAuditLog) are NEVER deleted by retention
//   - Trim runs: immediately after each new session + nightly cron 02:30 IST
// ============================================================================

const ChatSession = require('../models/ChatSession');
const ChatMessage = require('../models/ChatMessage');
const { getChatRetentionLimit } = require('./quotaResolutionService');

/**
 * Trim sessions for a user if they exceed their retention limit.
 * Called after every new session creation.
 *
 * @param {object} user
 * @param {string} clientId
 * @returns {Promise<{ trimmed: number }>}
 */
async function trimForUser(user, clientId) {
  const limit = await getChatRetentionLimit(user, clientId);

  const sessions = await ChatSession.find({ userId: user._id, clientId })
    .sort({ updatedAt: -1 })   // newest first
    .select('_id')
    .lean();

  if (sessions.length <= limit) return { trimmed: 0 };

  const toDelete = sessions.slice(limit);   // everything beyond the limit
  const toDeleteIds = toDelete.map((s) => s._id);

  await ChatMessage.deleteMany({ sessionId: { $in: toDeleteIds } });
  await ChatSession.deleteMany({ _id: { $in: toDeleteIds } });

  return { trimmed: toDelete.length };
}

/**
 * Nightly cleanup: scan all users and enforce retention.
 * Intended to be called by greonIQRetentionCleanup.js cron job.
 *
 * @returns {Promise<{ usersProcessed: number, sessionsDeleted: number }>}
 */
async function runNightlyCleanup() {
  let usersProcessed  = 0;
  let sessionsDeleted = 0;

  // Get distinct (userId, clientId) pairs that have sessions
  const pairs = await ChatSession.aggregate([
    { $group: { _id: { userId: '$userId', clientId: '$clientId' } } },
  ]);

  for (const { _id: { userId, clientId } } of pairs) {
    try {
      // Use default limit since we don't have the user object — resolve via DB
      const limit = await _resolveRetentionLimit(String(userId), String(clientId));

      const sessions = await ChatSession.find({ userId, clientId })
        .sort({ updatedAt: -1 })
        .select('_id')
        .lean();

      if (sessions.length > limit) {
        const toDeleteIds = sessions.slice(limit).map((s) => s._id);
        await ChatMessage.deleteMany({ sessionId: { $in: toDeleteIds } });
        await ChatSession.deleteMany({ _id: { $in: toDeleteIds } });
        sessionsDeleted += toDeleteIds.length;
      }
      usersProcessed++;
    } catch (err) {
      console.error(`[GreOnIQ] retention cleanup error for user ${userId}:`, err.message);
    }
  }

  return { usersProcessed, sessionsDeleted };
}

async function _resolveRetentionLimit(userId, clientId) {
  const GreOnIQQuotaAllocation = require('../models/GreOnIQQuotaAllocation');
  const ConsultantClientQuota  = require('../../client-management/quota/ConsultantClientQuota');

  const allocation = await GreOnIQQuotaAllocation.findOne({
    targetUserId: userId, clientId, isActive: true,
  }).lean();
  if (allocation?.chatRetentionLimit) return allocation.chatRetentionLimit;

  const clientQuota = await ConsultantClientQuota.findOne({ clientId }).lean();
  return clientQuota?.limits?.greonIQChatRetentionLimit || 10;
}

module.exports = { trimForUser, runNightlyCleanup };
