'use strict';

const ForecastSnapshot = require('../models/ForecastSnapshot');
const PathwayAnnual = require('../models/PathwayAnnual');
const SourceAllocation = require('../models/SourceAllocation');
const OrgSettings = require('../models/OrgSettings');
const DataQualityFlag = require('../models/DataQualityFlag');
const TargetMaster = require('../models/TargetMaster');
const EmissionSummary = require('../../calculation/EmissionSummary');
const SeasonalProfile = require('../models/SeasonalProfile');
const { extractCO2eForScopeBoundary } = require('./emissionSummaryScopeService');
const { ForecastStatus, ForecastMethod, SnapshotType, DQFlagCode, Severity } = require('../constants/enums');
const { WARNINGS } = require('../constants/messages');

/**
 * Returns normalised seasonal weight per month (keys 1–12, values sum to 1.0)
 * derived from the previous year's actual monthly emissions.
 * Falls back to uniform 1/12 per month when no prior-year data is available.
 */
async function getSeasonalWeights(clientId, calendarYear, scopeBoundary = null, scope3CoveragePct = 100, targetId = null) {
  const UNIFORM = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, 1 / 12]));

  // ── Tier 1: prior-year monthly EmissionSummary ────────────────────────────
  const docs = await EmissionSummary.find({
    clientId,
    'period.type': 'monthly',
    'period.year': calendarYear - 1,
  }).lean();

  if (docs.length > 0) {
    const monthlyTotals = {};
    let total = 0;
    for (const doc of docs) {
      const m    = doc.period.month;
      const co2e = scopeBoundary
        ? extractCO2eForScopeBoundary(doc, scopeBoundary, scope3CoveragePct).CO2e
        : (doc.emissionSummary?.totalEmissions?.CO2e || 0);
      monthlyTotals[m] = (monthlyTotals[m] || 0) + co2e;
      total += co2e;
    }

    if (total > 0) {
      const avgMonthly = total / Object.keys(monthlyTotals).length;
      for (let m = 1; m <= 12; m++) {
        if (monthlyTotals[m] === undefined) monthlyTotals[m] = avgMonthly;
      }
      const adjustedTotal = Object.values(monthlyTotals).reduce((s, v) => s + v, 0);
      const weights = {};
      for (let m = 1; m <= 12; m++) weights[m] = monthlyTotals[m] / adjustedTotal;
      return { weights, hasPriorData: true };
    }
  }

  // ── Tier 2: manual SeasonalProfile for this target ────────────────────────
  if (targetId) {
    const profile = await SeasonalProfile.findOne({ target_id: targetId, calendar_year: calendarYear }).lean();
    if (profile && profile.monthly_weights && profile.monthly_weights.length === 12) {
      const total = profile.monthly_weights.reduce((s, v) => s + v, 0);
      if (total > 0) {
        const weights = {};
        for (let m = 1; m <= 12; m++) weights[m] = profile.monthly_weights[m - 1] / total;
        return { weights, hasPriorData: true, fromSeasonalProfile: true };
      }
    }
  }

  // ── Tier 3: uniform fallback ──────────────────────────────────────────────
  return { weights: UNIFORM, hasPriorData: false };
}

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
  vsBaselineStatus = null,
  ytdExpected = null,
  baselineProjected = null,
  monthlyAllowed = [],
  monthlyBaseline = [],
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
        vs_budget_status:     status,
        at_risk_indicator:    atRisk,
        forecast_method:      forecastMethod,
        confidence_lower:     confidenceLower,
        confidence_upper:     confidenceUpper,
        basis_period_start:   basisPeriodStart,
        basis_period_end:     basisPeriodEnd,
        allocation_forecasts: allocationForecasts,
        is_primary:           isPrimary,
        ...(vsBaselineStatus != null  && { vs_baseline_status: vsBaselineStatus }),
        ...(ytdExpected       != null  && { ytd_expected:       ytdExpected }),
        ...(baselineProjected != null  && { baseline_projected: baselineProjected }),
        ...(monthlyAllowed.length > 0  && { monthly_allowed:    monthlyAllowed }),
        ...(monthlyBaseline.length > 0 && { monthly_baseline:   monthlyBaseline }),
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
async function pullPeriodEmissions(clientId, start, end, scopeBoundary = null, scope3CoveragePct = 100) {
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
  return docs.reduce((s, d) => {
    const co2e = scopeBoundary
      ? extractCO2eForScopeBoundary(d, scopeBoundary, scope3CoveragePct).CO2e
      : (d.emissionSummary?.totalEmissions?.CO2e || 0);
    return s + co2e;
  }, 0);
}

