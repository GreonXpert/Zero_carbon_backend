'use strict';

const cron            = require('node-cron');
const EsgLinkBoundary = require('../../boundary/models/EsgLinkBoundary');
const { triggerAllPeriodSummaryRefresh, refreshAllBoundaryPeriods } = require('../services/summaryService');

// ─────────────────────────────────────────────────────────────────────────────
// Returns current year / month / day period definitions
// ─────────────────────────────────────────────────────────────────────────────
function _currentPeriods() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1;
  const day   = now.getDate();
  const mm    = String(month).padStart(2, '0');
  const dd    = String(day).padStart(2, '0');
  return [
    { periodType: 'year',  periodKey: `${year}`,          periodYear: year },
    { periodType: 'month', periodKey: `${year}-${mm}`,    periodYear: year },
    { periodType: 'day',   periodKey: `${year}-${mm}-${dd}`, periodYear: year },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-compute summaries for every active boundary — staggered to avoid DB spike
// ─────────────────────────────────────────────────────────────────────────────
async function _runMaintenance() {
  console.log('[ESG Summary Maintenance] Starting pre-computation run...');
  try {
    const boundaries = await EsgLinkBoundary.find({ isActive: true, isDeleted: false })
      .select('_id clientId').lean();

    console.log(`[ESG Summary Maintenance] Processing ${boundaries.length} boundaries`);

    const periods = _currentPeriods();
    let delay = 0;

    for (const b of boundaries) {
      for (const p of periods) {
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        triggerAllPeriodSummaryRefresh(b.clientId, b._id, p);
        delay = (delay + 200) % 2000; // stagger 200 ms, cycle every 2 s
      }
    }

    console.log('[ESG Summary Maintenance] Pre-computation dispatched');
  } catch (err) {
    console.error('[ESG Summary Maintenance] Error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup backfill — recomputes ALL historical period summaries for every
// active boundary by inspecting existing EsgDataEntry documents.
// Runs once on server start so periods like 2025 that were never cached get
// computed without needing a manual refresh-all API call.
// ─────────────────────────────────────────────────────────────────────────────
async function _runStartupBackfill() {
  console.log('[ESG Summary] Running startup historical backfill...');
  try {
    const boundaries = await EsgLinkBoundary.find({ isActive: true, isDeleted: false })
      .select('_id clientId').lean();

    for (const b of boundaries) {
      await refreshAllBoundaryPeriods(b.clientId, b._id).catch((err) =>
        console.error(`[ESG Summary] Backfill failed for boundary ${b._id}:`, err.message)
      );
    }
    console.log('[ESG Summary] Startup historical backfill complete');
  } catch (err) {
    console.error('[ESG Summary] Startup backfill error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron initialiser — call from registerJobs.js after DB connects
// ─────────────────────────────────────────────────────────────────────────────
function startEsgSummaryMaintenanceJob() {
  // Hourly at :30 — offset from ZeroCarbon job which runs at :00
  cron.schedule('30 * * * *', _runMaintenance, {
    scheduled: true,
    timezone:  'UTC',
  });

  // Backfill historical summaries once on startup (fire-and-forget)
  setImmediate(_runStartupBackfill);

  console.log('[ESG Summary Maintenance] Scheduled — hourly at :30 UTC');
}

module.exports = { startEsgSummaryMaintenanceJob };
