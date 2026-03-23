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
 *
 * @param {string}      modeCode
 * @param {string|null} vehicleType
 * @param {string|null} fuelType
 * @param {number}      efValue  — kg CO2e per km pre-resolved by the caller
 * @returns {number}
 */
function getEmissionFactor(modeCode, vehicleType, fuelType, efValue) {
  if (typeof efValue === 'number' && efValue >= 0) return efValue;
  if (ZERO_EMISSION_MODES.has(modeCode)) return 0;
  return 0;
}

/**
 * Extract the numeric kg CO2e per km value from one emissionFactors[] entry.
 *
 * Resolution order:
 *   1. entry.valueKgCO2ePerKm  — pre-computed and stored by the API at save time (fastest path)
 *   2. Source-specific raw data — fallback when the pre-computed field is absent
 *
 * For DEFRA/IPCC/EPA the ghgUnits array may contain separate rows for CO2,
 * CH4, N2O, and CO2e. This searches for the CO2e row (unit contains 'co2e',
 * case-insensitive) and falls back to index [0] if none is labelled CO2e.
 *
 * @param {object} entry  – one item from scope.emissionFactors[]
 * @returns {number|null}  – numeric value in kg CO2e per km, or null
 */
function extractEFValue(entry) {
  if (!entry) return null;

  // ── Fast path: pre-computed field set by the API ────────────────────────────
  if (typeof entry.valueKgCO2ePerKm === 'number' && entry.valueKgCO2ePerKm >= 0) {
    return entry.valueKgCO2ePerKm;
  }

  if (!entry.source) return null;

  const cf = (v) => (typeof v === 'number' && v > 0 ? v : 1);

  // Find the CO2e row in a ghgUnits / ghgUnitsEPA array.
  function findCO2eUnit(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const hit = arr.find(u => typeof u.unit === 'string' && u.unit.toLowerCase().includes('co2e'));
    return hit || arr[0];
  }

  switch (entry.source) {
    case 'Custom': {
      const d = entry.customEmissionFactor;
      if (!d) return null;
      const v = typeof d.CO2e === 'number' ? d.CO2e : null;
      if (v === null) return null;
      const convFactor = (typeof d.CO2e_conversionFactor === 'number' && d.CO2e_conversionFactor > 0)
        ? d.CO2e_conversionFactor
        : d.conversionFactor;
      return v * cf(convFactor);
    }
    case 'DEFRA': {
      const unit = findCO2eUnit(entry.defraData?.ghgUnits);
      if (!unit) return null;
      const v = typeof unit.ghgconversionFactor === 'number' ? unit.ghgconversionFactor : null;
      return v !== null ? v * cf(unit.conversionFactor) : null;
    }
    case 'IPCC': {
      const unit = findCO2eUnit(entry.ipccData?.ghgUnits);
      if (!unit) return null;
      const v = typeof unit.ghgconversionFactor === 'number' ? unit.ghgconversionFactor : null;
      return v !== null ? v * cf(unit.conversionFactor) : null;
    }
    case 'EPA': {
      const unit = findCO2eUnit(entry.epaData?.ghgUnitsEPA);
      if (!unit) return null;
      const v = typeof unit.ghgconversionFactor === 'number' ? unit.ghgconversionFactor : null;
      return v !== null ? v * cf(unit.conversionFactor) : null;
    }
    case 'EmissionFactorHub': {
      const d = entry.emissionFactorHubData;
      if (!d) return null;
      const v = typeof d.value === 'number' ? d.value : null;
      return v !== null ? v * cf(d.conversionFactor) : null;
    }
    default:
      return null;
  }
}

/**
 * Build a transport-mode emission factor lookup function from a scope's emissionFactors[] array.
 *
 * Each entry in the array must have modeCode set; vehicleType and fuelType are optional
 * (empty string means "applies to all" for that dimension).
 *
 * Lookup uses three specificity tiers (most → least specific):
 *   Tier 1: modeCode + vehicleType + fuelType  (e.g. "PRIVATE_CAR|MEDIUM_CAR|PETROL")
 *   Tier 2: modeCode + fuelType                (e.g. "PRIVATE_CAR||PETROL")
 *   Tier 3: modeCode only                      (e.g. "PRIVATE_CAR||")
 *
 * @param {Array} emissionFactors  – scope.emissionFactors[] from the flowchart
 * @returns {Function}  (modeCode, vehicleType, fuelType) => number (kg CO2e / km)
 */
