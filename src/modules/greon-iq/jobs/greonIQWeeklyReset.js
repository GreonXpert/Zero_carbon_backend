'use strict';

// ============================================================================
// greonIQWeeklyReset.js — Marks start of new weekly quota period
//
// Schedule: Every Monday at 00:00 Asia/Kolkata (IST)
// Cron:     0 0 * * 1
//
// Quota enforcement uses getWeekKey() at query time — no DB rows are zeroed.
// Unused weekly credits expire naturally (not carried forward).
// This job logs the reset event and deactivates any expired allocations.
// ============================================================================

const cron = require('node-cron');
const GreOnIQQuotaAllocation = require('../models/GreOnIQQuotaAllocation');

function startGreOnIQWeeklyReset() {
  cron.schedule(
    '0 0 * * 1',
    async () => {
      try {
        const now = new Date();
        console.log(`[GreOn IQ] Weekly quota reset — ${now.toISOString()}`);

        // Deactivate any allocations whose expiresAt has passed
        const expired = await GreOnIQQuotaAllocation.updateMany(
          { isActive: true, expiresAt: { $lte: now } },
          { $set: { isActive: false } }
        );

        if (expired.modifiedCount > 0) {
          console.log(`[GreOn IQ] Deactivated ${expired.modifiedCount} expired allocation(s).`);
        }
      } catch (err) {
        console.error('[GreOn IQ] Weekly reset job error:', err.message);
      }
    },
    { timezone: 'Asia/Kolkata' }
  );

  console.log('[GreOn IQ] Weekly reset job registered (Mon 00:00 IST).');
}

module.exports = { startGreOnIQWeeklyReset };
