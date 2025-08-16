// models/Reduction.js
const mongoose = require('mongoose');
const { Schema } = mongoose; // ✅ FIX: needed for Schema.Types.ObjectId and nested Schema uses

/**
 * Counter for per-client ReductionID sequences
 * key = `${clientId}_reduction`
 */
const reductionCounterSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // key
  seq: { type: Number, default: 0 }
});
const ReductionCounter = mongoose.model('ReductionCounter', reductionCounterSchema);

/** Common sub-unit schema (ABD/APD/ALD item) */
const UnitItemSchema = new mongoose.Schema({
  label: { type: String, required: true },      // e.g., B1, P2, L3
  value: { type: Number, required: true },      // ABD1/APD1/ALD1 numeric value
  EF:    { type: Number, required: true },      // Emission factor
  GWP:   { type: Number, required: true },      // Global warming potential
  AF:    { type: Number, required: true },      // Adjustment factor (e.g., activity/engineering factor)
  uncertainty: { type: Number, default: 0 }     // percent; 5 = 5%
}, {_id:false});

const M2Schema = new mongoose.Schema({
  // ALD inputs (for LE computation)
  ALD: [UnitItemSchema],

  // computed totals
  LE: { type: Number, default: 0 }, // Sum(Li_with_uncertainty)
  // optional detailed breakdown if you want to inspect later
  _debug: {
    Lpartials: [{ label: String, L: Number, LwithUncertainty: Number }]
  },

  // mapping to a formula that computes "netReductionInFormula"
  formulaRef: {
    formulaId:   { type: Schema.Types.ObjectId, ref: 'ReductionFormula' },
    version:     { type: Number },
    // frozen variables current values (and optional policy info)
    variables:   { type: Map, of: new Schema({
      value:        { type: Number, default: null },
      updatePolicy: { type: String, enum: ['manual','annual_automatic'], default: 'manual' },
      lastUpdatedAt:{ type: Date }
    }, { _id: false }) }
  }
}, { _id: false });

const ReductionEntrySchema = new mongoose.Schema({
  // normalized type stored in the document
  inputType: { type: String, enum: ['manual','API','IOT'], default: 'manual' },
  // what the user originally sent; CSV is allowed here but we normalize to manual
  originalInputType: { type: String, enum: ['manual','API','IOT','CSV'], default: 'manual' },
  apiEndpoint: { type: String, default: '' },  // required when inputType === 'API'
  iotDeviceId: { type: String, default: '' }   // required when inputType === 'IOT'
}, { _id: false });

/**
 * Main Reduction schema
 */
