'use strict';

const ForecastSnapshot = require('../models/ForecastSnapshot');
const PathwayAnnual = require('../models/PathwayAnnual');
const OrgSettings = require('../models/OrgSettings');
const DataQualityFlag = require('../models/DataQualityFlag');
const { ForecastStatus, SnapshotType, DQFlagCode, Severity } = require('../constants/enums');
const { WARNINGS } = require('../constants/messages');

function computeForecastStatus(projected, allowed, atRiskThresholdPct) {
  if (projected <= allowed) return ForecastStatus.On_Track;
  const overrunPct = ((projected - allowed) / allowed) * 100;
  if (overrunPct <= atRiskThresholdPct) return ForecastStatus.At_Risk;
  return ForecastStatus.Off_Track;
}

/**
 * Creates or refreshes a forecast snapshot.
 * Forward-looking: uses projected_emissions (not actual).
 * forecast_status is ALWAYS separate from progress_status.
 */
async function computeForecastSnapshot({
  targetId, clientId, forecastDate, snapshotType = SnapshotType.ANNUAL,
  projectedEmissions, calendarYear,
}) {
  const pathway = await PathwayAnnual.findOne({ target_id: targetId, calendar_year: calendarYear });
  if (!pathway) {
    // No pathway data — raise DQ flag
    await DataQualityFlag.findOneAndUpdate(
      {
        clientId,
        entity_type: 'TargetMaster',
        entity_id:   String(targetId),
        flag_code:   DQFlagCode.FORECAST_DATA_UNAVAILABLE,
        resolved:    false,
      },
      {
        $setOnInsert: {
          severity:         Severity.INFO,
          message:          WARNINGS.FORECAST_AT_RISK,
          remediation_hint: 'Ensure pathway has been generated for this target.',
        },
      },
      { upsert: true }
    );
    return null;
  }

  const settings = await OrgSettings.findOne({ clientId });
  const threshold = settings?.forecast_at_risk_threshold_pct ?? 5;
  const status    = computeForecastStatus(projectedEmissions, pathway.allowed_emissions, threshold);
  const atRisk    = status !== ForecastStatus.On_Track;

  if (atRisk) console.warn(WARNINGS.FORECAST_AT_RISK);

  return ForecastSnapshot.findOneAndUpdate(
    { target_id: targetId, snapshot_type: snapshotType, forecast_date: forecastDate },
    {
      $set: {
        clientId,
        projected_emissions: projectedEmissions,
        allowed_emissions:   pathway.allowed_emissions,
        forecast_status:     status,
        at_risk_indicator:   atRisk,
      },
    },
    { upsert: true, new: true }
  );
}

async function getForecast(targetId) {
  return ForecastSnapshot.find({ target_id: targetId }).sort({ forecast_date: -1 }).limit(20);
}

module.exports = { computeForecastSnapshot, getForecast };
