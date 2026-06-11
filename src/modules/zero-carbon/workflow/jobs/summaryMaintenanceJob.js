// utils/jobs/summaryMaintenanceJob.js
// Two scheduled maintenance jobs for EmissionSummary and SummaryNetReduction:
//   1. Hourly (0 * * * *) — retries SummaryNetReduction docs flagged needsRecalculation=true
//   2. Daily  (0 2 * * *) — removes old EmissionSummary daily/weekly records (>90 days)
//
// BUG 13 FIX: Old job queried SummaryNetReduction using `period` and `periodStart` fields
//   that don't exist in that schema. Cleanup now correctly targets EmissionSummary.
//
// BUG 14 FIX: Old job queried SummaryNetReduction.pendingRecalculation which also didn't
//   exist. Replaced with `needsRecalculation` (added to SummaryNetReduction schema with
//   a sparse index). The recompute function now sets it to true on error, false on success.

'use strict';

const cron = require('node-cron');

// Reduction summary (singleton per client — stores rollup stats only)
const SummaryNetReduction = require('../../reduction/models/SummaryNetReduction');

// BUG 13 FIX: EmissionSummary IS the collection with period/date fields — use this for cleanup
const EmissionSummary = require('../../calculation/EmissionSummary');

// BUG 14 FIX: use the correct exported function name
const { recomputeClientNetReductionSummary } = require('../../reduction/controllers/netReductionSummaryController');

// ─────────────────────────────────────────────────────────────────────────────
// Job 1: Retry failed reductions (runs every hour)
// BUG 14 FIX: Query SummaryNetReduction.needsRecalculation (indexed, actually exists).
// The old query used `pendingRecalculation` which never existed — always returned 0 docs.
// ─────────────────────────────────────────────────────────────────────────────
async function processPendingRecalculations() {
  console.log('[Summary Maintenance] Starting pending recalculations...');

  try {
    const pendingSummaries = await SummaryNetReduction.find({
      needsRecalculation: true,
    }).select('clientId').limit(50); // process 50 at a time

    console.log(`[Summary Maintenance] Found ${pendingSummaries.length} summaries needing recalculation`);

    for (const summary of pendingSummaries) {
      try {
        await recomputeClientNetReductionSummary(summary.clientId);

        // Mark as resolved
        await SummaryNetReduction.findOneAndUpdate(
          { clientId: summary.clientId },
          { $set: { needsRecalculation: false } }
        );

        console.log(`[Summary Maintenance] Recalculated summary for client ${summary.clientId}`);
      } catch (error) {
        console.error(`[Summary Maintenance] Error recalculating summary for client ${summary.clientId}:`, error);
        // Leave needsRecalculation=true so next run retries
      }
    }

    console.log('[Summary Maintenance] Pending recalculations complete');
  } catch (error) {
    console.error('[Summary Maintenance] Error in pending recalculations job:', error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Job 2: Clean up old EmissionSummary records (runs daily at 02:00 UTC)
// BUG 13 FIX: Old job ran deleteMany on SummaryNetReduction using `period` and
//   `periodStart` fields that don't exist — it deleted nothing.
//   SummaryNetReduction is a singleton per client; there's nothing to clean up.
//   EmissionSummary IS the collection with period/date fields — clean up
//   daily + weekly records older than 90 days to keep it manageable.
// ─────────────────────────────────────────────────────────────────────────────
async function cleanupOldSummaries() {
  console.log('[Summary Maintenance] Starting cleanup of old EmissionSummary records...');

  try {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const result = await EmissionSummary.deleteMany({
      // Only prune granular periods — keep monthly/yearly/all-time forever
      'period.type': { $in: ['daily', 'weekly'] },
      'period.from': { $lt: ninetyDaysAgo },
    });

    console.log(`[Summary Maintenance] Cleaned up ${result.deletedCount} old EmissionSummary records`);
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
