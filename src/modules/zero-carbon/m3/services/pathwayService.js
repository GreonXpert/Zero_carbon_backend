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

// ── Operational Budget Derivation ────────────────────────────────────────────

async function deriveOperationalBudgets(targetId, clientId, pathwayRows) {
  const settings = await OrgSettings.findOne({ clientId });
  const method = settings?.seasonality_default_method || SeasonalityMethod.EQUAL;

  for (const row of pathwayRows) {
    const pathwayDoc = await PathwayAnnual.findOne({
      target_id: targetId,
      calendar_year: row.calendar_year,
    });
    if (!pathwayDoc) continue;

    const annual = row.allowed_emissions;

    if (method === SeasonalityMethod.EQUAL || method === SeasonalityMethod.CUSTOM_CURVE) {
      // Monthly equal distribution (CUSTOM_CURVE falls back to EQUAL in V1)
      const monthlyBudget = annual / 12;
      for (let m = 1; m <= 12; m++) {
        const periodKey = `${row.calendar_year}-${String(m).padStart(2, '0')}`;
        await OperationalBudget.findOneAndUpdate(
          { target_id: targetId, granularity: BudgetGranularity.MONTHLY, period_key: periodKey },
          {
            $set: {
              clientId,
              parent_pathway_id:  pathwayDoc._id,
              budget_emissions:   monthlyBudget,
              is_system_derived:  true,
            },
          },
          { upsert: true }
        );
      }
    } else if (method === SeasonalityMethod.M1_HISTORICAL) {
      // Fallback to EQUAL with warning if no historical data
      console.warn(WARNINGS.SEASONALITY_FALLBACK);
      const monthlyBudget = annual / 12;
      for (let m = 1; m <= 12; m++) {
        const periodKey = `${row.calendar_year}-${String(m).padStart(2, '0')}`;
        await OperationalBudget.findOneAndUpdate(
          { target_id: targetId, granularity: BudgetGranularity.MONTHLY, period_key: periodKey },
          {
            $set: {
              clientId,
              parent_pathway_id:  pathwayDoc._id,
              budget_emissions:   monthlyBudget,
              is_system_derived:  true,
            },
          },
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
