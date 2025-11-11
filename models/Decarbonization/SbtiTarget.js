// models/Targets/SbtiTarget.js
const mongoose = require('mongoose');

const RenewableYearSchema = new mongoose.Schema({
  year: { type: Number, required: true },
  renewableMWh: { type: Number, default: 0 },
  totalMWh: { type: Number, default: 0 },
  percentRE: { type: Number, default: 0 }, // computed: (renewable/total)*100
}, { _id: false });

const SupplierEngagementYearSchema = new mongoose.Schema({
  year: { type: Number, required: true },
  coveredEmissions_tCO2e: { type: Number, default: 0 },
  totalSupplierEmissions_tCO2e: { type: Number, default: 0 },
  percentSuppliersWithSBTs: { type: Number, default: 0 }, // computed
}, { _id: false });


/**
 * Year-by-year progress of *emissions vs SBTi target*.
 * This will be driven by CalculationSummary (yearly summaries).
 */
const EmissionProgressYearSchema = new mongoose.Schema({
  year: { type: Number, required: true },
  scopeSet: { type: String, enum: ['S1S2', 'S3'], default: 'S1S2' },

  baselineEmission_tCO2e: { type: Number, default: 0 },
  targetEmission_tCO2e: { type: Number, default: 0 },
  actualEmission_tCO2e: { type: Number, default: 0 },

  requiredReduction_tCO2e: { type: Number, default: 0 },  // base - target
  achievedReduction_tCO2e: { type: Number, default: 0 },  // base - actual

  // Percent vs base
  requiredReductionPercent: { type: Number, default: 0 },   // required / base * 100
  achievedReductionPercent: { type: Number, default: 0 },   // achieved / base * 100

  // How much of the SBT “gap” we already covered
  percentOfTargetAchieved: { type: Number, default: 0 },    // achieved / required * 100

  isOnTrack: { type: Boolean, default: false },

  lastUpdatedFromSummaryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EmissionSummary',
    default: null,
  },
}, { _id: false });



const FlagSchema = new mongoose.Schema({
  flagSharePercent: { type: Number, default: 0 }, // % of total emissions that are FLAG-related
  scope1CoveragePercent: { type: Number, default: 0 },
  scope3CoveragePercent: { type: Number, default: 0 },
  isFlagTargetRequired: { type: Boolean, default: false }, // >= 20%
  coverageOk: { type: Boolean, default: false },          // S1 ≥95% & S3 ≥67% when required
}, { _id: false });

const TrajectoryPointSchema = new mongoose.Schema({
  year: { type: Number, required: true },
  targetEmission_tCO2e: { type: Number, required: true },
  cumulativeReductionPercent: { type: Number, required: true }, // 0..100
}, { _id: false });

const AbsoluteMethodSchema = new mongoose.Schema({
  minimumReductionPercent: { type: Number, default: null }, // e.g., 42 means 42%
  annualRatePercent: { type: Number, default: null },       // computed as minReduction / N (linear)
}, { _id: false });

const SDAMethodSchema = new mongoose.Schema({
  baseActivity: { type: Number, default: null },         // activity units at base year
  targetIntensity: { type: Number, default: null },      // tCO2e per activity unit at target year
  intensityUnit: { type: String, default: 'tCO2e/unit' },
  activityTarget: { type: Number, default: null },       // activity units at target year
  baseIntensity: { type: Number, default: null },        // computed = baseEmission/baseActivity
  intensityReductionPercent: { type: Number, default: null }, // computed
  absoluteTargetEmission_tCO2e: { type: Number, default: null }, // computed = targetIntensity * activityTarget
  absoluteReductionPercent: { type: Number, default: null },     // computed
  annualReductionPercent: { type: Number, default: null },       // computed = absRed% / N
}, { _id: false });

const CoverageSchema = new mongoose.Schema({
  scope12CoveragePercent: { type: Number, default: 0 }, // should be ≥95% for S1+S2
  scope3ShareOfTotalPercent: { type: Number, default: 0 }, // materiality check (≥40%)
  scope3CoveragePercent: { type: Number, default: 0 },  // ≥67% near-term, ≥90% net-zero
  meetsNearTermS3: { type: Boolean, default: false },
  meetsNetZeroS3: { type: Boolean, default: false },
}, { _id: false });

