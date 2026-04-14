// models/Organization/SurveyResponse.js
// Stores individual employee commuting survey responses.
//
// Fields are tagged:
//   CALC_CRITICAL — stored in dedicated columns; fed to the emission calculator
//   ANALYTICS_ONLY — stored in analyticsData (Mixed/JSONB); never affect calculations
const mongoose = require('mongoose');

// ─── Transport mode enum (mirrors spec) ─────────────────────────────────────
const TRANSPORT_MODES = [
  'PRIVATE_CAR', 'PRIVATE_MOTORCYCLE', 'PRIVATE_VAN', 'CARPOOL',
  'BUS_PUBLIC', 'BUS_PRIVATE_SHUTTLE', 'METRO_SUBWAY', 'COMMUTER_RAIL',
  'LIGHT_RAIL_TRAM', 'FERRY', 'TAXI', 'RIDE_HAIL',
  'E_SCOOTER_SHARED', 'BICYCLE', 'E_BICYCLE', 'WALKING',
  'OTHER_MOTORIZED', 'OTHER_NON_MOTORIZED',
];

// ─── Vehicle type enum ───────────────────────────────────────────────────────
const VEHICLE_TYPES = [
  'SMALL_CAR', 'MEDIUM_CAR', 'LARGE_CAR', 'SUV',
  'ELECTRIC_CAR', 'HYBRID_CAR_HEV', 'PHEV_CAR',
  'SMALL_MOTORCYCLE', 'MEDIUM_MOTORCYCLE', 'LARGE_MOTORCYCLE',
  'SMALL_VAN', 'LARGE_VAN', 'OTHER',
];

// ─── Fuel type enum ──────────────────────────────────────────────────────────
const FUEL_TYPES = [
  'PETROL', 'DIESEL', 'CNG', 'LPG', 'ELECTRIC',
  'HYBRID_PETROL', 'HYBRID_DIESEL',
  'PLUG_IN_HYBRID_PETROL', 'PLUG_IN_HYBRID_DIESEL',
  'HYDROGEN', 'BIOFUEL', 'UNKNOWN',
];

// ─── Mixed-mode leg sub-schema ───────────────────────────────────────────────
const LegSchema = new mongoose.Schema(
  {
    legModeCode: { type: String, enum: TRANSPORT_MODES, default: null },
    legDistanceKm: { type: Number, default: null },
    legVehicleType: { type: String, enum: [...VEHICLE_TYPES, null], default: null },
    legFuelType: { type: String, enum: [...FUEL_TYPES, null], default: null },
    legOccupancy: { type: Number, min: 1, max: 10, default: null },
  },
  { _id: false }
);

// ─── Main response schema ────────────────────────────────────────────────────
const SurveyResponseSchema = new mongoose.Schema(
  {
    // ─── Pre-survey system fields (CALC_CRITICAL) ──────────────────────────────
    clientId: { type: String, required: true, index: true },
    flowchartId: { type: mongoose.Schema.Types.ObjectId, ref: 'Flowchart', default: null },
    processFlowchartId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProcessFlowchart', default: null },
    nodeId: { type: String, required: true },
    scopeIdentifier: { type: String, required: true, index: true },

    cycleIndex: { type: Number, required: true },
    cycleDate: { type: Date, required: true },
    reportingYear: { type: Number, required: true },

    responseMode: {
      type: String,
      enum: ['unique', 'anonymous'],
      required: true,
    },

    // unique mode — ref to the SurveyLink
    surveyLinkId: { type: mongoose.Schema.Types.ObjectId, ref: 'SurveyLink', default: null },
    recipientId: { type: String, default: null },

    // anonymous mode — stores the human-readable code label (no identity linkage)
    anonymousCodeId: { type: String, default: null },
    anonymousCodeDocId: { type: mongoose.Schema.Types.ObjectId, ref: 'AnonymousCode', default: null },

    responseTimestamp: { type: Date, default: Date.now },

    // ─── Q1: Work arrangement (CALC_CRITICAL) ──────────────────────────────────
    workArrangement: {
      type: String,
      enum: ['ONSITE_FULL', 'HYBRID', 'REMOTE_FULL', 'COMPRESSED_WEEK', 'SHIFT_BASED'],
      required: true,
    },

    // ─── Q2: Commute days per week (CALC_CRITICAL) ─────────────────────────────
    // Required when workArrangement !== REMOTE_FULL
    commuteDaysPerWeek: { type: Number, min: 0.5, max: 7.0, default: null },

    // ─── Q3: Total commuting days in period (CALC_CRITICAL, derived or entered) ─
    commuteDaysInPeriod: { type: Number, min: 0, max: 366, default: null },

    // ─── Q4: One-way distance (CALC_CRITICAL) ─────────────────────────────────
    oneWayDistance: { type: Number, min: 0.1, max: 500, default: null },

    // ─── Q5: Distance unit (CALC_CRITICAL) ────────────────────────────────────
    distanceUnit: { type: String, enum: ['km', 'miles'], default: 'km' },

    // ─── Q6: Trip type (CALC_CRITICAL) ────────────────────────────────────────
    tripType: { type: String, enum: ['ONE_WAY', 'ROUND_TRIP'], default: null },

    // ─── Q7: Mixed mode flag (CALC_CRITICAL) ──────────────────────────────────
    isMixedMode: { type: String, enum: ['YES', 'NO'], default: null },

    // ─── Q8: Primary mode (CALC_CRITICAL) ─────────────────────────────────────
    primaryModeCode: { type: String, enum: TRANSPORT_MODES, default: null },

    // ─── Q9: Vehicle type (CALC_CRITICAL) ─────────────────────────────────────
    vehicleType: { type: String, enum: [...VEHICLE_TYPES, null, ''], default: null },

    // ─── Q10: Fuel type (CALC_CRITICAL) ───────────────────────────────────────
    fuelType:    { type: String, enum: [...FUEL_TYPES, null, ''],   default: null },

    // ─── Q11: Occupancy (CALC_CRITICAL) ───────────────────────────────────────
    occupancy: { type: Number, min: 1, max: 10, default: null },

    // ─── Mixed-mode legs (CALC_CRITICAL) ──────────────────────────────────────
    legs: { type: [LegSchema], default: [] },

    // ─── Analytics-only questions (ANALYTICS_ONLY) ────────────────────────────
    // Stored as JSONB; never used in emission calculations.
    // Adding/removing analytics questions requires no changes to the calc engine.
    analyticsData: { type: mongoose.Schema.Types.Mixed, default: null },

    // ─── Calculation output ───────────────────────────────────────────────────
    calculatedEmissions: { type: Number, default: null }, // kg CO2e
    calculationBreakdown: { type: mongoose.Schema.Types.Mixed, default: null },

    // ─── Data quality flags ───────────────────────────────────────────────────
    hasOutlierDistance: { type: Boolean, default: false },         // oneWayDistance > 200
    hasMixedModeInconsistency: { type: Boolean, default: false },  // leg sum ± >10% of Q4

    // ─── Versioning ───────────────────────────────────────────────────────────
    surveyVersion: { type: String, default: '1.0' },
  },
  { timestamps: true }
);

SurveyResponseSchema.index({ clientId: 1, scopeIdentifier: 1, cycleIndex: 1 });
SurveyResponseSchema.index({ responseMode: 1, cycleIndex: 1 });

module.exports = mongoose.model('SurveyResponse', SurveyResponseSchema);
module.exports.TRANSPORT_MODES = TRANSPORT_MODES;
module.exports.VEHICLE_TYPES = VEHICLE_TYPES;
module.exports.FUEL_TYPES = FUEL_TYPES;
