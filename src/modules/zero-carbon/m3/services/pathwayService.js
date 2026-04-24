'use strict';

// ============================================================================
// Pathway Service — Three calculation engines:
//   1. Absolute Contraction (linear annual)
//   2. SDA (Sectoral Decarbonization Approach)
//   3. Regulatory GEI (CCTS primary example)
// Plus: Residual position calculation
// ============================================================================

const PathwayAnnual = require('../models/PathwayAnnual');
const OperationalBudget = require('../models/OperationalBudget');
const OutputActivityRecord = require('../models/OutputActivityRecord');
const MethodLibrary = require('../models/MethodLibrary');
const OrgSettings = require('../models/OrgSettings');
const EmissionSummary = require('../../calculation/EmissionSummary');
const { computePathwayHash } = require('../utils/hashHelper');
const {
  MethodName, BudgetGranularity, SeasonalityMethod,
} = require('../constants/enums');
const { WARNINGS } = require('../constants/messages');

// ── Absolute Contraction Engine ──────────────────────────────────────────────

/**
 * allowed_Y = base_year_emissions × (1 - (reduction_pct × (Y - base_year) / (target_year - base_year)))
 */
function calcAbsoluteAllowed(baseEmissions, reductionPct, baseYear, targetYear, year) {
  return baseEmissions * (1 - (reductionPct / 100) * (year - baseYear) / (targetYear - baseYear));
}

// ── SDA Engine ───────────────────────────────────────────────────────────────

/**
 * allowed_GEI_Y = base_GEI × sectoral_curve_factor[Y]
 * Sectoral curve loaded from MethodLibrary.required_parameters.sectoralCurve = { year: factor }
 */
function calcSDAAllowed(baseGEI, sectoralCurve, year) {
  const factor = sectoralCurve[year];
  if (factor == null) return null;
  return baseGEI * factor;
}

// ── Main Pathway Generator ───────────────────────────────────────────────────