const InventoryCoverageSchema = new mongoose.Schema({
  // Scope 1 + 2 coverage (Exclusion Check)
  s12TargetBoundary_tCO2e: { type: Number, default: 0 },       // Emissions included in the target boundary (S1+S2)
  s12TotalInclExcluded_tCO2e: { type: Number, default: 0 },     // Total S1+S2 incl. excluded
  percentS12Covered: { type: Number, default: 0 },              // = s12TargetBoundary / s12TotalInclExcluded * 100

  // Scope 3 Reported coverage (Exclusion Check)
  s3Reported_tCO2e: { type: Number, default: 0 },               // reported S3
  s3Excluded_tCO2e: { type: Number, default: 0 },               // excluded S3
  percentS3Reported: { type: Number, default: 0 },              // = s3Reported / (s3Reported + s3Excluded) * 100

  // Scope 3 Target coverage (67% Test)
  s3CategoriesWithTargets_tCO2e: { type: Number, default: 0 },  // sum of emissions in S3 categories that have targets
  s3Total_tCO2e: { type: Number, default: 0 },                  // total S3 emissions
  percentS3CoveredByTargets: { type: Number, default: 0 },      // = s3CategoriesWithTargets / s3Total * 100
  meetsS3TargetCoverage67: { type: Boolean, default: false },   // >= 67% ?
}, { _id: false });
const SbtiTargetSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },

  // SBTi vs Custom, Near-term vs Net-zero
  alignment: { type: String, enum: ['SBTi', 'custom'], default: 'SBTi' },
  targetType: { type: String, enum: ['near_term', 'net_zero'], required: true },

  // Method: absolute contraction or SDA
  method: { type: String, enum: ['absolute', 'sda'], required: true },

  // Years & base values
  baseYear: { type: Number, required: true },
  targetYear: { type: Number, required: true },
  // Considered scope set for this target
  scopeSet: { type: String, enum: ['S1S2', 'S3'], default: 'S1S2' },

  // Separate base emissions by scope (all in tCO2e)
  baseScope1_tCO2e: { type: Number, default: 0 },
  baseScope2_tCO2e: { type: Number, default: 0 },
  baseScope3_tCO2e: { type: Number, default: 0 },

  baseEmission_tCO2e: { type: Number, required: true }, // can be total across S1+S2(+S3 if included)
  inventoryCoverage: { type: InventoryCoverageSchema, default: () => ({}) },
  perScopeBase_tCO2e: {
    type: Map, of: Number, default: undefined // e.g., {'Scope 1': 1000, 'Scope 2': 500, 'Scope 3': 9000}
  },

  // Method-specific data
  absolute: AbsoluteMethodSchema,
  sda: SDAMethodSchema,

  // Progress tracking
  renewableElectricity: [RenewableYearSchema],
  supplierEngagement: [SupplierEngagementYearSchema],
  flag: FlagSchema,
  coverage: CoverageSchema,

    // Emissions-vs-target progress per year (kept in sync with CalculationSummary)
  emissionProgress: [EmissionProgressYearSchema],

  // Generated trajectory
  trajectory: [TrajectoryPointSchema],

  // Tool / method versioning and grace period tracking (6 months grace after update)
  toolVersion: { type: String, default: 'SBTi-2025-08-v1' },
  toolUpdatedAt: { type: Date, default: new Date('2025-08-01') },
  gracePeriodEndsAt: { type: Date, default: null }, // computed on save: +6 months
  isWithinGrace: { type: Boolean, default: true },

  // Meta
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, {
  timestamps: true,
});

SbtiTargetSchema.index({ clientId: 1, targetType: 1 }, { unique: false });

SbtiTargetSchema.pre('validate', function(next) {
  // Only auto-calc if scopeSet is present (default 'S1S2')
  if (this.scopeSet === 'S3') {
    const s3 = Number(this.baseScope3_tCO2e || 0);
    this.baseEmission_tCO2e = s3;
    this.perScopeBase_tCO2e = new Map([['Scope 3', s3]]);
  } else { // 'S1S2'
    const s1 = Number(this.baseScope1_tCO2e || 0);
    const s2 = Number(this.baseScope2_tCO2e || 0);
    this.baseEmission_tCO2e = s1 + s2;
    this.perScopeBase_tCO2e = new Map([['Scope 1', s1], ['Scope 2', s2]]);
  }
  next();
});

SbtiTargetSchema.pre('save', function(next) {
  if (!this.gracePeriodEndsAt && this.toolUpdatedAt) {
    const d = new Date(this.toolUpdatedAt);
    d.setMonth(d.getMonth() + 6);
    this.gracePeriodEndsAt = d;
  }
  this.isWithinGrace = this.gracePeriodEndsAt ? (new Date() <= this.gracePeriodEndsAt) : true;
  next();
});

module.exports = mongoose.model('SbtiTarget', SbtiTargetSchema);
