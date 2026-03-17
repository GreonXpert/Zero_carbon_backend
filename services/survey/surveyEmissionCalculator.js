// services/survey/surveyEmissionCalculator.js
// Distance-based emission calculation for Tier-2 Employee Commuting (Scope 3 Cat 7).
// Reference: GHG Protocol Chapter 7 distance-based method.
//
// Formula:
//   emissions = Σ (total_distance_per_mode × emission_factor_per_mode)
// where:
//   total_distance = oneWayKm × 2 × commutingDays
//   (adjusted for carpool occupancy and trip_type)

const MILES_TO_KM = 1.60934;

// ─── Zero-emission transport modes ──────────────────────────────────────────
const ZERO_EMISSION_MODES = new Set(['BICYCLE', 'WALKING', 'OTHER_NON_MOTORIZED']);

// ─── Vehicle-km based modes (vs passenger-km) ────────────────────────────────
// For these modes the distance is measured per vehicle, not per person.
const VEHICLE_KM_MODES = new Set([
  'PRIVATE_CAR', 'PRIVATE_MOTORCYCLE', 'PRIVATE_VAN',
  'CARPOOL', 'BUS_PRIVATE_SHUTTLE',
]);

// ─── Carpool modes (vehicle-km ÷ occupancy = passenger-km) ──────────────────
const CARPOOL_MODES = new Set(['CARPOOL']);

/**
 * Convert distance to km.
 * @param {number} distance
 * @param {string} unit 'km' | 'miles'
 * @returns {number}
 */
function toKm(distance, unit) {
  return unit === 'miles' ? distance * MILES_TO_KM : distance;
}

/**
 * Derive one-way distance in km from the survey answer.
 * Q4 may represent one-way or round-trip; Q6 (tripType) disambiguates.
 *
 * @param {number} rawDistance
 * @param {string} distanceUnit  'km' | 'miles'
 * @param {string} tripType      'ONE_WAY' | 'ROUND_TRIP'
 * @returns {number} one-way distance in km
 */
function deriveOneWayKm(rawDistance, distanceUnit, tripType) {
  const km = toKm(rawDistance, distanceUnit);
  return tripType === 'ROUND_TRIP' ? km / 2 : km;
}

/**
 * Determine total commuting days for the reporting period.
 *
 * @param {number|null} commuteDaysInPeriod  Q3 — explicit value if provided
 * @param {number|null} commuteDaysPerWeek   Q2
 * @param {number}      weeksInPeriod        derived from collectionFrequency
 * @returns {number}
 */
function resolveCommutingDays(commuteDaysInPeriod, commuteDaysPerWeek, weeksInPeriod) {
  if (commuteDaysInPeriod != null && commuteDaysInPeriod > 0) {
    return commuteDaysInPeriod;
  }
  if (commuteDaysPerWeek != null && weeksInPeriod > 0) {
    return commuteDaysPerWeek * weeksInPeriod;
  }
  return 0;
}

/**
 * Map collectionFrequency to the number of weeks in the survey period.
 * Used when commuteDaysInPeriod is not supplied by the respondent.
 *
 * @param {string} collectionFrequency  'annually'|'half-yearly'|'quarterly'|'monthly'
 * @returns {number}
 */
function weeksForFrequency(collectionFrequency) {
  switch (collectionFrequency) {
    case 'monthly':     return 52 / 12;   // ~4.33
    case 'quarterly':   return 13;
    case 'half-yearly': return 26;
    case 'annually':
    default:            return 52;
  }
}

/**
 * Look up the emission factor (kg CO2e per km) for a given mode/vehicle/fuel combination.
 * This is a stub that returns 0 by default; in production this delegates to the
 * emissionFactors array from the ScopeDetail (injected by the caller).
 *
 * The emissionFactors array may contain entries from DEFRA, EPA, IPCC, Custom, etc.
 * The caller passes the relevant factor value directly via `efValue`.
 *
 * @param {string}      modeCode
 * @param {string|null} vehicleType
 * @param {string|null} fuelType
 * @param {number}      efValue  — kg CO2e per km resolved by the caller from the EF library
 * @returns {number}
 */
