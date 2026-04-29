'use strict';

const cron = require('node-cron');

const { checkExpiredSubscriptions } = require('../../modules/client-management/client/clientController');
const { scheduleMonthlySummary,
        checkAndCreateMissedSummaries } = require('../../modules/zero-carbon/data-collection/controllers/monthlyDataSummaryController');
const { startApiKeyExpiryChecker }      = require('../../modules/zero-carbon/workflow/jobs/apiKeyExpiryChecker');
const { startMissedCycleDetector }      = require('../../modules/zero-carbon/workflow/jobs/missedCycleDetector');
const { startZeroCarbonExpiryChecker }  = require('../../modules/zero-carbon/workflow/jobs/zeroCarbonExpiryChecker');
const { startEsgLinkExpiryChecker }     = require('../../modules/zero-carbon/workflow/jobs/esgLinkExpiryChecker');
const { startSummaryMaintenanceJob }    = require('../../modules/zero-carbon/workflow/jobs/summaryMaintenanceJob');
const { startSLAChecker }               = require('../../common/utils/jobs/ticketSlaChecker');
const { startEsgDataFrequencyChecker }  = require('../../modules/esg-link/esgLink_core/workflow/jobs/esgDataFrequencyChecker');
const { publishScheduledNotifications } = require('../../common/controllers/notification/notificationControllers');
const { startGreOnIQWeeklyReset }       = require('../../modules/greon-iq/jobs/greonIQWeeklyReset');
const { startGreOnIQMonthlyReset }      = require('../../modules/greon-iq/jobs/greonIQMonthlyReset');
const { startGreOnIQRetentionCleanup }  = require('../../modules/greon-iq/jobs/greonIQRetentionCleanup');
const Notification                      = require('../../common/models/Notification/Notification');
const {
  startForecastNightlyCron,
  registerEmissionSummaryHook,
} = require('../../modules/zero-carbon/m3/jobs/m3ForecastAutoJob');

// ============================================================================
// REGISTER ALL CRON JOBS AND BACKGROUND TASKS
// ============================================================================

/**
 * Starts all scheduled jobs and background workers.
 * Must be called AFTER the database connection is established.
 */
function registerJobs() {

  // ── Subscription expiry — daily at midnight ───────────────────────────────
  cron.schedule('0 0 * * *', () => {
    console.log('🔄 Running daily subscription check...');
    checkExpiredSubscriptions();
  });
  // Also run once on startup to catch anything missed
  checkExpiredSubscriptions();

  // ── Monthly emission summary ──────────────────────────────────────────────
  scheduleMonthlySummary();

  // Back-fill any summaries missed while the server was down
  (async () => {
    try {
      await checkAndCreateMissedSummaries();
      console.log('✅ Missed summaries check complete');
    } catch (err) {
      console.error('❌ Error back-filling summaries:', err);
    }
  })();

  // ── API key expiry checker ────────────────────────────────────────────────
  console.log('🔐 Starting API Key expiry checker...');
  startApiKeyExpiryChecker();

  // ── Missed survey cycle detector (daily at 03:00 UTC) ────────────────────
  startMissedCycleDetector();

  // ── SLA checker (every 15 minutes) ───────────────────────────────────────
  startSLAChecker();

  // ── Subscription expiry checkers (ZeroCarbon + ESGLink) ──────────────────
  startEsgLinkExpiryChecker();      // daily at 02:00 UTC
  startZeroCarbonExpiryChecker();   // daily at 02:05 UTC

  // ── Summary maintenance job (hourly recalc + daily cleanup) ──────────────
  startSummaryMaintenanceJob();

  // ── ESG data frequency reminder checker (daily at 07:00 UTC) ─────────────
  startEsgDataFrequencyChecker();

  // ── GreOn IQ quota resets + retention cleanup (IST-based) ────────────────
  startGreOnIQWeeklyReset();      // Mon 00:00 IST — zero weekly usage counters
  startGreOnIQMonthlyReset();     // 1st of month 00:00 IST — zero monthly counters
  startGreOnIQRetentionCleanup(); // Daily 02:30 IST — trim sessions exceeding retention limit

  // ── M3 Forecast auto-recompute ────────────────────────────────────────────
  registerEmissionSummaryHook();  // trigger recompute whenever emission data is saved
  startForecastNightlyCron();     // nightly full recompute at 01:00 UTC

  // ── Scheduled notification publisher (every 5 minutes) ───────────────────
  cron.schedule('*/5 * * * *', async () => {
    console.log('🔄 Checking for scheduled notifications...');
    try {
      const now = new Date();
      const scheduledNotifications = await Notification.find({
        status: 'scheduled',
        scheduledPublishDate: { $lte: now },
        isDeleted: false
      });

      for (const notification of scheduledNotifications) {
        notification.status = 'published';
        notification.publishedAt = now;
        notification.publishDate = now;
        await notification.save();

        // Broadcast via global (set by registerSockets)
        if (global.broadcastNotification) {
          await global.broadcastNotification(notification);
        }

        console.log(`📨 Published and broadcasted: ${notification.title}`);
      }

      // Auto-deletion housekeeping
      await Notification.scheduleAutoDeletion();
    } catch (error) {
      console.error('Error in scheduled notification job:', error);
    }
  });

  // ── Background scheduler for publishScheduledNotifications (every 10 min) ─
  cron.schedule('*/10 * * * *', async () => {
    console.log('🔄 Checking for scheduled notifications...');
    try {
      await publishScheduledNotifications();
    } catch (error) {
      console.error('Error in scheduled notification job:', error);
    }
  });
}

module.exports = { registerJobs };
