'use strict';

// ============================================================================
// greonIQRetentionCleanup.js — Weekly history cleanup (every Saturday)
//
// Schedule: Every Saturday at 02:30 Asia/Kolkata (IST)
// Cron:     30 2 * * 6
//
// WHAT IT DOES:
//   1. Count-based retention: for each user whose session count exceeds
//      their chatRetentionLimit, the oldest non-pinned sessions are deleted.
//   2. Age-based cleanup: non-pinned sessions not updated in the last 30 days
//      are deleted for all users.
//   3. Each affected user receives an in-app notification via the Notification
//      model so they know their history was cleaned up.
//
// RULES:
//   - Pinned sessions (isPinned: true) are NEVER deleted by either step.
//   - ChatAuditLog records are NEVER deleted.
//   - Manual deletion via DELETE /api/greon-iq/history/:sessionId does NOT
//     refund credits and is not affected by this job.
// ============================================================================

const cron         = require('node-cron');
const Notification = require('../../../common/models/Notification/Notification');
const { runNightlyCleanup, runWeekendCleanup } = require('../services/retentionService');

function startGreOnIQRetentionCleanup() {
  cron.schedule(
    '30 2 * * 6',
    async () => {
      try {
        console.log('[GreOn IQ] Saturday history cleanup started.');

        // Step 1 — count-based retention
        const retention = await runNightlyCleanup();
        console.log(`[GreOn IQ] Count-based retention — users=${retention.usersProcessed}, sessionsDeleted=${retention.sessionsDeleted}`);

        // Step 2 — age-based cleanup (sessions older than 30 days)
        const weekend = await runWeekendCleanup(30);
        console.log(`[GreOn IQ] Age-based cleanup — users=${weekend.usersAffected}, sessionsDeleted=${weekend.sessionsDeleted}`);

        // Step 3 — notify each user whose old sessions were removed
        if (weekend.userSummary.length > 0) {
          await _notifyAffectedUsers(weekend.userSummary);
        }
      } catch (err) {
        console.error('[GreOn IQ] Saturday cleanup job error:', err.message);
      }
    },
    { timezone: 'Asia/Kolkata' }
  );

  console.log('[GreOn IQ] Retention cleanup job registered (Saturday 02:30 IST).');
}

async function _notifyAffectedUsers(userSummary) {
  for (const { userId, sessionsDeleted } of userSummary) {
    try {
      const n = sessionsDeleted;
      const notification = new Notification({
        title:   'GreOn IQ — Weekly History Cleanup',
        message: `${n} conversation${n === 1 ? '' : 's'} older than 30 days ${n === 1 ? 'was' : 'were'} automatically removed from your GreOn IQ history during the weekly cleanup. Pinned conversations are always kept safe.`,
        priority: 'low',
        createdBy:   null,
        creatorType: 'super_admin',
        targetUsers: [userId],
        status:      'published',
        publishedAt: new Date(),
        isSystemNotification: true,
        systemAction:         'greon_iq_history_cleanup',
        autoDeleteAfterDays:  7,
      });

      await notification.save();

      if (global.broadcastNotification) {
        await global.broadcastNotification(notification);
      }
    } catch (err) {
      console.error(`[GreOnIQ] cleanup notification error for user ${userId}:`, err.message);
    }
  }
}

module.exports = { startGreOnIQRetentionCleanup };
