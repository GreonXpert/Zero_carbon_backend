// utils/jobs/missedCycleDetector.js
// Daily cron job that detects SurveyCycles whose cycleDate has passed without
// a survey being initiated or a DataEntry being created.
//
// Behaviour:
//   - Flags the cycle status as 'missed'
//   - Writes an AuditLog entry (source: 'cron', severity: 'warning')
//   - Does NOT write DataEntry — detection only
//   - Safe to re-run: already-missed cycles are skipped

const cron = require('node-cron');
const SurveyCycle = require('../../organization/models/SurveyCycle');
const DataEntry = require('../../organization/models/DataEntry');
const { logEvent } = require('../../../../common/services/audit/auditLogService');

/**
 * Number of days after cycleDate before a cycle is considered missed.
 * Provides a grace window for late survey initiation.
 */
const GRACE_PERIOD_DAYS = 3;

/**
 * checkMissedCycles
 *
 * Iterates all SurveyCycles that are still 'upcoming' or 'open' but whose
 * cycleDate has passed the grace period. For each:
 *   - If a DataEntry already exists (manually finalized) → skip
 *   - Otherwise → mark cycle as 'missed' and write AuditLog
 */
async function checkMissedCycles() {
  try {
    console.log('[MISSED CYCLE DETECTOR] Starting missed cycle check...');

    const cutoffDate = new Date(Date.now() - GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);

    // Find cycles that are still open/upcoming past the grace period
    const staleCycles = await SurveyCycle.find({
      status: { $in: ['upcoming', 'open'] },
      cycleDate: { $lt: cutoffDate },
    }).lean();

    console.log(`[MISSED CYCLE DETECTOR] Found ${staleCycles.length} stale cycle(s) to evaluate`);

    let flaggedCount = 0;
    let skippedCount = 0;

    for (const cycle of staleCycles) {
      try {
        const externalId = `survey_cycle_${cycle.cycleIndex}`;

        // Check if a DataEntry already exists for this cycle
        const existingEntry = await DataEntry.findOne({
          clientId: cycle.clientId,
          nodeId: cycle.nodeId,
          scopeIdentifier: cycle.scopeIdentifier,
          isSummary: true,
          externalId,
        }).lean();

        if (existingEntry) {
          // DataEntry exists — cycle was finalized some other way; skip
          skippedCount++;
          continue;
        }

        // Mark cycle as missed
        await SurveyCycle.findByIdAndUpdate(cycle._id, {
          $set: {
            status: 'missed',
            missedDetectedAt: new Date(),
          },
        });

        // Write AuditLog — system/cron source
        await logEvent({
          actor: {
            _id: null,
            userType: 'system',
            userName: 'system',
            email: null,
          },
          clientId: cycle.clientId,
          module: 'data_entry',
          action: 'update',
          source: 'cron',
          entityType: 'SurveyCycle',
          entityId: cycle._id.toString(),
          severity: 'warning',
          status: 'success',
          changeSummary: `Cycle ${cycle.cycleIndex} auto-marked missed — no survey initiated by ${cycle.cycleDate.toISOString().split('T')[0]}`,
          metadata: {
            cycleIndex: cycle.cycleIndex,
            cycleDate: cycle.cycleDate,
            clientId: cycle.clientId,
            scopeIdentifier: cycle.scopeIdentifier,
            gracePeriodDays: GRACE_PERIOD_DAYS,
          },
        });

        flaggedCount++;
        console.log(
          `[MISSED CYCLE DETECTOR] Flagged cycle ${cycle.cycleIndex} ` +
          `(scope: ${cycle.scopeIdentifier}, client: ${cycle.clientId}) as missed`
        );
      } catch (cycleErr) {
        console.error(
          `[MISSED CYCLE DETECTOR] Error processing cycle ${cycle.cycleIndex}:`,
          cycleErr
        );
      }
    }

    console.log(
      `[MISSED CYCLE DETECTOR] Completed. Flagged: ${flaggedCount}, Skipped (already has DataEntry): ${skippedCount}`
    );
  } catch (err) {
    console.error('[MISSED CYCLE DETECTOR] Fatal error in checkMissedCycles:', err);
  }
}

/**
 * startMissedCycleDetector
 *
 * Schedules the missed cycle check to run once daily at 3:00 AM UTC.
 * Returns the cron task (can be used to stop it if needed).
 */
function startMissedCycleDetector() {
  console.log('[MISSED CYCLE DETECTOR] Initializing missed cycle detector cron job...');

  // Run daily at 3:00 AM UTC (after the existing monthly summary cron at 2:00 AM)
  const task = cron.schedule('0 3 * * *', () => {
    console.log('[MISSED CYCLE DETECTOR] Running scheduled missed cycle check...');
    checkMissedCycles();
  }, {
    scheduled: true,
    timezone: 'UTC',
  });

  console.log('[MISSED CYCLE DETECTOR] Cron job started (runs daily at 03:00 UTC)');

  return task;
}

module.exports = {
  startMissedCycleDetector,
  checkMissedCycles,
  GRACE_PERIOD_DAYS,
};
