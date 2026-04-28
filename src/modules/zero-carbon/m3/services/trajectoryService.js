'use strict';

// ============================================================================
// Trajectory Service
// ──────────────────
// Joins PathwayAnnual (the target line) with per-year actuals (the actual line)
// for every method. Returns one enriched row per year from base_year → target_year.
//
// "actual" is computed differently per method:
//   Absolute / FLAG / Internal_Custom / Residual_Offset
//     → ProgressSnapshot.actual_emissions (already in tCO₂e / net tCO₂e)
//   Regulatory_GEI
//     → actual_emissions / output_value  (tCO₂e / denominator unit)
//   RE_Tracking
//     → AnnualMetricRecord.re_pct  (%)
//   Supplier_Engagement_Tracking
//     → AnnualMetricRecord.supplier_engagement_pct  (%)
//   SDA
//     → ProgressSnapshot.actual_emissions / OutputActivityRecord.output_value
// ============================================================================

const TargetMaster        = require('../models/TargetMaster');
const PathwayAnnual       = require('../models/PathwayAnnual');
const ProgressSnapshot    = require('../models/ProgressSnapshot');
const OutputActivityRecord = require('../models/OutputActivityRecord');
const AnnualMetricRecord  = require('../models/AnnualMetricRecord');
const { SnapshotType, MethodName, HIGHER_IS_BETTER_METHODS } = require('../constants/enums');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns the metric unit label shown in the trajectory chart Y-axis.
 */
function getMetricUnit(method) {
  if ([MethodName.RE_Tracking, MethodName.Supplier_Engagement_Tracking].includes(method)) return '%';
  if ([MethodName.SDA, MethodName.Regulatory_GEI].includes(method)) return 'tCO₂e / unit';
  return 'tCO₂e';
}

/**
 * Returns a friendly chart Y-axis label for the method.
 */
function getChartLabel(method) {
  const labels = {
    [MethodName.Absolute_Contraction]:        'Absolute Emissions (tCO₂e)',
    [MethodName.SDA]:                         'Emission Intensity (tCO₂e / unit)',
    [MethodName.Regulatory_GEI]:              'GEI – Emission Intensity (tCO₂e / unit)',
    [MethodName.RE_Tracking]:                 'Renewable Electricity (%)',
    [MethodName.Supplier_Engagement_Tracking]:'Supplier Engagement (%)',
    [MethodName.FLAG]:                        'FLAG Emissions (tCO₂e)',
    [MethodName.Internal_Custom]:             'Emissions (tCO₂e)',
    [MethodName.Residual_Offset]:             'Net Emissions (tCO₂e)',
  };
  return labels[method] || 'Emissions (tCO₂e)';
}

// ── Per-year actual value resolver ───────────────────────────────────────────

async function resolveActual(target, year, snapshot) {
  const method = target.method_name;

  // Intensity method: actual GEI = actual_emissions / output_value
  if (method === MethodName.Regulatory_GEI || method === MethodName.SDA) {
    const actualEmissions = snapshot?.actual_emissions ?? null;
    if (actualEmissions == null) return null;
    const outputRec = await OutputActivityRecord.findOne(
      { target_id: target._id, calendar_year: year }
    ).lean();
    if (!outputRec || !outputRec.output_value) return null;
    return parseFloat((actualEmissions / outputRec.output_value).toFixed(6));
  }

  // RE Tracking: actual % from AnnualMetricRecord
  if (method === MethodName.RE_Tracking) {
    const rec = await AnnualMetricRecord.findOne(
      { target_id: target._id, calendar_year: year }
    ).lean();
    return rec?.re_pct ?? null;
  }

  // Supplier Engagement: actual % from AnnualMetricRecord
  if (method === MethodName.Supplier_Engagement_Tracking) {
    const rec = await AnnualMetricRecord.findOne(
      { target_id: target._id, calendar_year: year }
    ).lean();
    return rec?.supplier_engagement_pct ?? null;
  }

  // All other methods: raw actual_emissions from ProgressSnapshot
  return snapshot?.actual_emissions ?? null;
}