function buildEFLookup(emissionFactors) {
  const map = new Map();

  if (!Array.isArray(emissionFactors) || emissionFactors.length === 0) return () => 0;

  for (const entry of emissionFactors) {
    const value = extractEFValue(entry);
    if (value === null || value < 0) continue;

    const mode    = (entry.modeCode    || '').trim();
    const vehicle = (entry.vehicleType || '').trim();
    const fuel    = (entry.fuelType    || '').trim();

    if (!mode) continue; // entries without a modeCode cannot be matched

    const key = `${mode}|${vehicle}|${fuel}`;
    if (!map.has(key)) map.set(key, value); // first entry wins for duplicate keys
  }

  return function efLookup(modeCode, vehicleType, fuelType) {
    if (ZERO_EMISSION_MODES.has(modeCode)) return 0;

    const m = modeCode    || '';
    const v = vehicleType || '';
    const f = fuelType    || '';

    // Tier 1: exact match — mode + vehicle + fuel
    const k1 = `${m}|${v}|${f}`;
    if (map.has(k1)) return map.get(k1);

    // Tier 2: mode + fuel (ignore vehicle type)
    const k2 = `${m}||${f}`;
    if (map.has(k2)) return map.get(k2);

    // Tier 3: mode only
    const k3 = `${m}||`;
    if (map.has(k3)) return map.get(k3);

    return 0; // no factor configured for this combination
  };
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

// ─── Enum sets used in validation ────────────────────────────────────────────
const WORK_ARRANGEMENTS = ['ONSITE_FULL', 'HYBRID', 'REMOTE_FULL', 'COMPRESSED_WEEK', 'SHIFT_BASED'];

// Q9 condition: vehicle type required when primary mode is one of these
const MODES_NEEDING_VEHICLE_TYPE = new Set([
  'PRIVATE_CAR', 'PRIVATE_MOTORCYCLE', 'PRIVATE_VAN', 'CARPOOL',
]);

// Q10 condition: fuel type required when primary mode is motorized (non-zero-emission)
const MOTORIZED_MODES = new Set([
  'PRIVATE_CAR', 'PRIVATE_MOTORCYCLE', 'PRIVATE_VAN', 'CARPOOL',
  'BUS_PUBLIC', 'BUS_PRIVATE_SHUTTLE', 'TAXI', 'RIDE_HAIL',
  'OTHER_MOTORIZED',
  // REMOVED: 'METRO_SUBWAY', 'COMMUTER_RAIL', 'LIGHT_RAIL_TRAM', 'FERRY'
  // Rail/metro/ferry fuel type is determined by the emission factor config,
  // not by the employee respondent — no fuelType required from the user.
]);

// Q11 condition: occupancy required when primary mode is one of these
const MODES_NEEDING_OCCUPANCY = new Set(['PRIVATE_CAR', 'PRIVATE_VAN', 'CARPOOL']);

// Full transport mode enum (for Q8 validation)
const ALL_TRANSPORT_MODES = new Set([
  'PRIVATE_CAR', 'PRIVATE_MOTORCYCLE', 'PRIVATE_VAN', 'CARPOOL',
  'BUS_PUBLIC', 'BUS_PRIVATE_SHUTTLE', 'METRO_SUBWAY', 'COMMUTER_RAIL',
  'LIGHT_RAIL_TRAM', 'FERRY', 'TAXI', 'RIDE_HAIL',
  'E_SCOOTER_SHARED', 'BICYCLE', 'E_BICYCLE', 'WALKING',
  'OTHER_MOTORIZED', 'OTHER_NON_MOTORIZED',
]);

const ALL_VEHICLE_TYPES = new Set([
  'SMALL_CAR', 'MEDIUM_CAR', 'LARGE_CAR', 'SUV',
  'ELECTRIC_CAR', 'HYBRID_CAR_HEV', 'PHEV_CAR',
  'SMALL_MOTORCYCLE', 'MEDIUM_MOTORCYCLE', 'LARGE_MOTORCYCLE',
  'SMALL_VAN', 'LARGE_VAN', 'OTHER',
]);

const ALL_FUEL_TYPES = new Set([
  'PETROL', 'DIESEL', 'CNG', 'LPG', 'ELECTRIC',
  'HYBRID_PETROL', 'HYBRID_DIESEL',
  'PLUG_IN_HYBRID_PETROL', 'PLUG_IN_HYBRID_DIESEL',
  'HYDROGEN', 'BIOFUEL', 'UNKNOWN',
]);

/**
 * Validate survey response fields using the Q1-Q11 conditional rules from the spec.
 *
 * Conditional display rules (matching the spec table):
 *   Q2  — shown  if Q1 ≠ REMOTE_FULL
 *   Q3  — shown  if Q1 ≠ REMOTE_FULL  (optional / derived)
 *   Q4  — shown  if Q1 ≠ REMOTE_FULL
 *   Q5  — always shown
 *   Q6  — shown  if Q1 ≠ REMOTE_FULL   (default ONE_WAY)
 *   Q7  — shown  if Q1 ≠ REMOTE_FULL   (default NO)
 *   Q8  — shown  if Q7 = NO  AND  Q1 ≠ REMOTE_FULL
 *   Q9  — shown  if Q8 ∈ {PRIVATE_CAR, PRIVATE_MOTORCYCLE, PRIVATE_VAN, CARPOOL}
 *   Q10 — shown  if Q8 is a motorized mode
 *   Q11 — shown  if Q8 ∈ {PRIVATE_CAR, CARPOOL, PRIVATE_VAN}   (default 1)
 *
 * Returns: { errors: string[], warnings: string[], flags: object }
 *   errors   → hard failures; submission blocked
 *   warnings → soft flags; submission allowed, flags stored on response
 *   flags    → { hasOutlierDistance, hasMixedModeInconsistency }
 *
 * @param {object} data  – flat survey response payload
 * @returns {{ errors: string[], warnings: string[], flags: object }}
 */
function validateSurveyResponse(data) {
  const errors = [];
  const warnings = [];
  const flags = { hasOutlierDistance: false, hasMixedModeInconsistency: false };

  // ── Q1: work_arrangement — always required ──────────────────────────────────
  if (!data.workArrangement || !WORK_ARRANGEMENTS.includes(data.workArrangement)) {
    errors.push(
      `Q1 (workArrangement) is required and must be one of: ${WORK_ARRANGEMENTS.join(', ')}.`
    );
  }

  // ── Q5: distance_unit — always present; pre-filled from config ─────────────
  if (data.distanceUnit !== undefined && data.distanceUnit !== null) {
    if (!['km', 'miles'].includes(data.distanceUnit)) {
      errors.push('Q5 (distanceUnit) must be "km" or "miles".');
    }
  }
  // If omitted by client, default will be 'km' — not a hard error at validation stage.

  const isRemote = data.workArrangement === 'REMOTE_FULL';

  // Questions Q2–Q7 are only validated when Q1 ≠ REMOTE_FULL
  if (!isRemote) {

    // ── Q2: commute_days_per_week — shown if Q1 ≠ REMOTE_FULL, step 0.5 ───────
    if (data.commuteDaysPerWeek == null) {
      errors.push('Q2 (commuteDaysPerWeek) is required when work arrangement is not fully remote.');
    } else {
      const cdpw = Number(data.commuteDaysPerWeek);
      if (isNaN(cdpw) || cdpw < 0.5 || cdpw > 7.0) {
        errors.push('Q2 (commuteDaysPerWeek) must be between 0.5 and 7.0.');
      } else if (Math.round(cdpw * 2) !== cdpw * 2) {
        errors.push('Q2 (commuteDaysPerWeek) must be in increments of 0.5 (e.g. 1.0, 1.5, 2.0).');
      } else if (cdpw > 5) {
        warnings.push('Q2: More than 5 commuting days per week is unusual — please verify.');
      }
    }

    // ── Q3: commute_days_in_period — shown if Q1 ≠ REMOTE_FULL, optional/derived
    if (data.commuteDaysInPeriod != null) {
      const cdip = Number(data.commuteDaysInPeriod);
      if (isNaN(cdip) || cdip < 0 || cdip > 366) {
        errors.push('Q3 (commuteDaysInPeriod) must be between 0 and 366.');
      }
    }

    // ── Q4: one_way_distance — shown if Q1 ≠ REMOTE_FULL, 0.1–500 ─────────────
    if (data.oneWayDistance == null) {
      errors.push('Q4 (oneWayDistance) is required when work arrangement is not fully remote.');
    } else {
      const dist = Number(data.oneWayDistance);
      if (isNaN(dist) || dist < 0.1 || dist > 500) {
        errors.push('Q4 (oneWayDistance) must be between 0.1 and 500.');
      } else if (dist > 200) {
        warnings.push('Q4: Distance exceeds 200 km — please verify (outlier flagged).');
        flags.hasOutlierDistance = true;
      }
    }

    // ── Q6: trip_type — shown if Q1 ≠ REMOTE_FULL, default ONE_WAY ────────────
    if (!data.tripType) {
      // Default to ONE_WAY if omitted — not a hard error
    } else if (!['ONE_WAY', 'ROUND_TRIP'].includes(data.tripType)) {
      errors.push('Q6 (tripType) must be "ONE_WAY" or "ROUND_TRIP".');
    }

    // ── Q7: is_mixed_mode — shown if Q1 ≠ REMOTE_FULL, default NO ─────────────
    if (!data.isMixedMode) {
      // Default to NO if omitted — not a hard error
    } else if (!['YES', 'NO'].includes(data.isMixedMode)) {
      errors.push('Q7 (isMixedMode) must be "YES" or "NO".');
    }

    const effectiveMixedMode = data.isMixedMode || 'NO';

    // ── Q8: primary_mode_code — shown if Q7 = NO AND Q1 ≠ REMOTE_FULL ─────────
    if (effectiveMixedMode === 'NO') {
      if (!data.primaryModeCode) {
        errors.push('Q8 (primaryModeCode) is required when isMixedMode is NO.');
      } else if (!ALL_TRANSPORT_MODES.has(data.primaryModeCode)) {
        errors.push(
          `Q8 (primaryModeCode) "${data.primaryModeCode}" is not a recognised transport mode.`
        );
      } else {
        const mode = data.primaryModeCode;

        // ── Q9: vehicle_type — shown if Q8 ∈ vehicle-type modes ───────────────
        if (MODES_NEEDING_VEHICLE_TYPE.has(mode)) {
          if (!data.vehicleType) {
            errors.push(
              `Q9 (vehicleType) is required when primary mode is ${mode}.`
            );
          } else if (!ALL_VEHICLE_TYPES.has(data.vehicleType)) {
            errors.push(
              `Q9 (vehicleType) "${data.vehicleType}" is not a recognised vehicle type.`
            );
          }
        }

        // ── Q10: fuel_type — shown if Q8 is a motorized mode ──────────────────
        if (MOTORIZED_MODES.has(mode)) {
          if (!data.fuelType) {
            errors.push(
              `Q10 (fuelType) is required when primary mode is ${mode}.`
            );
          } else if (!ALL_FUEL_TYPES.has(data.fuelType)) {
            errors.push(
              `Q10 (fuelType) "${data.fuelType}" is not a recognised fuel type.`
            );
          }
        }

        // ── Q11: occupancy — shown if Q8 ∈ {PRIVATE_CAR, CARPOOL, PRIVATE_VAN} ─
        if (MODES_NEEDING_OCCUPANCY.has(mode)) {
          if (data.occupancy == null) {
            errors.push(
              `Q11 (occupancy) is required when primary mode is ${mode}.`
            );
          } else {
            const occ = Number(data.occupancy);
            if (!Number.isInteger(occ) || occ < 1 || occ > 10) {
              errors.push('Q11 (occupancy) must be an integer between 1 and 10.');
            } else if (occ > 6) {
              warnings.push('Q11: Unusually high vehicle occupancy — please verify.');
            }
          }
        }
      }
    }

    // ── Mixed-mode legs — validated when Q7 = YES ─────────────────────────────
    if (effectiveMixedMode === 'YES') {
      const legs = Array.isArray(data.legs) ? data.legs : [];
      const MAX_LEGS = 5;

      if (legs.length < 2) {
        errors.push('Mixed-mode commute requires at least 2 legs.');
      } else if (legs.length > MAX_LEGS) {
        errors.push(`Mixed-mode commute allows a maximum of ${MAX_LEGS} legs.`);
      } else {
        legs.forEach((leg, idx) => {
          const n = idx + 1;

          // M2: leg mode
          if (!leg.legModeCode) {
            errors.push(`Leg ${n}: legModeCode is required.`);
          } else if (!ALL_TRANSPORT_MODES.has(leg.legModeCode)) {
            errors.push(`Leg ${n}: legModeCode "${leg.legModeCode}" is not a recognised transport mode.`);
          }

          // M3: leg distance
          if (leg.legDistanceKm == null) {
            errors.push(`Leg ${n}: legDistanceKm is required.`);
          } else if (Number(leg.legDistanceKm) <= 0) {
            errors.push(`Leg ${n}: legDistanceKm must be a positive number.`);
          }

          // M4: vehicle type for private vehicle legs
          if (leg.legModeCode && MODES_NEEDING_VEHICLE_TYPE.has(leg.legModeCode)) {
            if (!leg.legVehicleType) {
              errors.push(`Leg ${n}: legVehicleType is required for mode ${leg.legModeCode}.`);
            } else if (!ALL_VEHICLE_TYPES.has(leg.legVehicleType)) {
              errors.push(`Leg ${n}: legVehicleType "${leg.legVehicleType}" is not recognised.`);
            }
          }

          // M5: fuel type for motorized private legs
          if (leg.legModeCode && MOTORIZED_MODES.has(leg.legModeCode)) {
            if (!leg.legFuelType) {
              errors.push(`Leg ${n}: legFuelType is required for mode ${leg.legModeCode}.`);
            } else if (!ALL_FUEL_TYPES.has(leg.legFuelType)) {
              errors.push(`Leg ${n}: legFuelType "${leg.legFuelType}" is not recognised.`);
            }
          }

          // M6: occupancy for carpool/private legs
          if (leg.legModeCode && MODES_NEEDING_OCCUPANCY.has(leg.legModeCode)) {
            if (leg.legOccupancy == null) {
              errors.push(`Leg ${n}: legOccupancy is required for mode ${leg.legModeCode}.`);
            } else {
              const occ = Number(leg.legOccupancy);
              if (!Number.isInteger(occ) || occ < 1 || occ > 10) {
                errors.push(`Leg ${n}: legOccupancy must be an integer between 1 and 10.`);
              }
            }
          }
        });

        // ± 10% consistency check against Q4 one-way distance
        if (data.oneWayDistance != null && data.distanceUnit && data.tripType) {
          const oneWayKm = deriveOneWayKm(
            Number(data.oneWayDistance),
            data.distanceUnit,
            data.tripType
          );
          const legSumKm = legs.reduce((s, l) => s + (Number(l.legDistanceKm) || 0), 0);
          if (legSumKm < oneWayKm * 0.9 || legSumKm > oneWayKm * 1.1) {
            warnings.push(
              `Mixed-mode: sum of leg distances (${legSumKm.toFixed(2)} km) ` +
              `differs from one-way distance (${oneWayKm.toFixed(2)} km) by more than 10%.`
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
  buildEFLookup,
  ZERO_EMISSION_MODES,
  VEHICLE_KM_MODES,
};
