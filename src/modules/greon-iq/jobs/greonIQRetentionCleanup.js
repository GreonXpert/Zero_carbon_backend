'use strict';

// ============================================================================
// greonIQRetentionCleanup.js — Trims chat sessions exceeding retention limit
//
// Schedule: Daily at 02:30 Asia/Kolkata (IST)
// Cron:     30 2 * * *
//
// WHAT IT DOES:
//   For each user who has a GreOnIQQuotaAllocation with chatRetentionLimit,
//   count their ChatSession records and delete the oldest ones that exceed
//   the limit. Also deletes the ChatMessage records in those sessions.
//
// RULES:
//   - ChatAuditLog records are NEVER deleted.
//   - Manual deletion (via DELETE /api/greon-iq/history/:sessionId) does NOT
//     refund credits. This job does not touch GreOnIQUsageLedger either.
//   - Retention is based on session count, not message count.
//   - This is a safety-net job. The primary trim happens immediately after
//     each new session is saved in chatSessionService.
//
// STATUS: Phase 1 stub — full implementation in Phase 5.
// ============================================================================

const cron = require('node-cron');
const { runNightlyCleanup } = require('../services/retentionService');

function startGreOnIQRetentionCleanup() {
  cron.schedule(
    '30 2 * * *',
    async () => {
      try {
        console.log('[GreOn IQ] Retention cleanup started (02:30 IST).');
        const result = await runNightlyCleanup();
        console.log(`[GreOn IQ] Retention cleanup done — users=${result.usersProcessed}, sessionsDeleted=${result.sessionsDeleted}`);
      } catch (err) {
        console.error('[GreOn IQ] Retention cleanup job error:', err.message);
      }
    },
    { timezone: 'Asia/Kolkata' }
  );

  console.log('[GreOn IQ] Retention cleanup job registered (Daily 02:30 IST).');
}

module.exports = { startGreOnIQRetentionCleanup };
