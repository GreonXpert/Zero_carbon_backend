'use strict';

const ProgressSnapshot = require('../models/ProgressSnapshot');
const PathwayAnnual = require('../models/PathwayAnnual');
const DataQualityFlag = require('../models/DataQualityFlag');
const OrgSettings = require('../models/OrgSettings');
const EmissionSummary = require('../../calculation/EmissionSummary');
const {
  ProgressStatus, SnapshotType, DQFlagCode, Severity,
} = require('../constants/enums');
const { WARNINGS } = require('../constants/messages');

/**
 * Pulls the yearly EmissionSummary from M1 for a given client + calendar year.
 * Returns { CO2e, ingestion_timestamp, summaryId } or null if not found.
 */
async function pullM1Emissions(clientId, year) {
  const doc = await EmissionSummary.findOne({
    clientId,
    'period.type': 'yearly',
    'period.year': year,
  }).sort({ 'metadata.lastCalculated': -1 }).lean();

  if (!doc) return null;

  const CO2e = doc.emissionSummary?.totalEmissions?.CO2e ?? 0;
  return {
    CO2e,
    ingestion_timestamp: doc.metadata?.lastCalculated || new Date(),
    summaryId: doc._id,
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

  const snapshot = await ProgressSnapshot.findOneAndUpdate(
    { target_id: targetId, snapshot_type: snapshotType, snapshot_date: snapshotDate },
    {
      $set: {
        clientId,
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
  return ProgressSnapshot.findOne({ target_id: targetId, snapshot_type: SnapshotType.LIVE })
    .sort({ snapshot_date: -1 });
}

module.exports = { pullM1Emissions, computeProgressSnapshot, getProgress, getLiveSnapshot };
