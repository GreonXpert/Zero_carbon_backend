// utils/CalculateUncertainity.js
//
// GHG Emission Uncertainty Calculator — ISO 14064-1 / IPCC aligned
//
// ────────────────────────────────────────────────────────────────────
//  CRITICAL RULE:
//    This function must ONLY be called with CUMULATIVE emission values.
//    Never call it per-row / per incoming data entry.
//    Apply to the final cumulative E after the full emission chain is built.
// ────────────────────────────────────────────────────────────────────
//
//  Formula (root-sum-of-squares):
//    UE (%)  = sqrt( UAD² + UEF² )
//    ΔE      = E × (UE / 100)
//    Range   = E ± ΔE
//    Conservative estimate = E + ΔE  (upper bound)
//
//  UAD = Uncertainty of Activity Data   — comes from DataEntry / activity input
//  UEF = Uncertainty of Emission Factor — comes from Flowchart / ProcessFlowchart node
//
// ────────────────────────────────────────────────────────────────────

/**
 * Calculate GHG emission uncertainty for a cumulative emission value.
 *
 * @param {number} cumulativeEmission  - Final cumulative emission (E) in kgCO2e or tCO2e
 * @param {number} UAD                 - Activity Data uncertainty as a PERCENTAGE  (e.g. 5 means 5%)
 * @param {number} UEF                 - Emission Factor uncertainty as a PERCENTAGE (e.g. 3 means 3%)
 * @returns {{
 *   emission:          number,   // Base emission E (unchanged)
 *   uncertaintyPercent: number,  // Combined relative uncertainty UE in %
 *   deltaE:            number,   // Absolute uncertainty ΔE  (same units as E)
 *   low:               number,   // E − ΔE  (lower bound)
 *   high:              number,   // E + ΔE  (upper bound / conservative estimate)
 * }}
 */
exports.calculateUncertainty = function (cumulativeEmission, UAD, UEF) {
  const E   = Number(cumulativeEmission) || 0;
  const uad = Number(UAD) || 0;   // percentage value, e.g. 5  → means 5%
  const uef = Number(UEF) || 0;   // percentage value, e.g. 3  → means 3%

  // ── Step 1: Combined relative uncertainty (root-sum-of-squares) ──────
  //   UE = sqrt( UAD² + UEF² )
  //   Both UAD and UEF are already in % — no /100 needed here.
  //   E.g. UAD=5, UEF=3 → UE = sqrt(25 + 9) = 5.83%
  const UE = Math.sqrt(Math.pow(uad, 2) + Math.pow(uef, 2));

  // ── Step 2: Absolute uncertainty ─────────────────────────────────────
  //   ΔE = E × (UE / 100)
  //   E.g. E=1000, UE=5.83% → ΔE = 1000 × 0.0583 = 58.3 kgCO2e
  const deltaE = Math.abs(E) * (UE / 100);

  // ── Step 3: Compute range ─────────────────────────────────────────────
  const low  = E - deltaE;   // Lower bound  (optimistic estimate)
  const high = E + deltaE;   // Upper bound  (conservative estimate per ISO 14064-1)

  return {
    emission:           E,
    uncertaintyPercent: UE,
    deltaE:             deltaE,
    low:                low,
    high:               high
  };
};

// ────────────────────────────────────────────────────────────────────
//  Helper: Format uncertainty result for API response
//
//  conservativeMode = true  → return only the conservative upper value
//  conservativeMode = false → return base emission + full range
// ────────────────────────────────────────────────────────────────────

/**
 * Format the uncertainty calculation result into the API response shape.
 *
 * @param {number}  cumulativeEmission - Cumulative emission value
 * @param {number}  UAD                - Activity Data uncertainty %
 * @param {number}  UEF                - Emission Factor uncertainty %
 * @param {boolean} conservativeMode   - From Flowchart / ProcessFlowchart model
 * @returns {object} Formatted result ready for controller response
 */
exports.formatUncertaintyResult = function (cumulativeEmission, UAD, UEF, conservativeMode) {
  const result = exports.calculateUncertainty(cumulativeEmission, UAD, UEF);

  if (conservativeMode) {
    // Conservative mode: report the upper (worst-case) estimate only
    return {
      reportedEmission:   result.high,           // Conservative upper estimate
      baseEmission:       result.emission,        // Original E (for reference)
      uncertaintyPercent: result.uncertaintyPercent,
      deltaE:             result.deltaE,
      conservativeMode:   true,
      uncertaintyRange:   null                   // Range not shown in conservative mode
    };
  } else {
    // Default inventory mode: report base emission + full range
    return {
      reportedEmission:   result.emission,        // Base emission E
      uncertaintyPercent: result.uncertaintyPercent,
      deltaE:             result.deltaE,
      conservativeMode:   false,
      uncertaintyRange: {
        low:  result.low,                        // E − ΔE
        high: result.high                        // E + ΔE
      }
    };
  }
};