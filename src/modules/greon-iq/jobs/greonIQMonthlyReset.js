'use strict';

// ============================================================================
// greonIQMonthlyReset.js — Marks start of new monthly quota period
//
// Schedule: 1st day of every month at 00:00 Asia/Kolkata (IST)
// Cron:     0 0 1 * *
//
// Usage is tracked by periodKey (YYYY-MM in IST) in GreOnIQUsageLedger.
// New month's key starts fresh automatically. This job logs the transition
// and reports per-client usage totals for monitoring.
// ============================================================================

const cron = require('node-cron');
const GreOnIQUsageLedger = require('../models/GreOnIQUsageLedger');
const { getPeriodKey }   = require('../utils/quotaMathHelpers');

function startGreOnIQMonthlyReset() {
  cron.schedule(
    '0 0 1 * *',
    async () => {
      try {
        const now = new Date();
        // Last month's key: subtract 1 month
        const lastMonth = new Date(now);
        lastMonth.setMonth(lastMonth.getMonth() - 1);
        const lastPeriodKey = getPeriodKey(lastMonth);

        console.log(`[GreOn IQ] Monthly reset — new period starts. Last period: ${lastPeriodKey}`);

        // Aggregate total credits consumed last month per client for monitoring
        const summary = await GreOnIQUsageLedger.aggregate([
          { $match: { periodKey: lastPeriodKey } },
          { $group: { _id: '$clientId', totalCredits: { $sum: '$totalCredits' }, users: { $addToSet: '$userId' } } },
        ]);

        for (const row of summary) {
          console.log(`[GreOn IQ] ${lastPeriodKey} | client=${row._id} | credits=${row.totalCredits} | users=${row.users.length}`);
        }
      } catch (err) {
        console.error('[GreOn IQ] Monthly reset job error:', err.message);
      }
    },
    { timezone: 'Asia/Kolkata' }
  );

  console.log('[GreOn IQ] Monthly reset job registered (1st of month 00:00 IST).');
}

module.exports = { startGreOnIQMonthlyReset };