function getEmissionFactor(modeCode, vehicleType, fuelType, efValue) {
  // If caller provides an explicit factor, use it.
  if (typeof efValue === 'number' && efValue >= 0) return efValue;
  // Zero-emission modes always return 0 regardless.
  if (ZERO_EMISSION_MODES.has(modeCode)) return 0;
  // Default to 0 when no factor is available (signals incomplete EF config).
  return 0;
}

/**
 * Calculate emissions for a SINGLE leg (one transport mode segment).
 *
 * @param {object} p
 * @param {string}      p.modeCode
 * @param {string|null} p.vehicleType
 * @param {string|null} p.fuelType
 * @param {number|null} p.occupancy
 * @param {number}      p.oneWayKm     one-way distance for this leg in km
 * @param {number}      p.commutingDays
 * @param {number}      p.efValue      emission factor (kg CO2e / km)
 * @returns {{ distanceKm: number, emissionsKgCO2e: number, unitBasis: string }}
 */
function calculateLegEmissions({ modeCode, vehicleType, fuelType, occupancy, oneWayKm, commutingDays, efValue }) {
  if (ZERO_EMISSION_MODES.has(modeCode)) {
    return { distanceKm: 0, emissionsKgCO2e: 0, unitBasis: 'zero-emission' };
  }

  const roundTripKm = oneWayKm * 2;
  const totalKm = roundTripKm * commutingDays;

  let effectiveKm = totalKm;
  let unitBasis = 'passenger-km';

  if (VEHICLE_KM_MODES.has(modeCode)) {
    unitBasis = 'vehicle-km';
    if (CARPOOL_MODES.has(modeCode) && occupancy && occupancy > 1) {
      // Allocate per-person share of vehicle emissions
      effectiveKm = totalKm / occupancy;
      unitBasis = 'passenger-km (carpool-adjusted)';
    } else {
      effectiveKm = totalKm;
    }
  }

  const ef = getEmissionFactor(modeCode, vehicleType, fuelType, efValue);
  const emissionsKgCO2e = effectiveKm * ef;

  return { distanceKm: effectiveKm, emissionsKgCO2e, unitBasis };
}

/**
 * Validate survey response fields and return { errors, warnings }.
 * Errors block submission; warnings are soft flags stored on the response.
 *
 * @param {object} data  – flat survey response payload
 * @returns {{ errors: string[], warnings: string[], flags: object }}
 */
