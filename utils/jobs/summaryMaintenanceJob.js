// utils/jobs/summaryMaintenanceJob.js
// Two scheduled maintenance jobs for ReductionSummary:
//   1. Hourly (0 * * * *) — processes up to 50 summaries with pendingRecalculation=true
//   2. Daily  (0 2 * * *) — removes non-lifetime summaries older than 90 days
//
// Both jobs are inactive until startSummaryMaintenanceJob() is called (from index.js).

'use strict';

const cron             = require('node-cron');
const ReductionSummary = require('../../models/Reduction/SummaryNetReduction');
const { calculateFullSummary } = require('../../controllers/Reduction/netReductionSummaryController');

// ─────────────────────────────────────────────────────────────────────────────
// Job 1: Process pending recalculations (runs every hour)
// ─────────────────────────────────────────────────────────────────────────────
async function processPendingRecalculations() {
  console.log('[Summary Maintenance] Starting pending recalculations...');

  try {
    const pendingSummaries = await ReductionSummary.find({
      pendingRecalculation: true,
    }).select('clientId').limit(50); // process 50 at a time

    console.log(`[Summary Maintenance] Found ${pendingSummaries.length} summaries needing recalculation`);

    for (const summary of pendingSummaries) {
      try {
        const updated = await calculateFullSummary(summary.clientId);

        await ReductionSummary.findOneAndUpdate(
          { clientId: summary.clientId, period: 'lifetime', periodStart: null },
          updated,
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        console.log(`[Summary Maintenance] Recalculated summary for client ${summary.clientId}`);
      } catch (error) {
        console.error(`[Summary Maintenance] Error recalculating summary for client ${summary.clientId}:`, error);
      }
    }

    console.log('[Summary Maintenance] Pending recalculations complete');
  } catch (error) {
    console.error('[Summary Maintenance] Error in pending recalculations job:', error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Job 2: Clean up old summary data (runs daily at 02:00 UTC)
// ─────────────────────────────────────────────────────────────────────────────
async function cleanupOldSummaries() {
  console.log('[Summary Maintenance] Starting cleanup of old summaries...');

  try {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const result = await ReductionSummary.deleteMany({
      period:      { $ne: 'lifetime' },
      periodStart: { $lt: ninetyDaysAgo },
    });

    console.log(`[Summary Maintenance] Cleaned up ${result.deletedCount} old summary records`);
  } catch (error) {
    console.error('[Summary Maintenance] Error in cleanup job:', error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron initialiser — call this from index.js after DB connects
// ─────────────────────────────────────────────────────────────────────────────
function startSummaryMaintenanceJob() {
  // Hourly recalculation
  cron.schedule('0 * * * *', processPendingRecalculations, {
    scheduled: true,
    timezone: 'UTC',
  });

  // Daily cleanup at 02:00 UTC
  cron.schedule('0 2 * * *', cleanupOldSummaries, {
    scheduled: true,
    timezone: 'UTC',
  });

  console.log('[Summary Maintenance] Jobs initialized — hourly recalculation + daily cleanup at 02:00 UTC');
}

// ─────────────────────────────────────────────────────────────────────────────
// Manual trigger (for admin endpoints / testing)
// ─────────────────────────────────────────────────────────────────────────────
async function runMaintenanceJob() {
  await processPendingRecalculations();
  await cleanupOldSummaries();
}

module.exports = {
  startSummaryMaintenanceJob,
  runMaintenanceJob,
};
