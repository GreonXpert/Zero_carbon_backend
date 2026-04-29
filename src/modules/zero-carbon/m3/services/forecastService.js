'use strict';

const ForecastSnapshot = require('../models/ForecastSnapshot');
const PathwayAnnual = require('../models/PathwayAnnual');
const SourceAllocation = require('../models/SourceAllocation');
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
 *
 * @param {number|null} allowedEmissionsOverride - When provided, skips PathwayAnnual lookup and
 *   uses this value directly (used for sub-period snapshots where budget is pro-rated).
 */
async function computeForecastSnapshot({
  targetId, clientId, forecastDate, snapshotType = SnapshotType.ANNUAL,
  projectedEmissions, calendarYear,
  forecastMethod = ForecastMethod.LINEAR_EXTRAPOLATION,
  confidenceLower = null, confidenceUpper = null,
  basisPeriodStart = null, basisPeriodEnd = null,
  allocationForecasts = [],
  allowedEmissionsOverride = null,
  isPrimary = true,
}) {
  let allowedEmissions;

  if (allowedEmissionsOverride != null) {
    // Sub-period path: budget is already pro-rated by caller
    allowedEmissions = allowedEmissionsOverride;
  } else {
    // Annual path: look up pathway
    const pathway = await PathwayAnnual.findOne({ target_id: targetId, calendar_year: calendarYear });
    if (!pathway) {
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
    allowedEmissions = pathway.allowed_emissions;
  }

  const settings = await OrgSettings.findOne({ clientId });
  const threshold = settings?.forecast_at_risk_threshold_pct ?? 5;
  const status    = computeForecastStatus(projectedEmissions, allowedEmissions, threshold);
  const atRisk    = status !== ForecastStatus.On_Track;

  if (atRisk) console.warn(WARNINGS.FORECAST_AT_RISK);

  // Primary snapshots: one per (target, type, date) — auto-recompute overwrites them in place.
  // Comparison snapshots: keyed by method too — a different method gets its own document.
  const filter = isPrimary
    ? { target_id: targetId, snapshot_type: snapshotType, forecast_date: forecastDate }
    : { target_id: targetId, snapshot_type: snapshotType, forecast_date: forecastDate, forecast_method: forecastMethod, is_primary: false };

  return ForecastSnapshot.findOneAndUpdate(
    filter,
    {
      $set: {
        clientId,
        projected_emissions:  projectedEmissions,
        allowed_emissions:    allowedEmissions,
        forecast_status:      status,
        at_risk_indicator:    atRisk,
        forecast_method:      forecastMethod,
        confidence_lower:     confidenceLower,
        confidence_upper:     confidenceUpper,
        basis_period_start:   basisPeriodStart,
        basis_period_end:     basisPeriodEnd,
        allocation_forecasts: allocationForecasts,
        is_primary:           isPrimary,
      },
    },
    { upsert: true, new: true }
  );
}

// ── Sub-period helpers ────────────────────────────────────────────────────────

/**
 * Returns array of { start, end, label } for each sub-period in the given year.
 * For DAILY: last 30 days relative to today.
 * For ANNUAL: single period covering the full year.
 */
function getSubPeriods(snapshotType, calendarYear) {
  if (snapshotType === SnapshotType.MONTHLY) {
    return Array.from({ length: 12 }, (_, i) => {
      const start = new Date(calendarYear, i, 1);
      const end   = new Date(calendarYear, i + 1, 0); // last day of month
      return { start, end };
    });
  }
  if (snapshotType === SnapshotType.QUARTERLY) {
    return [0, 1, 2, 3].map((q) => ({
      start: new Date(calendarYear, q * 3, 1),
      end:   new Date(calendarYear, q * 3 + 3, 0),
    }));
  }
  if (snapshotType === SnapshotType.HALF_YEARLY) {
    return [
      { start: new Date(calendarYear, 0, 1),  end: new Date(calendarYear, 5, 30) },
      { start: new Date(calendarYear, 6, 1),  end: new Date(calendarYear, 11, 31) },
    ];
  }
  if (snapshotType === SnapshotType.DAILY) {
    const today = new Date();
    return Array.from({ length: 30 }, (_, i) => {
      const d = new Date(today);
      d.setDate(today.getDate() - (29 - i));
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
      const end   = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
      return { start, end };
    });
  }
  // ANNUAL (or unknown) — single full-year period
  return [{ start: new Date(calendarYear, 0, 1), end: new Date(calendarYear, 11, 31) }];
}

/**
 * Pulls total CO2e emissions from EmissionSummary for the given date range.
 * Uses monthly docs only (finest granularity available from M1).
 */
async function pullPeriodEmissions(clientId, start, end) {
  const docs = await EmissionSummary.find({
    clientId,
    'period.type': 'monthly',
    $expr: {
      $and: [
        { $gte: [{ $dateFromParts: { year: '$period.year', month: '$period.month' } }, start] },
        { $lte: [{ $dateFromParts: { year: '$period.year', month: '$period.month' } }, end] },
      ],
    },
  }).lean();
  return docs.reduce((s, d) => s + (d.emissionSummary?.totalEmissions?.CO2e || 0), 0);
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
 * Applies the chosen forecast method to a YTD total and returns { projected, confidenceLower, confidenceUpper }.
 * Pure function — no DB calls.
 */
function applyForecastMethod({ method, ytdTotal, monthsWithData, daysInYear, daysElapsed, remainingDays, trailingTotal, trailingDays }) {
  if (method === ForecastMethod.LINEAR_EXTRAPOLATION) {
    const projected = daysElapsed > 0 ? ytdTotal * (daysInYear / daysElapsed) : ytdTotal;
    return { projected, confidenceLower: projected * 0.9, confidenceUpper: projected * 1.1 };
  }
  if (method === ForecastMethod.YTD_ANNUALIZED) {
    const projected = monthsWithData > 0 ? (ytdTotal / monthsWithData) * 12 : ytdTotal;
    return { projected, confidenceLower: projected * 0.92, confidenceUpper: projected * 1.08 };
  }
  if (method === ForecastMethod.WEIGHTED_TRAILING_90D) {
    const dailyRate = trailingTotal / Math.max(1, trailingDays);
    const projected = ytdTotal + dailyRate * remainingDays;
    return { projected, confidenceLower: projected * 0.88, confidenceUpper: projected * 1.12 };
  }
  // CUSTOM / fallback
  return { projected: ytdTotal, confidenceLower: null, confidenceUpper: null };
}

/**
 * Builds the allocationForecasts array for a single period given ytd emissions for that period.
 */
function buildAllocationForecasts(allocations, periodYtd, annualAllowed, periodFraction, methodArgs, threshold) {
  return allocations.map((alloc) => {
    const effectivePct =
      ((alloc.scopeAllocationPct    || 0) / 100) *
      ((alloc.categoryAllocationPct || 0) / 100) *
      ((alloc.nodeAllocationPct     || 0) / 100) *
      ((alloc.scopeDetailAllocationPct || 0) / 100);

    const allocYtd     = periodYtd * effectivePct;
    const trailingFrac = (methodArgs.trailingTotal || 0) * effectivePct;

    const { projected: allocProjected, confidenceLower: allocLow, confidenceUpper: allocHigh } =
      applyForecastMethod({ ...methodArgs, ytdTotal: allocYtd, trailingTotal: trailingFrac });

    const allocBudget = annualAllowed * effectivePct * periodFraction;
    const allocStatus = computeForecastStatus(allocProjected, allocBudget, threshold);

    return {
      allocation_id:               alloc._id,
      source_code:                 alloc.source_code,
      facility_id:                 alloc.facility_id || alloc.nodeLabel || '',
      category_name:               alloc.categoryName || '',
      scope_type:                  alloc.scopeType || '',
      business_unit_id:            alloc.business_unit_id || null,
      scope_allocation_pct:        alloc.scopeAllocationPct    || 0,
      category_allocation_pct:     alloc.categoryAllocationPct || 0,
      node_allocation_pct:         alloc.nodeAllocationPct     || 0,
      scope_detail_allocation_pct: alloc.scopeDetailAllocationPct || 0,
      effective_pct:               Math.round(effectivePct * 1e6) / 1e4,
      ytd_emissions:               allocYtd,
      allocated_budget:            allocBudget,
      projected_emissions:         allocProjected,
      forecast_status:             allocStatus,
      confidence_lower:            allocLow,
      confidence_upper:            allocHigh,
    };
  });
}

/**
 * Triggers a forecast computation using the specified method and stores ForecastSnapshot(s).
 * - snapshotType = 'ANNUAL' (default): one snapshot, returns it directly (backward-compatible).
 * - snapshotType = sub-period (MONTHLY/QUARTERLY/HALF_YEARLY/DAILY): computes one snapshot per
 *   sub-period, stores all, returns array of snapshots.
 * When APPROVED/ACTIVE allocations exist the forecast is also broken down per allocation.
 */
async function computeForecastByMethod({ targetId, clientId, calendarYear, forecastMethod, snapshotType = SnapshotType.ANNUAL, isPrimary = true }) {
  const [settings, pathway] = await Promise.all([
    OrgSettings.findOne({ clientId }),
    PathwayAnnual.findOne({ target_id: targetId, calendar_year: calendarYear }),
  ]);

  if (!pathway && snapshotType === SnapshotType.ANNUAL) return null; // handled by computeForecastSnapshot

  const method    = forecastMethod || settings?.forecast_method_default || ForecastMethod.LINEAR_EXTRAPOLATION;
  const threshold = settings?.forecast_at_risk_threshold_pct ?? 5;

  const today      = new Date();
  const yearStart  = new Date(calendarYear, 0, 1);
  const yearEnd    = new Date(calendarYear, 11, 31);
  const daysInYear = 365 + (calendarYear % 4 === 0 ? 1 : 0);

  // ── ANNUAL path (unchanged behaviour) ─────────────────────────────────────
  if (snapshotType === SnapshotType.ANNUAL) {
    const daysElapsed   = Math.max(1, Math.floor((today - yearStart) / 86400000));
    const remainingDays = Math.max(0, Math.floor((yearEnd - today) / 86400000));
    const { ytdTotal, monthsWithData } = await pullYtdEmissions(clientId, calendarYear);

    let trailingTotal = 0, trailingDays = 30.44;
    if (method === ForecastMethod.WEIGHTED_TRAILING_90D) {
      const trailing = await EmissionSummary.find({
        clientId,
        'period.type': 'monthly',
        'period.year': calendarYear,
      }).sort({ 'period.month': -1 }).limit(3).lean();
      trailingTotal = trailing.reduce((s, d) => s + (d.emissionSummary?.totalEmissions?.CO2e || 0), 0);
      trailingDays  = Math.max(1, trailing.length) * 30.44;
    }

    const methodArgs = { method, ytdTotal, monthsWithData, daysInYear, daysElapsed, remainingDays, trailingTotal, trailingDays };
    const { projected, confidenceLower, confidenceUpper } = applyForecastMethod(methodArgs);

    let allocationForecasts = [];
    if (pathway) {
      const allocations = await SourceAllocation.find({
        target_id: targetId,
        reconciliation_status: { $in: ['APPROVED', 'ACTIVE'] },
        isDeleted: false,
      }).lean();
      allocationForecasts = buildAllocationForecasts(allocations, ytdTotal, pathway.allowed_emissions, 1, methodArgs, threshold);
    }

    return computeForecastSnapshot({
      targetId, clientId,
      forecastDate:        today,
      snapshotType:        SnapshotType.ANNUAL,
      projectedEmissions:  projected,
      calendarYear,
      forecastMethod:      method,
      confidenceLower,
      confidenceUpper,
      basisPeriodStart:    yearStart,
      basisPeriodEnd:      today,
      allocationForecasts,
      isPrimary,
    });
  }

  // ── Sub-period path ────────────────────────────────────────────────────────
  if (!pathway) {
    // Raise DQ flag for missing pathway and return empty array
    await DataQualityFlag.findOneAndUpdate(
      { clientId, entity_type: 'TargetMaster', entity_id: String(targetId), flag_code: DQFlagCode.FORECAST_DATA_UNAVAILABLE, resolved: false },
      { $setOnInsert: { severity: Severity.INFO, message: WARNINGS.FORECAST_AT_RISK, remediation_hint: 'Ensure pathway has been generated for this target.' } },
      { upsert: true }
    );
    return [];
  }

  const allocations = await SourceAllocation.find({
    target_id: targetId,
    reconciliation_status: { $in: ['APPROVED', 'ACTIVE'] },
    isDeleted: false,
  }).lean();

  const periods = getSubPeriods(snapshotType, calendarYear);
  const results = [];

  for (const period of periods) {
    const periodDays     = Math.max(1, Math.round((period.end - period.start) / 86400000));
    const periodFraction = periodDays / daysInYear;
    const periodAllowed  = pathway.allowed_emissions * periodFraction;

    const periodYtd = await pullPeriodEmissions(clientId, period.start, period.end);

    // Build methodArgs with period-scoped timing values
    const daysElapsed   = Math.max(1, Math.floor((Math.min(today, period.end) - period.start) / 86400000));
    const remainingDays = Math.max(0, Math.floor((period.end - today) / 86400000));
    const methodArgs = {
      method,
      ytdTotal:       periodYtd,
      monthsWithData: periodYtd > 0 ? 1 : 0,
      daysInYear:     periodDays,  // treat period length as the "year" for extrapolation
      daysElapsed,
      remainingDays,
      trailingTotal:  0,
      trailingDays:   30.44,
    };

    const { projected, confidenceLower, confidenceUpper } = applyForecastMethod(methodArgs);

    const allocationForecasts = buildAllocationForecasts(
      allocations, periodYtd, pathway.allowed_emissions, periodFraction, methodArgs, threshold
    );

    const snap = await computeForecastSnapshot({
      targetId, clientId,
      forecastDate:            period.end,
      snapshotType,
      projectedEmissions:      projected,
      calendarYear,
      forecastMethod:          method,
      confidenceLower,
      confidenceUpper,
      basisPeriodStart:        period.start,
      basisPeriodEnd:          period.end,
      allocationForecasts,
      allowedEmissionsOverride: periodAllowed,
      isPrimary,
    });

    if (snap) results.push(snap);
  }

  return results;
}

/**
 * Returns forecast snapshots for a target.
 * @param {boolean|null} isPrimary  true = live tracking snapshots (default),
 *                                  false = comparison-only snapshots,
 *                                  null  = all snapshots regardless of type
 */
async function getForecast(targetId, snapshotType = SnapshotType.ANNUAL, isPrimary = true) {
  const filter = { target_id: targetId };
  if (snapshotType) filter.snapshot_type = snapshotType;
  if (isPrimary !== null) filter.is_primary = isPrimary;
  return ForecastSnapshot.find(filter).sort({ forecast_date: -1 }).limit(50);
}

module.exports = { computeForecastSnapshot, computeForecastByMethod, getForecast };
