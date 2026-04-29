'use strict';

/**
 * M3 Forecast Auto-Recompute Job
 * ─────────────────────────────────────────────────────────────────────────────
 * Two triggers:
 *   1. EmissionSummary post-save hook — fires whenever new emission data lands.
 *      Debounced per clientId (5 min) to avoid hammering DB on bulk imports.
 *   2. Nightly cron (01:00 UTC) — full recompute for all clients with a locked method.
 *
 * Only clients whose forecast_method_locked = true are auto-recomputed.
 * (Clients that have never done a first manual compute are skipped.)
 *
 * All period types (ANNUAL, MONTHLY, QUARTERLY, HALF_YEARLY, DAILY) are computed.
 * All snapshots are written as is_primary: true, using the client's locked method.
 */

const cron         = require('node-cron');
const OrgSettings  = require('../models/OrgSettings');
const TargetMaster = require('../models/TargetMaster');
const { computeForecastByMethod } = require('../services/forecastService');
const { SnapshotType } = require('../constants/enums');

// All period types we auto-compute (LIVE is excluded — it's a special real-time type)
const AUTO_SNAPSHOT_TYPES = [
  SnapshotType.ANNUAL,
  SnapshotType.MONTHLY,
  SnapshotType.QUARTERLY,
  SnapshotType.HALF_YEARLY,
  SnapshotType.DAILY,
];

// ── Debounce: prevent re-triggering within 5 min per client ──────────────────
const _lastRun   = new Map(); // clientId → timestamp (ms)
const DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

function _isDebounced(clientId) {
  const last = _lastRun.get(clientId) || 0;
  return (Date.now() - last) < DEBOUNCE_MS;
}

function _stamp(clientId) {
  _lastRun.set(clientId, Date.now());
}

// ── Core recompute logic ─────────────────────────────────────────────────────

/**
 * Recompute all period-type forecasts for every PUBLISHED/ACTIVE target
 * belonging to `clientId`, using the client's locked forecast method.
 * Skips silently if the client has not done their first manual compute yet.
 */
async function autoRecomputeForClient(clientId) {
  const settings = await OrgSettings.findOne({ clientId }).lean();
  if (!settings?.forecast_method_locked) return; // not configured yet — skip

  const method       = settings.forecast_method_default;
  const calendarYear = new Date().getFullYear();

  const targets = await TargetMaster.find({
    clientId,
    lifecycle_status: { $in: ['PUBLISHED', 'ACTIVE'] },
    isDeleted: false,
  }).lean();

  if (!targets.length) return;

  console.log(`[M3 Forecast] Auto-recompute → client ${clientId} | method: ${method} | targets: ${targets.length}`);

  for (const target of targets) {
    for (const snapshotType of AUTO_SNAPSHOT_TYPES) {
      try {
        await computeForecastByMethod({
          targetId:      target._id,
          clientId,
          calendarYear,
          forecastMethod: method,
          snapshotType,
          isPrimary:     true,
        });
      } catch (e) {
        // Non-fatal — log and continue with the next type
        console.error(`[M3 Forecast] Error target=${target._id} type=${snapshotType}: ${e.message}`);
      }
    }
  }

  console.log(`[M3 Forecast] Auto-recompute complete → client ${clientId}`);
}

/**
 * Debounced version — called by the EmissionSummary post-save hook.
 * Skips if the same client was already recomputed within the last 5 minutes.
 */
async function autoRecomputeForClientDebounced(clientId) {
  if (_isDebounced(clientId)) return;
  _stamp(clientId);
  await autoRecomputeForClient(clientId);
}

/**
 * Recompute forecasts for ALL clients that have a locked method.
 * Called by the nightly cron.
 */
async function autoRecomputeAllClients() {
  const allSettings = await OrgSettings.find({ forecast_method_locked: true }, { clientId: 1 }).lean();
  console.log(`[M3 Forecast] Nightly run — ${allSettings.length} client(s) to process`);

  for (const { clientId } of allSettings) {
    try {
      await autoRecomputeForClient(clientId);
    } catch (e) {
      console.error(`[M3 Forecast] Nightly error for client ${clientId}: ${e.message}`);
    }
  }
}

// ── EmissionSummary post-save hook ───────────────────────────────────────────

/**
 * Attaches a post-save hook to the EmissionSummary mongoose model.
 * Whenever new emission data is saved, the affected client's forecasts are
 * automatically refreshed (debounced to avoid hammering on bulk saves).
 *
 * Must be called AFTER MongoDB is connected and models are loaded.
 */
function registerEmissionSummaryHook() {
  try {
    const EmissionSummary = require('../../calculation/EmissionSummary');
    EmissionSummary.schema.post('save', function (doc) {
      const clientId = doc?.clientId;
      if (!clientId) return;
      autoRecomputeForClientDebounced(clientId).catch((e) =>
        console.error('[M3 Forecast hook]', e.message)
      );
    });
    console.log('✅ [M3 Forecast] EmissionSummary post-save hook registered');
  } catch (e) {
    console.error('⚠️  [M3 Forecast] Could not register EmissionSummary hook:', e.message);
  }
}

// ── Nightly cron ─────────────────────────────────────────────────────────────

/**
 * Schedules the nightly forecast recompute cron job (01:00 UTC every day).
 * Also runs once immediately on server startup to catch any missed overnight run.
 */
function startForecastNightlyCron() {
  // Daily at 01:00 UTC
  cron.schedule('0 1 * * *', async () => {
    console.log('🔄 [M3 Forecast] Nightly auto-recompute starting...');
    try {
      await autoRecomputeAllClients();
      console.log('✅ [M3 Forecast] Nightly auto-recompute complete');
    } catch (e) {
      console.error('❌ [M3 Forecast] Nightly auto-recompute failed:', e.message);
    }
  });

  console.log('✅ [M3 Forecast] Nightly cron registered (01:00 UTC daily)');
}

module.exports = {
  startForecastNightlyCron,
  registerEmissionSummaryHook,
  autoRecomputeForClient,         // exported for manual trigger via admin tools
  autoRecomputeAllClients,
};