/**
 * Checks whether the actual value for a year is "on track" for its method.
 * Higher-is-better methods (RE, Supplier) → actual >= required.
 * All others → actual <= required.
 */
function checkAchieved(method, actual, required) {
  if (actual == null || required == null) return null;
  return HIGHER_IS_BETTER_METHODS.has(method)
    ? actual >= required
    : actual <= required;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function getTargetTrajectory(targetId) {
  const target = await TargetMaster.findOne({ _id: targetId, isDeleted: false }).lean();
  if (!target) {
    const e = new Error('Target not found.');
    e.status = 404;
    throw e;
  }

  const {
    base_year, target_year,
    base_year_emissions, target_reduction_pct,
    target_intensity_value,
    base_re_pct, target_re_pct,
    base_supplier_engagement_pct, target_supplier_engagement_pct,
    flag_base_emissions,
    scope_boundary, method_name,
  } = target;

  if (!base_year || !target_year || target_year <= base_year) {
    const e = new Error('Target has invalid base_year / target_year configuration.');
    e.status = 422;
    throw e;
  }

  // ── Derive the "final target value" shown in the summary ──────────────────
  let finalTargetValue = null;
  if (method_name === MethodName.Absolute_Contraction ||
      method_name === MethodName.FLAG ||
      method_name === MethodName.Internal_Custom) {
    const baseEmissions = (method_name === MethodName.FLAG ? (flag_base_emissions ?? base_year_emissions) : base_year_emissions);
    finalTargetValue = baseEmissions != null && target_reduction_pct != null
      ? parseFloat((baseEmissions * (1 - target_reduction_pct / 100)).toFixed(4))
      : null;
  } else if (method_name === MethodName.SDA || method_name === MethodName.Regulatory_GEI) {
    finalTargetValue = target_intensity_value;
  } else if (method_name === MethodName.RE_Tracking) {
    finalTargetValue = target_re_pct;
  } else if (method_name === MethodName.Supplier_Engagement_Tracking) {
    finalTargetValue = target_supplier_engagement_pct;
  } else if (method_name === MethodName.Residual_Offset) {
    finalTargetValue = 0; // full neutrality
  }

  // ── Determine base-year value (used for the synthetic base row) ───────────
  let baseValue = null;
  if (method_name === MethodName.RE_Tracking) {
    baseValue = base_re_pct;
  } else if (method_name === MethodName.Supplier_Engagement_Tracking) {
    baseValue = base_supplier_engagement_pct ?? 0;
  } else if (method_name === MethodName.FLAG) {
    baseValue = flag_base_emissions ?? base_year_emissions;
  } else {
    baseValue = base_year_emissions;
  }

  // ── Fetch pathway rows + annual snapshots in parallel ────────────────────
  const [pathwayRows, snapshots] = await Promise.all([
    PathwayAnnual.find({ target_id: targetId }).sort({ calendar_year: 1 }).lean(),
    ProgressSnapshot.find({ target_id: targetId, snapshot_type: SnapshotType.ANNUAL })
      .sort({ calendar_year: 1 }).lean(),
  ]);

  const pathwayByYear  = Object.fromEntries(pathwayRows.map(p => [p.calendar_year, p]));
  const snapshotByYear = Object.fromEntries(snapshots.map(s => [s.calendar_year, s]));

  const trajectory  = [];
  let prevAllowed   = null;
  let prevActual    = null;

  for (let year = base_year; year <= target_year; year++) {
    if (year === base_year) {
      // Synthetic base-year row
      const baseActual = await resolveActual(target, year, { actual_emissions: baseValue });
      trajectory.push({
        year,
        is_base_year:               true,
        required_allowed_emissions: baseValue,
        required_decrease_from_base: 0,
        required_annual_decrease:   0,
        actual_emissions:           baseActual ?? baseValue,
        actual_decrease_from_base:  0,
        actual_annual_decrease:     0,
        achieved:                   true,
        gap_to_allowed:             0,
        remaining_to_final_target:  finalTargetValue != null && baseValue != null
          ? Math.abs(parseFloat((baseValue - finalTargetValue).toFixed(4)))
          : null,
        progress_status:  null,
        data_status:      'AVAILABLE',
        metric_unit:      getMetricUnit(method_name),
      });
      prevAllowed = baseValue;
      prevActual  = baseActual ?? baseValue;
      continue;
    }

    const pathwayRow = pathwayByYear[year] || null;
    const snapshot   = snapshotByYear[year] || null;

    const required = pathwayRow ? pathwayRow.allowed_emissions : null;
    const requiredDecreaseFromBase =
      required != null && baseValue != null
        ? parseFloat((baseValue - required).toFixed(4))
        : null;
    const requiredAnnualDecrease =
      required != null && prevAllowed != null
        ? parseFloat((prevAllowed - required).toFixed(4))
        : null;

    // Resolve actual value for this method
    const actual = await resolveActual(target, year, snapshot);

    const actualDecreaseFromBase =
      actual != null && baseValue != null
        ? parseFloat((baseValue - actual).toFixed(4))
        : null;
    const actualAnnualDecrease =
      actual != null && prevActual != null
        ? parseFloat((prevActual - actual).toFixed(4))
        : null;

    const achieved    = checkAchieved(method_name, actual, required);
    const gapToAllowed = actual != null && required != null
      ? parseFloat((actual - required).toFixed(4))
      : null;
    const remainingToFinal =
      actual != null && finalTargetValue != null
        ? Math.abs(parseFloat((actual - finalTargetValue).toFixed(4)))
        : null;

    trajectory.push({
      year,
      is_base_year:               false,
      required_allowed_emissions: required,
      required_decrease_from_base: requiredDecreaseFromBase,
      required_annual_decrease:   requiredAnnualDecrease,
      actual_emissions:           actual,
      actual_decrease_from_base:  actualDecreaseFromBase,
      actual_annual_decrease:     actualAnnualDecrease,
      achieved,
      gap_to_allowed:             gapToAllowed,
      remaining_to_final_target:  remainingToFinal,
      progress_status:            snapshot ? snapshot.progress_status : null,
      data_status:                actual != null ? 'AVAILABLE' : 'MISSING_ACTUAL',
      metric_unit:                getMetricUnit(method_name),
    });

    if (required != null) prevAllowed = required;
    if (actual   != null) prevActual  = actual;
  }

  // ── Summary stats ─────────────────────────────────────────────────────────
  const nonBaseRows     = trajectory.filter(r => !r.is_base_year);
  const rowsWithActuals = nonBaseRows.filter(r => r.data_status === 'AVAILABLE');
  const achievedRows    = nonBaseRows.filter(r => r.achieved === true);
  const latestActual    = rowsWithActuals[rowsWithActuals.length - 1] || null;

  return {
    target: {
      target_id:          target._id,
      target_code:        target.target_code,
      clientId:           target.clientId,
      method_name,
      chart_label:        getChartLabel(method_name),
      metric_unit:        getMetricUnit(method_name),
      higher_is_better:   HIGHER_IS_BETTER_METHODS.has(method_name),
      base_year,
      target_year,
      base_value:         baseValue,
      final_target_value: finalTargetValue,
      scope_boundary,
    },
    summary: {
      total_years:            nonBaseRows.length,
      years_with_actuals:     rowsWithActuals.length,
      achieved_years:         achievedRows.length,
      latest_actual_year:     latestActual ? latestActual.year : null,
      latest_progress_status: latestActual ? latestActual.progress_status : null,
    },
    trajectory,
  };
}

module.exports = { getTargetTrajectory };