// ── Forecast Method Engines ───────────────────────────────────────────────────

/**
 * Pulls YTD monthly CO2e totals from M1 EmissionSummary for a given year,
 * up to the most recently available month.
 * Returns { ytdTotal, monthsWithData, latestMonth, docs }
 */
async function pullYtdEmissions(clientId, year, scopeBoundary = null, scope3CoveragePct = 100) {
  // ── Tier 1: monthly EmissionSummary docs ──────────────────────────────────
  const allDocs = await EmissionSummary.find({
    clientId,
    'period.type': 'monthly',
    'period.year': year,
  }).sort({ 'period.month': 1 }).lean();

  if (allDocs.length > 0) {
    // Only include months up to the current calendar month — future months
    // in the DB (e.g. a July doc computed in June) must not inflate latestMonth
    // or the elapsed seasonal share, which would deflate the annualised projection.
    const today        = new Date();
    const currentMonth = year < today.getFullYear()
      ? 12                          // completed past year — include all months
      : today.getMonth() + 1;       // current year — cap to today's month

    const docs = allDocs.filter(d => (d.period?.month || 0) <= currentMonth);

    if (docs.length > 0) {
      const ytdTotal = docs.reduce((s, d) => {
        const co2e = scopeBoundary
          ? extractCO2eForScopeBoundary(d, scopeBoundary, scope3CoveragePct).CO2e
          : (d.emissionSummary?.totalEmissions?.CO2e || 0);
        return s + co2e;
      }, 0);

      if (ytdTotal > 0) {
        const monthsWithData = docs.length;
        const latestMonth    = Math.max(...docs.map(d => d.period?.month || 0));
        return { ytdTotal, monthsWithData, latestMonth, docs };
      }
    }
  }

  // ── Tier 2: yearly doc fallback (when monthly docs missing or all-zero) ───
  // Treat the yearly total as YTD since data was entered for the current year.
  // Use today's month as latestMonth for seasonal share calculations.
  const yearlyDoc = await EmissionSummary.findOne({
    clientId,
    'period.type': 'yearly',
    'period.year': year,
  }).lean();

  if (yearlyDoc) {
    const co2e = scopeBoundary
      ? extractCO2eForScopeBoundary(yearlyDoc, scopeBoundary, scope3CoveragePct).CO2e
      : (yearlyDoc.emissionSummary?.totalEmissions?.CO2e || 0);
    if (co2e > 0) {
      const today          = new Date();
      const latestMonth    = today.getMonth() + 1;           // 1–12
      const monthsWithData = latestMonth;
      return { ytdTotal: co2e, monthsWithData, latestMonth, docs: docs.length > 0 ? docs : [yearlyDoc], usedYearlyFallback: true };
    }
  }

  // ── Tier 3: no data found ─────────────────────────────────────────────────
  return { ytdTotal: 0, monthsWithData: 0, latestMonth: 0, docs: [] };
}

/**
 * Applies the chosen forecast method to a YTD total and returns { projected, confidenceLower, confidenceUpper }.
 * Pure function — no DB calls.
 */
