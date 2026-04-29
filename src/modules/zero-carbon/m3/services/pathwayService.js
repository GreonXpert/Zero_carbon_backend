'use strict';

// ============================================================================
// Pathway Service — Seven calculation engines:
//   1. Absolute Contraction (linear annual absolute reduction)
//   2. SDA (Sectoral Decarbonization – intensity via sector curve)
//   3. Regulatory GEI (CCTS – flat intensity cap each year)
//   4. RE Tracking (Renewable Electricity %, linear to target)
//   5. Supplier Engagement Tracking (engagement %, linear to target)
//   6. FLAG (Forests, Land & Agriculture – ACL on land-use emissions)
//   7. Internal Custom (ACL logic on base_year_emissions)
//   8. Residual Offset (ISO 14068 – net emissions linear toward 0)
// ============================================================================

const PathwayAnnual    = require('../models/PathwayAnnual');
const OperationalBudget = require('../models/OperationalBudget');
const MethodLibrary    = require('../models/MethodLibrary');
const OrgSettings      = require('../models/OrgSettings');
const EmissionSummary  = require('../../calculation/EmissionSummary');
const { computePathwayHash } = require('../utils/hashHelper');
const {
  MethodName, BudgetGranularity, SeasonalityMethod,
} = require('../constants/enums');
const { WARNINGS } = require('../constants/messages');

// ── Engine 1: Absolute Contraction ──────────────────────────────────────────
// allowed_Y = base × (1 − pct × progress)
function calcAbsoluteAllowed(base, pct, baseYear, targetYear, year) {
  return base * (1 - (pct / 100) * (year - baseYear) / (targetYear - baseYear));
}

// ── Engine 2: SDA (sector-curve intensity) ──────────────────────────────────
// factor_Y = (1 − annual_rate) ^ (Y − base_year)
// allowed_GEI_Y = base_GEI × factor_Y
function calcSDAFactor(annualRate, baseYear, year) {
  return Math.pow(1 - annualRate, year - baseYear);
}

// ── Engine 3: Regulatory GEI (flat intensity cap) ───────────────────────────
// PathwayAnnual stores the target_intensity_value unchanged every year.
// Trajectory service computes actual GEI = actual_emissions / output_value.

// ── Engine 4: RE Tracking (linear % interpolation) ──────────────────────────
// pathway_pct_Y = base_re_pct + (target_re_pct − base_re_pct) × progress
function calcREAllowed(baseRePct, targetRePct, baseYear, targetYear, year) {
  const progress = (year - baseYear) / (targetYear - baseYear);
  return parseFloat((baseRePct + (targetRePct - baseRePct) * progress).toFixed(4));
}

// ── Engine 5: Supplier Engagement (linear % interpolation) ──────────────────
function calcSupplierAllowed(basePct, targetPct, baseYear, targetYear, year) {
  return calcREAllowed(basePct, targetPct, baseYear, targetYear, year);
}

// ── Engine 6 & 7: FLAG / Internal Custom (same as ACL) ──────────────────────
// Uses flag_base_emissions (FLAG) or base_year_emissions (Internal_Custom)

// ── Engine 8: Residual Offset (net linear toward 0) ─────────────────────────
// net_target_Y = base_net × (1 − progress)
function calcResidualAllowed(baseNet, baseYear, targetYear, year) {
  const progress = (year - baseYear) / (targetYear - baseYear);
  return parseFloat((baseNet * (1 - progress)).toFixed(4));
}

// ── Main Pathway Generator ───────────────────────────────────────────────────

