'use strict';

const ForecastSnapshot = require('../models/ForecastSnapshot');
const PathwayAnnual = require('../models/PathwayAnnual');
const OrgSettings = require('../models/OrgSettings');
const DataQualityFlag = require('../models/DataQualityFlag');
const EmissionSummary = require('../../calculation/EmissionSummary');
const { ForecastStatus, ForecastMethod, SnapshotType, DQFlagCode, Severity } = require('../constants/enums');
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
  forecastMethod = ForecastMethod.LINEAR_EXTRAPOLATION,
  confidenceLower = null, confidenceUpper = null,
  basisPeriodStart = null, basisPeriodEnd = null,
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
        forecast_method:     forecastMethod,
        confidence_lower:    confidenceLower,
        confidence_upper:    confidenceUpper,
        basis_period_start:  basisPeriodStart,
        basis_period_end:    basisPeriodEnd,
      },
    },
    { upsert: true, new: true }
  );
}

// ── Forecast Method Engines ───────────────────────────────────────────────────

/**
 * Pulls YTD monthly CO2e totals from M1 EmissionSummary for a given year,
 * up to the most recently available month.
 * Returns { ytdTotal, monthsWithData, latestMonth, docs }
 */
async function pullYtdEmissions(clientId, year) {
  const docs = await EmissionSummary.find({
    clientId,
    'period.type': 'monthly',
    'period.year': year,
  }).sort({ 'period.month': 1 }).lean();

  if (!docs.length) return { ytdTotal: 0, monthsWithData: 0, latestMonth: 0, docs: [] };

  const ytdTotal      = docs.reduce((s, d) => s + (d.emissionSummary?.totalEmissions?.CO2e || 0), 0);
  const monthsWithData = docs.length;
  const latestMonth    = Math.max(...docs.map(d => d.period?.month || 0));
  return { ytdTotal, monthsWithData, latestMonth, docs };
}

/**
 * Triggers a forecast computation using the specified method and stores a ForecastSnapshot.
 * Body: { calendarYear, forecastMethod? }
 */
async function computeForecastByMethod({ targetId, clientId, calendarYear, forecastMethod }) {
  const settings = await OrgSettings.findOne({ clientId });
  const method   = forecastMethod
    || settings?.forecast_method_default
    || ForecastMethod.LINEAR_EXTRAPOLATION;

  const today         = new Date();
  const yearStart     = new Date(calendarYear, 0, 1);
  const yearEnd       = new Date(calendarYear, 11, 31);
  const daysInYear    = 365 + (calendarYear % 4 === 0 ? 1 : 0);
  const daysElapsed   = Math.max(1, Math.floor((today - yearStart) / 86400000));
  const remainingDays = Math.max(0, Math.floor((yearEnd - today) / 86400000));

  const { ytdTotal, monthsWithData } = await pullYtdEmissions(clientId, calendarYear);

  let projected;
  let confidenceLower = null;
  let confidenceUpper = null;

  if (method === ForecastMethod.LINEAR_EXTRAPOLATION) {
    projected = daysElapsed > 0 ? ytdTotal * (daysInYear / daysElapsed) : ytdTotal;
    // ±10% confidence interval (simple heuristic)
    confidenceLower = projected * 0.9;
    confidenceUpper = projected * 1.1;

  } else if (method === ForecastMethod.YTD_ANNUALIZED) {
    projected = monthsWithData > 0 ? (ytdTotal / monthsWithData) * 12 : ytdTotal;
    confidenceLower = projected * 0.92;
    confidenceUpper = projected * 1.08;

  } else if (method === ForecastMethod.WEIGHTED_TRAILING_90D) {
    // Pull last 90 days worth of monthly data (3 most recent months)
    const trailing = await EmissionSummary.find({
      clientId,
      'period.type': 'monthly',
      'period.year': calendarYear,
    }).sort({ 'period.month': -1 }).limit(3).lean();

    const trailingTotal  = trailing.reduce((s, d) => s + (d.emissionSummary?.totalEmissions?.CO2e || 0), 0);
    const trailingMonths = Math.max(1, trailing.length);
    const trailingDays   = trailingMonths * 30.44; // approximate
    const dailyRate      = trailingTotal / trailingDays;
    projected            = ytdTotal + dailyRate * remainingDays;
    confidenceLower      = projected * 0.88;
    confidenceUpper      = projected * 1.12;

  } else {
    // CUSTOM or fallback
    projected = ytdTotal;
  }

  return computeForecastSnapshot({
    targetId, clientId,
    forecastDate:      today,
    snapshotType:      SnapshotType.ANNUAL,
    projectedEmissions: projected,
    calendarYear,
    forecastMethod:    method,
    confidenceLower,
    confidenceUpper,
    basisPeriodStart:  yearStart,
    basisPeriodEnd:    today,
  });
}

async function getForecast(targetId) {
  return ForecastSnapshot.find({ target_id: targetId }).sort({ forecast_date: -1 }).limit(20);
}

module.exports = { computeForecastSnapshot, computeForecastByMethod, getForecast };