async function generatePathway(target) {
  const {
    _id: targetId, clientId,
    method_name, framework_name,
    base_year, base_year_emissions,
    target_year, target_reduction_pct,
  } = target;

  const rows = [];

  if (method_name === MethodName.Absolute_Contraction) {
    for (let year = base_year + 1; year <= target_year; year++) {
      const allowed = calcAbsoluteAllowed(
        base_year_emissions, target_reduction_pct, base_year, target_year, year
      );
      const hash = computePathwayHash(
        targetId, year, framework_name, method_name,
        { base_year_emissions, target_reduction_pct, base_year, target_year }
      );
      rows.push({ clientId, target_id: targetId, calendar_year: year, allowed_emissions: allowed, recompute_hash: hash });
    }
  } else if (method_name === MethodName.SDA) {
    const methodDoc = await MethodLibrary.findOne({ method_code: 'SDA' });
    const sectoralCurve = methodDoc?.required_parameters?.sectoralCurve || {};

    // base_GEI requires base-year output — skip if not available
    const baseOutput = await OutputActivityRecord.findOne({ target_id: targetId, calendar_year: base_year });
    if (!baseOutput) return;

    const baseGEI = base_year_emissions / baseOutput.output_value;

    for (let year = base_year + 1; year <= target_year; year++) {
      const allowedGEI = calcSDAAllowed(baseGEI, sectoralCurve, year);
      if (allowedGEI == null) continue;
      const hash = computePathwayHash(targetId, year, framework_name, method_name, { baseGEI, year });
      rows.push({
        clientId, target_id: targetId, calendar_year: year,
        allowed_emissions: allowedGEI,
        recompute_hash: hash,
      });
    }
  }
  // Regulatory GEI pathway stored per-compliance-year via complianceService, not here

  // Upsert pathway rows
  for (const row of rows) {
    await PathwayAnnual.findOneAndUpdate(
      { target_id: row.target_id, calendar_year: row.calendar_year },
      { $set: row },
      { upsert: true, new: true }
    );
  }

  // Derive operational budgets for newly created pathway rows
  if (rows.length > 0) {
    await deriveOperationalBudgets(targetId, clientId, rows);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the number of days in a given month/year (UTC). */
function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate(); // month is 1-based; Date(y,m,0) = last day of month m-1
}

/**
 * Resolves a 12-element monthly-weight array that sums to 1.0.
 * Falls back to EQUAL distribution and logs a warning when data is insufficient.
 */
async function resolveMonthlyWeights(method, settings, clientId, year) {
  if (method === SeasonalityMethod.M1_HISTORICAL) {
    const priorYear = year - 1;
    const docs = await EmissionSummary.find({
      clientId,
      'period.type': 'monthly',
      'period.year': priorYear,
    }).sort({ 'period.month': 1 }).lean();

    if (docs.length === 12) {
      const totals = docs.map(d => d.emissionSummary?.totalEmissions?.CO2e || 0);
      const sum = totals.reduce((a, b) => a + b, 0);
      if (sum > 0) {
        return totals.map(t => t / sum);
      }
    }
    // Insufficient data — fall back to EQUAL
    console.warn(WARNINGS.SEASONALITY_FALLBACK);
    return Array(12).fill(1 / 12);
  }

  if (method === SeasonalityMethod.CUSTOM_CURVE) {
    const curve = settings?.custom_seasonality_curve;
    if (Array.isArray(curve) && curve.length === 12) {
      const sum = curve.reduce((a, b) => a + b, 0);
      if (sum > 0) return curve.map(w => w / sum);
    }
    // No curve stored — fall back to EQUAL
    return Array(12).fill(1 / 12);
  }

  // EQUAL (default)
  return Array(12).fill(1 / 12);
}

// ── Operational Budget Derivation ────────────────────────────────────────────

/**
 * Derives ANNUAL, QUARTERLY, MONTHLY, and DAILY OperationalBudget documents
 * for each pathway row.  The monthly distribution is driven by OrgSettings
 * `seasonality_default_method` (EQUAL | M1_HISTORICAL | CUSTOM_CURVE).
 */
async function deriveOperationalBudgets(targetId, clientId, pathwayRows) {
  const settings = await OrgSettings.findOne({ clientId });
  const method   = settings?.seasonality_default_method || SeasonalityMethod.EQUAL;

  for (const row of pathwayRows) {
    const pathwayDoc = await PathwayAnnual.findOne({
      target_id: targetId,
      calendar_year: row.calendar_year,
    });
    if (!pathwayDoc) continue;

    const annual  = row.allowed_emissions;
    const year    = row.calendar_year;
    const baseSet = { clientId, parent_pathway_id: pathwayDoc._id, is_system_derived: true };

    // ── ANNUAL ────────────────────────────────────────────────────────────────
    await OperationalBudget.findOneAndUpdate(
      { target_id: targetId, granularity: BudgetGranularity.ANNUAL, period_key: String(year) },
      { $set: { ...baseSet, budget_emissions: annual } },
      { upsert: true }
    );

    // ── Resolve monthly weights (drives MONTHLY, QUARTERLY, DAILY) ─────────
    const weights = await resolveMonthlyWeights(method, settings, clientId, year);

    // ── MONTHLY ───────────────────────────────────────────────────────────────
    const monthlyBudgets = [];
    for (let m = 1; m <= 12; m++) {
      const budget     = annual * weights[m - 1];
      const periodKey  = `${year}-${String(m).padStart(2, '0')}`;
      monthlyBudgets.push(budget);
      await OperationalBudget.findOneAndUpdate(
        { target_id: targetId, granularity: BudgetGranularity.MONTHLY, period_key: periodKey },
        { $set: { ...baseSet, budget_emissions: budget } },
        { upsert: true }
      );
    }

    // ── QUARTERLY (Q1=Jan-Mar, Q2=Apr-Jun, Q3=Jul-Sep, Q4=Oct-Dec) ────────
    const quarterMonths = [[1,2,3],[4,5,6],[7,8,9],[10,11,12]];
    for (let q = 1; q <= 4; q++) {
      const qBudget   = quarterMonths[q - 1].reduce((s, m) => s + monthlyBudgets[m - 1], 0);
      const periodKey = `${year}-Q${q}`;
      await OperationalBudget.findOneAndUpdate(
        { target_id: targetId, granularity: BudgetGranularity.QUARTERLY, period_key: periodKey },
        { $set: { ...baseSet, budget_emissions: qBudget } },
        { upsert: true }
      );
    }

    // ── DAILY (budget = monthly / days_in_month per day) ─────────────────────
    for (let m = 1; m <= 12; m++) {
      const days       = daysInMonth(year, m);
      const dailyBudget = monthlyBudgets[m - 1] / days;
      for (let d = 1; d <= days; d++) {
        const periodKey = `${year}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        await OperationalBudget.findOneAndUpdate(
          { target_id: targetId, granularity: BudgetGranularity.DAILY, period_key: periodKey },
          { $set: { ...baseSet, budget_emissions: dailyBudget } },
          { upsert: true }
        );
      }
    }
  }
}

async function getPathway(targetId) {
  return PathwayAnnual.find({ target_id: targetId }).sort({ calendar_year: 1 });
}

async function getOperationalBudgets(targetId, granularity) {
  const query = { target_id: targetId };
  if (granularity) query.granularity = granularity;
  return OperationalBudget.find(query).sort({ period_key: 1 });
}

module.exports = {
  generatePathway,
  deriveOperationalBudgets,
  getPathway,
  getOperationalBudgets,
};