function applyForecastMethod({
  method, ytdTotal, monthsWithData, daysInYear, daysElapsed,
  remainingDays, trailingTotal, trailingDays, elapsedSeasonalShare,
  prevYearTotal = 0,       // prior year's full-year total (for Linear Extrapolation)
  remainingPeriods = 0,    // periods (months/days/quarters/halves) left in year
  periodsInYear = 12,      // total periods in a year for the chosen snapshot type
  latestMonth = 0,         // last month with data (for CUSTOM slicing)
  customMonthlyValues = null, // [12] array for CUSTOM method
}) {
  if (method === ForecastMethod.LINEAR_EXTRAPOLATION) {
    // Use previous year's average rate per period for remaining periods
    if (prevYearTotal > 0 && periodsInYear > 0 && remainingPeriods >= 0) {
      const ratePerPeriod = prevYearTotal / periodsInYear;
      const projected = ytdTotal + ratePerPeriod * remainingPeriods;
      return { projected, confidenceLower: projected * 0.9, confidenceUpper: projected * 1.1 };
    }
    // Fallback: current-year day-based extrapolation (when no prior year data)
    const projected = daysElapsed > 0 ? ytdTotal * (daysInYear / daysElapsed) : ytdTotal;
    return { projected, confidenceLower: projected * 0.9, confidenceUpper: projected * 1.1 };
  }
  if (method === ForecastMethod.YTD_ANNUALIZED) {
    // Uses prior-year monthly EmissionSummary shares (via elapsedSeasonalShare)
    const projected = (elapsedSeasonalShare > 0)
      ? ytdTotal / elapsedSeasonalShare
      : (monthsWithData > 0 ? (ytdTotal / monthsWithData) * 12 : ytdTotal);
    return { projected, confidenceLower: projected * 0.92, confidenceUpper: projected * 1.08 };
  }
  if (method === ForecastMethod.WEIGHTED_TRAILING_90D) {
    const dailyRate = trailingTotal / Math.max(1, trailingDays);
    const projected = ytdTotal + dailyRate * remainingDays;
    return { projected, confidenceLower: projected * 0.88, confidenceUpper: projected * 1.12 };
  }
  if (method === ForecastMethod.CUSTOM) {
    if (customMonthlyValues && customMonthlyValues.length === 12) {
      // Sum the custom values for months not yet elapsed (remaining months)
      const remainingCustom = customMonthlyValues
        .slice(latestMonth)           // months after the latest month with actual data
        .reduce((s, v) => s + (Number(v) || 0), 0);
      const projected = ytdTotal + remainingCustom;
      return { projected, confidenceLower: null, confidenceUpper: null };
    }
    return { projected: ytdTotal, confidenceLower: null, confidenceUpper: null };
  }
  // Fallback
  return { projected: ytdTotal, confidenceLower: null, confidenceUpper: null };
}

/**
 * Builds the allocationForecasts array for a single period given ytd emissions for that period.
 */