async function generatePathway(target) {
  const {
    _id: targetId, clientId,
    method_name, framework_name,
    base_year, base_year_emissions,
    target_year, target_reduction_pct,
    // RE Tracking
    base_re_pct, target_re_pct,
    // Supplier Engagement
    base_supplier_engagement_pct, target_supplier_engagement_pct,
    // FLAG
    flag_base_emissions,
    // SDA
    sda_sector,
    target_intensity_value,
    // Residual
    residual_manual_removal_tco2e,
    residual_removal_source,
  } = target;

  const rows = [];

  // ── 1. Absolute Contraction ────────────────────────────────────────────────
  if (method_name === MethodName.Absolute_Contraction) {
    if (base_year_emissions == null || target_reduction_pct == null) return;
    for (let year = base_year + 1; year <= target_year; year++) {
      const allowed = calcAbsoluteAllowed(base_year_emissions, target_reduction_pct, base_year, target_year, year);
      rows.push({
        clientId, target_id: targetId, calendar_year: year,
        allowed_emissions: parseFloat(allowed.toFixed(4)),
        recompute_hash: computePathwayHash(targetId, year, framework_name, method_name,
          { base_year_emissions, target_reduction_pct, base_year, target_year }),
      });
    }
  }

  // ── 2. SDA ─────────────────────────────────────────────────────────────────
  else if (method_name === MethodName.SDA) {
    if (base_year_emissions == null || !sda_sector) return;

    const methodDoc = await MethodLibrary.findOne({ method_code: 'SDA' }).lean();
    const sectorData = methodDoc?.required_parameters?.sectors?.[sda_sector];
    if (!sectorData) {
      console.warn(`[pathwayService] SDA sector '${sda_sector}' not found in MethodLibrary.`);
      return;
    }
    const { annual_reduction_rate } = sectorData;

    // base_GEI from TargetMaster: target_intensity_value holds the base year GEI
    // (user enters it manually as the starting intensity; or we use base_year_emissions / 1 if not set)
    const baseGEI = target_intensity_value ?? base_year_emissions;
    if (baseGEI == null) return;

    for (let year = base_year + 1; year <= target_year; year++) {
      const factor     = calcSDAFactor(annual_reduction_rate, base_year, year);
      const allowedGEI = parseFloat((baseGEI * factor).toFixed(6));
      rows.push({
        clientId, target_id: targetId, calendar_year: year,
        allowed_emissions: allowedGEI,
        recompute_hash: computePathwayHash(targetId, year, framework_name, method_name,
          { baseGEI, annual_reduction_rate, sda_sector }),
      });
    }
  }

  // ── 3. Regulatory GEI (flat intensity cap) ─────────────────────────────────
  else if (method_name === MethodName.Regulatory_GEI) {
    if (target_intensity_value == null) return;
    for (let year = base_year + 1; year <= target_year; year++) {
      rows.push({
        clientId, target_id: targetId, calendar_year: year,
        allowed_emissions: target_intensity_value,   // flat cap every year
        recompute_hash: computePathwayHash(targetId, year, framework_name, method_name,
          { target_intensity_value }),
      });
    }
  }

  // ── 4. RE Tracking ─────────────────────────────────────────────────────────
  else if (method_name === MethodName.RE_Tracking) {
    if (base_re_pct == null || target_re_pct == null) return;
    // Base year row (year = base_year) already handled as synthetic row in trajectoryService.
    for (let year = base_year + 1; year <= target_year; year++) {
      const allowedPct = calcREAllowed(base_re_pct, target_re_pct, base_year, target_year, year);
      rows.push({
        clientId, target_id: targetId, calendar_year: year,
        allowed_emissions: allowedPct,   // % value stored as the pathway figure
        recompute_hash: computePathwayHash(targetId, year, framework_name, method_name,
          { base_re_pct, target_re_pct, base_year, target_year }),
      });
    }
  }

  // ── 5. Supplier Engagement ─────────────────────────────────────────────────
  else if (method_name === MethodName.Supplier_Engagement_Tracking) {
    const basePct   = base_supplier_engagement_pct ?? 0;
    const targetPct = target_supplier_engagement_pct;
    if (targetPct == null) return;
    for (let year = base_year + 1; year <= target_year; year++) {
      const allowedPct = calcSupplierAllowed(basePct, targetPct, base_year, target_year, year);
      rows.push({
        clientId, target_id: targetId, calendar_year: year,
        allowed_emissions: allowedPct,
        recompute_hash: computePathwayHash(targetId, year, framework_name, method_name,
          { basePct, targetPct, base_year, target_year }),
      });
    }
  }

  // ── 6. FLAG ────────────────────────────────────────────────────────────────
  else if (method_name === MethodName.FLAG) {
    const flagBase = flag_base_emissions ?? base_year_emissions;
    if (flagBase == null || target_reduction_pct == null) return;
    for (let year = base_year + 1; year <= target_year; year++) {
      const allowed = calcAbsoluteAllowed(flagBase, target_reduction_pct, base_year, target_year, year);
      rows.push({
        clientId, target_id: targetId, calendar_year: year,
        allowed_emissions: parseFloat(allowed.toFixed(4)),
        recompute_hash: computePathwayHash(targetId, year, framework_name, method_name,
          { flagBase, target_reduction_pct, base_year, target_year }),
      });
    }
  }

  // ── 7. Internal Custom (ACL) ───────────────────────────────────────────────
  else if (method_name === MethodName.Internal_Custom) {
    if (base_year_emissions == null || target_reduction_pct == null) return;
    for (let year = base_year + 1; year <= target_year; year++) {
      const allowed = calcAbsoluteAllowed(base_year_emissions, target_reduction_pct, base_year, target_year, year);
      rows.push({
        clientId, target_id: targetId, calendar_year: year,
        allowed_emissions: parseFloat(allowed.toFixed(4)),
        recompute_hash: computePathwayHash(targetId, year, framework_name, method_name,
          { base_year_emissions, target_reduction_pct, base_year, target_year }),
      });
    }
  }

  // ── 8. Residual Offset ─────────────────────────────────────────────────────
  else if (method_name === MethodName.Residual_Offset) {
    // base_net = base_year_emissions − base_year_removals
    // For pathway generation, we use residual_manual_removal_tco2e as the base removal
    // (if source is 'auto' the base removal is 0 — to be updated when actual data arrives).
    const baseRemovals = (residual_removal_source === 'manual' && residual_manual_removal_tco2e != null)
      ? residual_manual_removal_tco2e
      : 0;
    const baseNet = (base_year_emissions ?? 0) - baseRemovals;

    for (let year = base_year + 1; year <= target_year; year++) {
      const allowedNet = calcResidualAllowed(baseNet, base_year, target_year, year);
      rows.push({
        clientId, target_id: targetId, calendar_year: year,
        allowed_emissions: allowedNet,
        recompute_hash: computePathwayHash(targetId, year, framework_name, method_name,
          { baseNet, base_year, target_year }),
      });
    }
  }

  // ── Upsert pathway rows ────────────────────────────────────────────────────
  if (rows.length) {
    await PathwayAnnual.bulkWrite(
      rows.map(row => ({
        updateOne: {
          filter: { target_id: row.target_id, calendar_year: row.calendar_year },
          update: { $set: row },
          upsert: true,
        },
      })),
      { ordered: false }
    );
  }

  // Derive operational budgets only for emission-unit methods (not %, not GEI intensity)
  const emissionUnitMethods = [
    MethodName.Absolute_Contraction,
    MethodName.FLAG,
    MethodName.Internal_Custom,
    MethodName.Residual_Offset,
  ];
  if (rows.length > 0 && emissionUnitMethods.includes(method_name)) {
    await deriveOperationalBudgets(targetId, clientId, rows);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

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
      if (sum > 0) return totals.map(t => t / sum);
    }
    console.warn(WARNINGS.SEASONALITY_FALLBACK);
    return Array(12).fill(1 / 12);
  }

  if (method === SeasonalityMethod.CUSTOM_CURVE) {
    const curve = settings?.custom_seasonality_curve;
    if (Array.isArray(curve) && curve.length === 12) {
      const sum = curve.reduce((a, b) => a + b, 0);
      if (sum > 0) return curve.map(w => w / sum);
    }
    return Array(12).fill(1 / 12);
  }

  return Array(12).fill(1 / 12);
}