const reductionSchema = new mongoose.Schema({
  // Ownership / access
  clientId: { type: String, required: true, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdByType: { type: String, enum: ['consultant_admin','consultant'], required: true },

  // Identity
  reductionId: { type: String, required: true, index: true },   // auto e.g. RED-Greon001-0001
  projectId:   { type: String, required: true, unique: true },  // `${clientId}-${reductionId}`

  // Project basics
  projectName: { type: String, required: true },
  projectActivity: { type: String, enum: ['Reduction','Removal'], required: true }, // enum
  category: { type: String, default: '' }, // optional, e.g. 'Energy Efficiency'
  scope: { type: String, default: '' }, // optional
  location: {
    place: { type: String, default: '' }, // e.g. 'Mumbai, India'
    address: { type: String, default: '' }, // e.g. '123 Main St, Mumbai'
    latitude:  { type: Number, default: null },
    longitude: { type: Number, default: null }
  },

  // Period
  commissioningDate: { type: Date, required: true },
  endDate:           { type: Date, required: true },
  projectPeriodDays: { type: Number, default: 0 }, // auto (end - start in days)

  description: { type: String, default: '' },

  // Baseline Method selection
  baselineMethod: {
    type: String,
    enum: [
      'Benchmark/Intensity',            // default
      'Historical (Adjusted) Baseline',
      'Current Practice / Business-as-Usual (BAU)',
      'Benchmark / Performance Standard Baseline',
      'Engineering / Modelled Baseline'
    ],
    default: 'Benchmark/Intensity'
  },
  baselineJustification: { type: String, default: '' },

  // Calculation Methodology
  calculationMethodology: { type: String, enum: ['methodology1','methodology2'], required: true },

  // Methodology 1 data
  m1: {
    ABD: [UnitItemSchema], // Baseline units → BE
    APD: [UnitItemSchema], // Project units → PE
    ALD: [UnitItemSchema], // Leakage units → LE
    bufferPercent: { type: Number, default: 0 }, // default 0

    // Results (auto-calculated)
    BE: { type: Number, default: 0 },             // Baseline Emissions
    PE: { type: Number, default: 0 },             // Project Emissions
    LE: { type: Number, default: 0 },             // Leakage Emissions
    bufferEmission: { type: Number, default: 0 }, // Buffer( BE - PE - LE ) / 100 * bufferPercent
    ER: { type: Number, default: 0 },             // Emission Reduction = BE - PE - bufferEmission
    CAPD: { type: Number, default: 0 },           // cumulative of all APD values (sum(APD[i].value))
    emissionReductionRate: { type: Number, default: 0 } // ER/CAPD (safe 0 if CAPD=0)
  },

  // Methodology 2 data
  m2: { type: M2Schema, default: undefined }, // only when methodology2

  reductionDataEntry: { type: ReductionEntrySchema, default: () => ({ inputType:'manual', originalInputType:'manual' }) },

  // Soft delete / meta
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date },
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

// ---------- helpers ----------
function round6(n){ return Math.round((Number(n)||0)*1e6)/1e6; }

/** Helpers: core math for Methodology 1 */
function sumWithUncertainty(items) {
  // For each item: Raw = value * EF * GWP * AF
  // WithUncertainty = Raw * (1 + uncertainty/100)
  // Return Sum(WithUncertainty)
  let total = 0;
  for (const it of (items || [])) {
    const raw = (it.value || 0) * (it.EF || 0) * (it.GWP || 0) * (it.AF || 0);
    const withUnc = raw * (1 + (Number(it.uncertainty || 0) / 100));
    total += withUnc;
  }
  return total;
}

function calcM1(doc) {
  const BE = sumWithUncertainty(doc.m1.ABD);
  const PE = sumWithUncertainty(doc.m1.APD);
  const LE = sumWithUncertainty(doc.m1.ALD);

  const gross = BE - PE - LE;
  const bufferEmission = (Number(doc.m1.bufferPercent || 0) / 100) * gross;
  const ER = BE - PE - LE - bufferEmission;

  const CAPD = (doc.m1.APD || []).reduce((s, v) => s + (Number(v.value) || 0), 0);
  const emissionReductionRate = CAPD > 0 ? ER / CAPD : 0;

  doc.m1.BE = round6(BE);
  doc.m1.PE = round6(PE);
  doc.m1.LE = round6(LE);
  doc.m1.bufferEmission = round6(bufferEmission);
  doc.m1.ER = round6(ER);
  doc.m1.CAPD = round6(CAPD);
  doc.m1.emissionReductionRate = round6(emissionReductionRate);
}

/** Pre-validate: auto period days + methodology calculations + IDs */
reductionSchema.pre('validate', async function(next) {
  try {
    // Project period (days)
    if (this.commissioningDate && this.endDate) {
      const diffMs = this.endDate.getTime() - this.commissioningDate.getTime();
      this.projectPeriodDays = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
    }

    // Auto ReductionID + ProjectID on first create
    if (this.isNew) {
      // per-client running counter
      const counterKey = `${this.clientId}_reduction`;
      const c = await ReductionCounter.findByIdAndUpdate(
        counterKey,
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
      );
      const seqStr = String(c.seq).padStart(4, '0');
      this.reductionId = `RED-${this.clientId}-${seqStr}`;
      this.projectId = `${this.clientId}-${this.reductionId}`;
    }

    // Normalize reductionDataEntry (✅ run this BEFORE next())
    if (this.reductionDataEntry) {
      const r = this.reductionDataEntry;
      const rawType = (r.originalInputType || r.inputType || 'manual').toString().toLowerCase();

      if (rawType === 'csv') {
        r.originalInputType = 'CSV';
        r.inputType = 'manual';
        r.apiEndpoint = '';
        r.iotDeviceId = '';
      } else if (rawType === 'api') {
        r.originalInputType = 'API';
        r.inputType = 'API';
        r.iotDeviceId = '';
      } else if (rawType === 'iot') {
        r.originalInputType = 'IOT';
        r.inputType = 'IOT';
        r.apiEndpoint = '';
      } else {
        r.originalInputType = 'manual';
        r.inputType = 'manual';
        r.apiEndpoint = '';
        r.iotDeviceId = '';
      }
    }

    // Calculations
    if (this.calculationMethodology === 'methodology1') {
      calcM1(this);
    }

    // m2: compute LE from ALD like m1 (uncertainty in PERCENT)
    if (this.calculationMethodology === 'methodology2' && this.m2 && Array.isArray(this.m2.ALD)) {
      let LE = 0;
      const debug = [];
      this.m2.ALD.forEach((it, idx) => {
        const label = it.label || `L${idx+1}`;
        const L  = (Number(it.value)||0) * (Number(it.EF)||0) * (Number(it.GWP)||0) * (Number(it.AF)||0);
        const Lu = L * (1 + (Number(it.uncertainty)||0) / 100); // ✅ percent, same as m1
        LE += Lu;
        debug.push({ label, L: round6(L), LwithUncertainty: round6(Lu) });
      });
      this.m2.LE = round6(LE);
      this.m2._debug = { Lpartials: debug };
    }

    next();
  } catch (e) {
    next(e);
  }
});

/** Virtual: projectPeriodFormatted (DD/MM/YYYY style as duration: DD/MM/YYYY) */
reductionSchema.virtual('projectPeriodFormatted').get(function() {
  const days = this.projectPeriodDays || 0;
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  const remDays = days - (years * 365) - (months * 30);
  // DD/MM/YYYY style positions ⇒ D/M/Y
  return `${String(remDays).padStart(2,'0')}/${String(months).padStart(2,'0')}/${String(years).padStart(4,'0')}`;
});

module.exports = mongoose.model('Reduction', reductionSchema);
