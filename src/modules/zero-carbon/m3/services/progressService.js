'use strict';

const ProgressSnapshot = require('../models/ProgressSnapshot');
const PathwayAnnual = require('../models/PathwayAnnual');
const DataQualityFlag = require('../models/DataQualityFlag');
const OrgSettings = require('../models/OrgSettings');
const EmissionSummary = require('../../calculation/EmissionSummary');
const { pullYearlyEmissionSummaryByBoundary } = require('./emissionSummaryScopeService');
const {
  ProgressStatus, SnapshotType, DQFlagCode, Severity,
} = require('../constants/enums');
const { WARNINGS } = require('../constants/messages');

/**
 * Pulls the yearly EmissionSummary from M1 for a given client + calendar year.
 *
 * When scopeBoundary is provided (S1, S1S2, S3, S1S2S3) the CO2e value is extracted
 * from emissionSummary.byScope using the scope-aware helper so the result matches the
 * target's declared boundary. Falls back to totalEmissions.CO2e when byScope is absent
 * on the document (legacy records) — the helper logs a warning in that case.
 *
 * When scopeBoundary is omitted the legacy path reads totalEmissions.CO2e directly,
 * preserving backward compatibility for any callers that pre-date this change.
 *
 * Returns { CO2e, ingestionTimestamp, summaryId, scopeBoundary?, scopeBreakdown? } or null.
 */
async function pullM1Emissions(clientId, year, scopeBoundary, scope3CoveragePct = 100) {
  // Scope-aware path — used when a target's scope_boundary is known.
  if (scopeBoundary) {
    return pullYearlyEmissionSummaryByBoundary(clientId, year, scopeBoundary, scope3CoveragePct);
  }

  // Legacy path — totalEmissions.CO2e only. Kept for backward compatibility.
  const doc = await EmissionSummary.findOne({
    clientId,
    'period.type': 'yearly',
    'period.year': year,
  }).sort({ 'metadata.lastCalculated': -1 }).lean();

  if (!doc) return null;

  return {
    CO2e:               doc.emissionSummary?.totalEmissions?.CO2e ?? 0,
    ingestionTimestamp: doc.metadata?.lastCalculated || new Date(),
    summaryId:          doc._id,
  };
}

function computeProgressStatus(actual, allowed) {
  if (actual <= allowed * 0.95) return ProgressStatus.Ahead_of_Target;
  if (actual <= allowed)        return ProgressStatus.On_Track;
  return ProgressStatus.Off_Track;
}

/**
 * Creates or refreshes a progress snapshot for a given target and year.
 * actual_emissions comes from M1 — never from initiative attribution.
 */
async function computeProgressSnapshot({
  targetId, clientId, snapshotDate, snapshotType = SnapshotType.ANNUAL,
  actualEmissions, calendarYear, ingestionTimestamp, m1SummaryId = null,
}) {
  const pathway = await PathwayAnnual.findOne({ target_id: targetId, calendar_year: calendarYear });
  if (!pathway) return null;

  const allowed   = pathway.allowed_emissions;
  const status    = computeProgressStatus(actualEmissions, allowed);
  const gap_pct   = allowed > 0 ? ((actualEmissions - allowed) / allowed) * 100 : 0;

  // calendar_year is the identity key — one canonical snapshot per (target, type, year).
  // snapshot_date is stored as a "last computed at" timestamp only, not used for deduplication.
  const snapshot = await ProgressSnapshot.findOneAndUpdate(
    { target_id: targetId, snapshot_type: snapshotType, calendar_year: calendarYear },
    {
      $set: {
        clientId,
        snapshot_date:       snapshotDate,
        calendar_year:       calendarYear,
        actual_emissions:    actualEmissions,
        allowed_emissions:   allowed,
        progress_status:     status,
        gap_pct,
        ingestion_timestamp: ingestionTimestamp || new Date(),
        ...(m1SummaryId ? { m1_summary_id: m1SummaryId } : {}),
      },
    },
    { upsert: true, new: true }
  );

  // Check for stale live data (>1 business day)
  if (snapshotType === SnapshotType.LIVE && ingestionTimestamp) {
    const staleThresholdMs = 24 * 60 * 60 * 1000;
    const age = Date.now() - new Date(ingestionTimestamp).getTime();
    if (age > staleThresholdMs) {
      console.warn(WARNINGS.STALE_LIVE_DATA);
      await DataQualityFlag.findOneAndUpdate(
        {
          clientId,
          entity_type: 'TargetMaster',
          entity_id:   String(targetId),
          flag_code:   DQFlagCode.STALE_LIVE_DATA,
          resolved:    false,
        },
        {
          $setOnInsert: {
            severity:          Severity.WARNING,
            message:           WARNINGS.STALE_LIVE_DATA,
            remediation_hint:  'Check M1 live ingestion pipeline.',
          },
        },
        { upsert: true }
      );
    }
  }

  return snapshot;
}

async function getProgress(targetId) {
  return ProgressSnapshot.find({ target_id: targetId }).sort({ snapshot_date: -1 }).limit(50);
}

async function getLiveSnapshot(targetId) {
  const live = await ProgressSnapshot.findOne({ target_id: targetId, snapshot_type: SnapshotType.LIVE })
    .sort({ snapshot_date: -1 });
  if (live) return live;
  // Fall back to the most recent ANNUAL snapshot
  return ProgressSnapshot.findOne({ target_id: targetId, snapshot_type: SnapshotType.ANNUAL })
    .sort({ calendar_year: -1 });
}

module.exports = { pullM1Emissions, computeProgressSnapshot, getProgress, getLiveSnapshot };