// ── Operational Budget Derivation (emission-unit methods only) ───────────────
async function deriveOperationalBudgets(targetId, clientId, pathwayRows) {
  if (!pathwayRows.length) return;

  const settings = await OrgSettings.findOne({ clientId }).lean();
  const method   = settings?.seasonality_default_method || SeasonalityMethod.EQUAL;

  // Batch-fetch PathwayAnnual docs for rows that don't already carry _id
  // (rows from getPathway() are full Mongoose docs; rows from generatePathway() are plain objects)
  const yearsNeedingLookup = pathwayRows.filter(r => !r._id).map(r => r.calendar_year);
  let pathwayDocMap = {};
  if (yearsNeedingLookup.length) {
    const docs = await PathwayAnnual.find({
      target_id: targetId,
      calendar_year: { $in: yearsNeedingLookup },
    }).lean();
    for (const d of docs) pathwayDocMap[d.calendar_year] = d;
  }

  // Pre-fetch all required historical emission summaries in a single query
  let historicalSummaries = {};
  if (method === SeasonalityMethod.M1_HISTORICAL) {
    const priorYears = pathwayRows.map(r => r.calendar_year - 1);
    const docs = await EmissionSummary.find({
      clientId,
      'period.type': 'monthly',
      'period.year': { $in: priorYears },
    }).sort({ 'period.year': 1, 'period.month': 1 }).lean();
    for (const doc of docs) {
      const y = doc.period.year;
      if (!historicalSummaries[y]) historicalSummaries[y] = [];
      historicalSummaries[y].push(doc);
    }
  }

  const ops = [];

  for (const row of pathwayRows) {
    const pathwayDoc = row._id ? row : pathwayDocMap[row.calendar_year];
    if (!pathwayDoc) continue;

    const annual  = row.allowed_emissions;
    const year    = row.calendar_year;
    const baseSet = { clientId, parent_pathway_id: pathwayDoc._id, is_system_derived: true };

    ops.push({
      updateOne: {
        filter: { target_id: targetId, granularity: BudgetGranularity.ANNUAL, period_key: String(year) },
        update: { $set: { ...baseSet, budget_emissions: annual } },
        upsert: true,
      },
    });

    // Resolve weights from pre-fetched data — no extra DB call
    let weights;
    if (method === SeasonalityMethod.M1_HISTORICAL) {
      const priorDocs = historicalSummaries[year - 1] || [];
      if (priorDocs.length === 12) {
        const totals = priorDocs.map(d => d.emissionSummary?.totalEmissions?.CO2e || 0);
        const sum    = totals.reduce((a, b) => a + b, 0);
        if (sum > 0) weights = totals.map(t => t / sum);
      }
      if (!weights) { console.warn(WARNINGS.SEASONALITY_FALLBACK); }
    } else if (method === SeasonalityMethod.CUSTOM_CURVE) {
      const curve = settings?.custom_seasonality_curve;
      if (Array.isArray(curve) && curve.length === 12) {
        const sum = curve.reduce((a, b) => a + b, 0);
        if (sum > 0) weights = curve.map(w => w / sum);
      }
    }
    if (!weights) weights = Array(12).fill(1 / 12);

    const monthlyBudgets = weights.map(w => annual * w);

    for (let m = 1; m <= 12; m++) {
      ops.push({
        updateOne: {
          filter: { target_id: targetId, granularity: BudgetGranularity.MONTHLY, period_key: `${year}-${String(m).padStart(2, '0')}` },
          update: { $set: { ...baseSet, budget_emissions: monthlyBudgets[m - 1] } },
          upsert: true,
        },
      });
    }

    const quarterMonths = [[1,2,3],[4,5,6],[7,8,9],[10,11,12]];
    for (let q = 0; q < 4; q++) {
      const qBudget = quarterMonths[q].reduce((s, m) => s + monthlyBudgets[m - 1], 0);
      ops.push({
        updateOne: {
          filter: { target_id: targetId, granularity: BudgetGranularity.QUARTERLY, period_key: `${year}-Q${q + 1}` },
          update: { $set: { ...baseSet, budget_emissions: qBudget } },
          upsert: true,
        },
      });
    }

    for (let m = 1; m <= 12; m++) {
      const days        = daysInMonth(year, m);
      const dailyBudget = monthlyBudgets[m - 1] / days;
      for (let d = 1; d <= days; d++) {
        ops.push({
          updateOne: {
            filter: { target_id: targetId, granularity: BudgetGranularity.DAILY, period_key: `${year}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}` },
            update: { $set: { ...baseSet, budget_emissions: dailyBudget } },
            upsert: true,
          },
        });
      }
    }
  }

  if (ops.length) {
    await OperationalBudget.bulkWrite(ops, { ordered: false });
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