function validateSurveyResponse(data) {
  const errors = [];
  const warnings = [];
  const flags = { hasOutlierDistance: false, hasMixedModeInconsistency: false };

  const WORK_ARRANGEMENTS = ['ONSITE_FULL', 'HYBRID', 'REMOTE_FULL', 'COMPRESSED_WEEK', 'SHIFT_BASED'];
  const VEHICLE_KM_PRIVATE = ['PRIVATE_CAR', 'PRIVATE_MOTORCYCLE', 'PRIVATE_VAN', 'CARPOOL'];
  const MOTORIZED_PRIVATE = ['PRIVATE_CAR', 'PRIVATE_MOTORCYCLE', 'PRIVATE_VAN', 'CARPOOL'];

  // Q1 — always required
  if (!data.workArrangement || !WORK_ARRANGEMENTS.includes(data.workArrangement)) {
    errors.push('workArrangement is required and must be a valid work arrangement code.');
  }

  const isRemote = data.workArrangement === 'REMOTE_FULL';

  if (!isRemote) {
    // Q2 — commute days per week
    if (data.commuteDaysPerWeek == null) {
      errors.push('commuteDaysPerWeek is required for non-remote employees.');
    } else {
      const cdpw = Number(data.commuteDaysPerWeek);
      if (cdpw < 0.5 || cdpw > 7.0) {
        errors.push('commuteDaysPerWeek must be between 0.5 and 7.0.');
      }
      // Check half-step increments
      if (Math.round(cdpw * 2) !== cdpw * 2) {
        errors.push('commuteDaysPerWeek must be in increments of 0.5.');
      }
      if (cdpw > 5) {
        warnings.push('More than 5 commuting days per week is unusual — please verify.');
      }
    }

    // Q4 — one-way distance
    if (data.oneWayDistance == null) {
      errors.push('oneWayDistance is required for non-remote employees.');
    } else {
      const dist = Number(data.oneWayDistance);
      if (dist < 0.1 || dist > 500) {
        errors.push('oneWayDistance must be between 0.1 and 500.');
      }
      if (dist > 200) {
        warnings.push('Distance exceeds 200 km — please verify.');
        flags.hasOutlierDistance = true;
      }
    }

    // Q5 — distance unit
    if (!data.distanceUnit || !['km', 'miles'].includes(data.distanceUnit)) {
      errors.push('distanceUnit must be "km" or "miles".');
    }

    // Q6 — trip type
    if (!data.tripType || !['ONE_WAY', 'ROUND_TRIP'].includes(data.tripType)) {
      errors.push('tripType is required and must be ONE_WAY or ROUND_TRIP.');
    }

    // Q7 — mixed mode
    if (!data.isMixedMode || !['YES', 'NO'].includes(data.isMixedMode)) {
      errors.push('isMixedMode is required and must be YES or NO.');
    }

    if (data.isMixedMode === 'NO') {
      // Q8 — primary mode
      if (!data.primaryModeCode) {
        errors.push('primaryModeCode is required when isMixedMode is NO.');
      }

      // Q9 — vehicle type
      if (data.primaryModeCode && VEHICLE_KM_PRIVATE.includes(data.primaryModeCode)) {
        if (!data.vehicleType) {
          errors.push('vehicleType is required for private vehicle modes.');
        }
      }

      // Q10 — fuel type
      if (data.primaryModeCode && MOTORIZED_PRIVATE.includes(data.primaryModeCode)) {
        if (!data.fuelType) {
          errors.push('fuelType is required for motorized private vehicle modes.');
        }
      }

      // Q11 — occupancy
      if (data.primaryModeCode && ['PRIVATE_CAR', 'PRIVATE_VAN', 'CARPOOL'].includes(data.primaryModeCode)) {
        if (data.occupancy == null) {
          errors.push('occupancy is required for car/van/carpool modes.');
        } else {
          const occ = Number(data.occupancy);
          if (!Number.isInteger(occ) || occ < 1 || occ > 10) {
            errors.push('occupancy must be an integer between 1 and 10.');
          }
          if (occ > 6) {
            warnings.push('Unusually high vehicle occupancy — please verify.');
          }
        }
      }
    }

    if (data.isMixedMode === 'YES') {
      const legs = data.legs || [];
      const MAX_LEGS = 5;

      if (!Array.isArray(legs) || legs.length < 2) {
        errors.push('At least 2 legs are required for mixed-mode commutes.');
      } else if (legs.length > MAX_LEGS) {
        errors.push(`A maximum of ${MAX_LEGS} legs is allowed.`);
      } else {
        // Validate each leg
        legs.forEach((leg, idx) => {
          const n = idx + 1;
          if (!leg.legModeCode) errors.push(`Leg ${n}: legModeCode is required.`);
          if (leg.legDistanceKm == null || Number(leg.legDistanceKm) <= 0) {
            errors.push(`Leg ${n}: legDistanceKm must be a positive number.`);
          }
        });

        // Mixed-mode leg-sum consistency check (within ±10% of Q4 one-way)
        if (data.oneWayDistance && data.distanceUnit && data.tripType) {
          const oneWayKm = deriveOneWayKm(
            Number(data.oneWayDistance),
            data.distanceUnit,
            data.tripType
          );
          const legSumKm = legs.reduce((s, l) => s + (Number(l.legDistanceKm) || 0), 0);
          const lower = oneWayKm * 0.9;
          const upper = oneWayKm * 1.1;
          if (legSumKm < lower || legSumKm > upper) {
            warnings.push(
              `Sum of leg distances (${legSumKm.toFixed(2)} km) differs from one-way distance by more than 10%.`
            );
            flags.hasMixedModeInconsistency = true;
          }
        }
      }
    }
  }

  return { errors, warnings, flags };
}

/**
 * Calculate emissions for a single survey response.
 *
 * @param {object} response         – SurveyResponse document (or plain object with same fields)
 * @param {number} weeksInPeriod    – from collectionFrequency
 * @param {Function} efLookup       – (modeCode, vehicleType, fuelType) => number (kg CO2e/km)
 *                                    Caller provides this; defaults to 0 if absent.
 * @returns {{ emissionsKgCO2e: number, breakdown: object }}
 */