function buildAllocationForecasts(
  allocations, periodYtd, annualAllowed, periodFraction,
  methodArgs, threshold,
  { isPast, isFuture, annualProjected, futureShare } = {}
) {
  return allocations.map((alloc) => {
    const effectivePct =
      ((alloc.scopeAllocationPct    || 0) / 100) *
      ((alloc.categoryAllocationPct || 0) / 100) *
      ((alloc.nodeAllocationPct     || 0) / 100) *
      ((alloc.scopeDetailAllocationPct || 0) / 100);

    const allocYtd = periodYtd * effectivePct;

    let allocProjected, allocLow, allocHigh;
    if (isPast) {
      allocProjected = allocYtd;
      allocLow = allocHigh = null;
    } else if (isFuture && annualProjected != null) {
      allocProjected = annualProjected * effectivePct * (futureShare ?? periodFraction);
      allocLow  = allocProjected * 0.88;
      allocHigh = allocProjected * 1.12;
    } else if (methodArgs && methodArgs.method) {
      // Annual path or fallback — use existing method engine
      const trailingFrac = (methodArgs.trailingTotal || 0) * effectivePct;
      const res = applyForecastMethod({ ...methodArgs, ytdTotal: allocYtd, trailingTotal: trailingFrac });
      allocProjected = res.projected;
      allocLow  = res.confidenceLower;
      allocHigh = res.confidenceUpper;
    } else {
      // Current in-progress sub-period — actual so far
      allocProjected = allocYtd;
      allocLow = allocHigh = null;
    }

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
async function computeForecastByMethod({ targetId, clientId, calendarYear, forecastMethod, snapshotType = SnapshotType.ANNUAL, isPrimary = true, customValues = null }) {
  const [settings, pathway, target] = await Promise.all([
    OrgSettings.findOne({ clientId }),
    PathwayAnnual.findOne({ target_id: targetId, calendar_year: calendarYear }),
    TargetMaster.findById(targetId).lean(),
  ]);

  // Scope boundary from the target — all emission pulls are filtered to these scopes only
  const scopeBoundary     = target?.scope_boundary     || null;
  const scope3CoveragePct = target?.scope3_coverage_pct ?? 100;

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
    const { ytdTotal, monthsWithData, latestMonth } = await pullYtdEmissions(clientId, calendarYear, scopeBoundary, scope3CoveragePct);

    // Seasonal weights for YTD_ANNUALIZED: divide ytdTotal by the elapsed months' share
    const { weights: seasonalWeights, hasPriorData } = await getSeasonalWeights(clientId, calendarYear, scopeBoundary, scope3CoveragePct, targetId);
    const elapsedSeasonalShare = latestMonth > 0
      ? Array.from({ length: latestMonth }, (_, i) => seasonalWeights[i + 1] || 1 / 12)
          .reduce((s, w) => s + w, 0)
      : 0;

    let trailingTotal = 0, trailingDays = 30.44;
    if (method === ForecastMethod.WEIGHTED_TRAILING_90D) {
      const trailing = await EmissionSummary.find({
        clientId,
        'period.type': 'monthly',
        'period.year': calendarYear,
      }).sort({ 'period.month': -1 }).limit(3).lean();
      trailingTotal = trailing.reduce((s, d) => {
        const co2e = scopeBoundary
          ? extractCO2eForScopeBoundary(d, scopeBoundary, scope3CoveragePct).CO2e
          : (d.emissionSummary?.totalEmissions?.CO2e || 0);
        return s + co2e;
      }, 0);
      trailingDays  = Math.max(1, trailing.length) * 30.44;
    }

    // Prior-year total for Linear Extrapolation (reuse priorYearDocs fetched below)
    // NOTE: priorYearDocs is fetched after this block; compute prevYearTotal lazily
    // We fetch priorYearDocs early here so LINEAR_EXTRAPOLATION can use it
    const _priorYearDocsForMethod = await EmissionSummary.find({
      clientId, 'period.type': 'monthly', 'period.year': calendarYear - 1,
    }).lean();
    const prevYearTotal = _priorYearDocsForMethod.reduce((s, d) => {
      return s + (scopeBoundary
        ? extractCO2eForScopeBoundary(d, scopeBoundary, scope3CoveragePct).CO2e
        : (d.emissionSummary?.totalEmissions?.CO2e || 0));
    }, 0);
    const remainingPeriods = 12 - latestMonth;   // remaining months in the year

    const methodArgs = {
      method, ytdTotal, monthsWithData, daysInYear, daysElapsed, remainingDays,
      trailingTotal, trailingDays, elapsedSeasonalShare,
      prevYearTotal, remainingPeriods, periodsInYear: 12,
      latestMonth,
      customMonthlyValues: customValues,
    };
    const { projected, confidenceLower, confidenceUpper } = applyForecastMethod(methodArgs);

    // ── Dual-status: vs Baseline ──────────────────────────────────────────────
    // Expected YTD at today's date = allowed_emissions × share of year elapsed (seasonal)
    const annualAllowed = pathway ? pathway.allowed_emissions : 0;
    const ytdExpected   = annualAllowed * elapsedSeasonalShare;
    const vsBaselineStatus = pathway
      ? computeForecastStatus(ytdTotal, ytdExpected, threshold)
      : ForecastStatus.On_Track;

    // ── Monthly budget + baseline arrays for chart ────────────────────────────
    // monthly_allowed[i] = annual budget × seasonalWeight[month i+1]
    // monthly_baseline[i] = prior-year monthly actuals (if available) scaled to current budget
    const monthlyAllowed = [];
    for (let m = 1; m <= 12; m++) {
      monthlyAllowed.push({ month: m, allowed_co2e: annualAllowed * (seasonalWeights[m] || 1 / 12) });
    }

    // Reuse already-fetched prior-year monthly docs (also used for Linear Extrapolation above)
    const priorYearDocs = _priorYearDocsForMethod;
    let monthlyBaseline = [];
    if (priorYearDocs.length > 0) {
      const priorTotal = priorYearDocs.reduce((s, d) => {
        return s + (scopeBoundary
          ? extractCO2eForScopeBoundary(d, scopeBoundary, scope3CoveragePct).CO2e
          : (d.emissionSummary?.totalEmissions?.CO2e || 0));
      }, 0);
      const scaleFactor = priorTotal > 0 ? annualAllowed / priorTotal : 1;
      for (let m = 1; m <= 12; m++) {
        const priorDoc = priorYearDocs.find(d => d.period?.month === m);
        const priorCo2e = priorDoc
          ? (scopeBoundary
              ? extractCO2eForScopeBoundary(priorDoc, scopeBoundary, scope3CoveragePct).CO2e
              : (priorDoc.emissionSummary?.totalEmissions?.CO2e || 0))
          : 0;
        monthlyBaseline.push({ month: m, baseline_co2e: priorCo2e * scaleFactor });
      }
    }

    let allocationForecasts = [];
    if (pathway) {
      const allocations = await SourceAllocation.find({
        target_id: targetId,
        reconciliation_status: { $in: ['APPROVED', 'ACTIVE'] },
        isDeleted: false,
      }).lean();
      allocationForecasts = buildAllocationForecasts(allocations, ytdTotal, pathway.allowed_emissions, 1, methodArgs, threshold, {});
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
      vsBaselineStatus,
      ytdExpected,
      baselineProjected:   pathway ? annualAllowed : 0,
      monthlyAllowed,
      monthlyBaseline,
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

  const { weights: seasonalWeights } = await getSeasonalWeights(clientId, calendarYear, scopeBoundary, scope3CoveragePct, targetId);

  // Compute the annual projection once — used to fill projected values for future sub-periods
  const { ytdTotal: annualYtdTotal, latestMonth: annualLatestMonth } =
    await pullYtdEmissions(clientId, calendarYear, scopeBoundary, scope3CoveragePct);
  const annualElapsedShare = annualLatestMonth > 0
    ? Array.from({ length: annualLatestMonth }, (_, i) => seasonalWeights[i + 1] || 1 / 12)
        .reduce((s, w) => s + w, 0)
    : 0;
  const annualProjected = annualElapsedShare > 0
    ? annualYtdTotal / annualElapsedShare
    : pathway.allowed_emissions;

  const periods = getSubPeriods(snapshotType, calendarYear);
  const results = [];

  for (const period of periods) {
    const periodDays = Math.max(1, Math.round((period.end - period.start) / 86400000));

    let periodFraction, periodAllowed;
    if (snapshotType === SnapshotType.MONTHLY) {
      const monthNum = period.start.getMonth() + 1;
      periodFraction = seasonalWeights[monthNum] || 1 / 12;
      periodAllowed  = pathway.allowed_emissions * periodFraction;
    } else if (snapshotType === SnapshotType.QUARTERLY || snapshotType === SnapshotType.HALF_YEARLY) {
      const startMonth = period.start.getMonth() + 1;
      const endMonth   = period.end.getMonth()   + 1;
      periodFraction = 0;
      for (let m = startMonth; m <= endMonth; m++) periodFraction += (seasonalWeights[m] || 1 / 12);
      periodAllowed = pathway.allowed_emissions * periodFraction;
    } else {
      // DAILY: distribute the month's seasonal weight evenly across its days
      const monthNum        = period.start.getMonth() + 1;
      const monthWeight     = seasonalWeights[monthNum] || 1 / 12;
      const daysInThisMonth = new Date(period.start.getFullYear(), monthNum, 0).getDate();
      periodFraction = monthWeight / daysInThisMonth;
      periodAllowed  = pathway.allowed_emissions * periodFraction;
    }

    const periodYtd = await pullPeriodEmissions(clientId, period.start, period.end, scopeBoundary, scope3CoveragePct);

    // Determine whether this period is in the past, future, or currently in progress
    const isPast   = period.end   < today;
    const isFuture = period.start > today;

    let projected, confidenceLower, confidenceUpper;
    if (isPast) {
      // Actual completed period — store real recorded emissions at period scale (not annualized)
      projected = periodYtd;
      confidenceLower = null;
      confidenceUpper = null;
    } else if (isFuture) {
      // Future period — seasonal share of the annual projection
      projected = annualProjected * periodFraction;
      confidenceLower = projected * 0.88;
      confidenceUpper = projected * 1.12;
    } else {
      // Current in-progress period — actual recorded so far (partial)
      projected = periodYtd;
      confidenceLower = null;
      confidenceUpper = null;
    }

    const allocationForecasts = buildAllocationForecasts(
      allocations, periodYtd, pathway.allowed_emissions, periodFraction,
      {}, threshold,
      { isPast, isFuture, annualProjected, futureShare: periodFraction }
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