function calculateResponseEmissions(response, weeksInPeriod, efLookup) {
  const ef = typeof efLookup === 'function' ? efLookup : () => 0;

  // REMOTE_FULL → zero emissions
  if (response.workArrangement === 'REMOTE_FULL') {
    return {
      emissionsKgCO2e: 0,
      breakdown: { mode: 'REMOTE_FULL', note: 'No commuting emissions for fully remote employees.' },
    };
  }

  const oneWayKm = deriveOneWayKm(
    response.oneWayDistance,
    response.distanceUnit,
    response.tripType
  );

  const commutingDays = resolveCommutingDays(
    response.commuteDaysInPeriod,
    response.commuteDaysPerWeek,
    weeksInPeriod
  );

  if (response.isMixedMode === 'YES' && Array.isArray(response.legs) && response.legs.length > 0) {
    // ── Mixed-mode path ──────────────────────────────────────────────────────
    const legResults = response.legs.map((leg, idx) => {
      const legOneWayKm = leg.legDistanceKm || 0;
      const result = calculateLegEmissions({
        modeCode: leg.legModeCode,
        vehicleType: leg.legVehicleType,
        fuelType: leg.legFuelType,
        occupancy: leg.legOccupancy,
        oneWayKm: legOneWayKm,
        commutingDays,
        efValue: ef(leg.legModeCode, leg.legVehicleType, leg.legFuelType),
      });
      return { leg: idx + 1, ...result };
    });

    const totalEmissions = legResults.reduce((s, r) => s + r.emissionsKgCO2e, 0);

    return {
      emissionsKgCO2e: totalEmissions,
      breakdown: {
        mode: 'mixed',
        oneWayKm,
        commutingDays,
        legs: legResults,
        totalEmissionsKgCO2e: totalEmissions,
      },
    };
  }

  // ── Single-mode path ─────────────────────────────────────────────────────
  const result = calculateLegEmissions({
    modeCode: response.primaryModeCode,
    vehicleType: response.vehicleType,
    fuelType: response.fuelType,
    occupancy: response.occupancy,
    oneWayKm,
    commutingDays,
    efValue: ef(response.primaryModeCode, response.vehicleType, response.fuelType),
  });

  return {
    emissionsKgCO2e: result.emissionsKgCO2e,
    breakdown: {
      mode: response.primaryModeCode,
      oneWayKm,
      commutingDays,
      distanceKm: result.distanceKm,
      unitBasis: result.unitBasis,
      emissionFactor: ef(response.primaryModeCode, response.vehicleType, response.fuelType),
      totalEmissionsKgCO2e: result.emissionsKgCO2e,
    },
  };
}

/**
 * Aggregate emissions across all responses for a cycle.
 *
 * @param {object[]} responses     – array of SurveyResponse documents
 * @param {number}   weeksInPeriod
 * @param {Function} efLookup      – (modeCode, vehicleType, fuelType) => number
 * @returns {{ totalKgCO2e: number, byMode: object, byWorkArrangement: object, responseCount: number }}
 */
function aggregateCycleEmissions(responses, weeksInPeriod, efLookup) {
  let totalKgCO2e = 0;
  const byMode = {};
  const byWorkArrangement = {};

  for (const r of responses) {
    const { emissionsKgCO2e } = calculateResponseEmissions(r, weeksInPeriod, efLookup);
    totalKgCO2e += emissionsKgCO2e;

    // By primary mode
    const modeKey = r.isMixedMode === 'YES' ? 'MIXED' : (r.primaryModeCode || 'UNKNOWN');
    byMode[modeKey] = (byMode[modeKey] || 0) + emissionsKgCO2e;

    // By work arrangement
    const waKey = r.workArrangement || 'UNKNOWN';
    byWorkArrangement[waKey] = (byWorkArrangement[waKey] || 0) + emissionsKgCO2e;
  }

  return {
    totalKgCO2e,
    byMode,
    byWorkArrangement,
    responseCount: responses.length,
  };
}

module.exports = {
  validateSurveyResponse,
  calculateResponseEmissions,
  aggregateCycleEmissions,
  deriveOneWayKm,
  resolveCommutingDays,
  weeksForFrequency,
  ZERO_EMISSION_MODES,
  VEHICLE_KM_MODES,
};
