// models/NetReductionEntry.js
const mongoose = require('mongoose');
const moment = require('moment');

const NetReductionEntrySchema = new mongoose.Schema({
  // Keys
  clientId:        { type: String, required: true, index: true },
  projectId:       { type: String, required: true, index: true },
calculationMethodology: { 
  type: String, 
  enum: ['methodology1', 'methodology2', 'methodology3'], 
  required: true 
},
  // Input provenance
  inputType:       { type: String, enum: ['manual','API','IOT','CSV'], required: true, index: true },
  sourceDetails: {
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    apiEndpoint: String,
    iotDeviceId: String,
    fileName: String,
    dataSource: String
  },

  // Time stamps (as requested)
  date:            { type: String }, // "DD/MM/YYYY"
  time:            { type: String }, // "HH:mm"
  timestamp:       { type: Date, required: true, index: true },

  // Payload & math (shared)
inputValue: {
  type: Number,
  required: function() {
    return this.calculationMethodology === "methodology1";
  },
  default: 0
},

emissionReductionRate: {
  type: Number,
  required: function() {
    return this.calculationMethodology === "methodology1";
  },
  default: 0
},  // for M1; M2 controllers can leave this 0
  netReduction:            { type: Number, default: 0 },      // final net reduction
  cumulativeNetReduction:  { type: Number, default: 0 },      // running cumulative per project
  highNetReduction:        { type: Number, default: 0 },      // highest single netReduction so far
  lowNetReduction:         { type: Number, default: 0 }       // lowest single netReduction so far
}, {
  timestamps: true,
  collection: 'netreductionentries'
});

NetReductionEntrySchema.index({ clientId:1, projectId:1, timestamp:-1 });

function round6(n) {
  return Math.round((Number(n) || 0) * 1e6) / 1e6;
}

NetReductionEntrySchema.pre('validate', function(next){
  // Ensure date/time exist in requested format if not provided (use IST)
  if (!this.date || !this.time) {
    const now = moment().utcOffset('+05:30');
    this.date = this.date || now.format('DD/MM/YYYY');
    this.time = this.time || now.format('HH:mm');
  }
  // Ensure timestamp exists if not provided
  if (!this.timestamp && this.date && this.time) {
    const m = moment(`${this.date} ${this.time}`, 'DD/MM/YYYY HH:mm', true);
    this.timestamp = m.isValid() ? m.toDate() : new Date();
  }
  next();
});

NetReductionEntrySchema.add({
  formulaId:            { type: mongoose.Schema.Types.ObjectId, ref: 'ReductionFormula' },
  variables:            { type: mongoose.Schema.Types.Mixed, default: {} }, // realtime payload used for evaluation
  netReductionInFormula:{ type: Number, default: 0 },                         // result before subtracting LE

  // ✅ For Methodology 3 – store totals & breakdown
  m3: {
    // Totals (without and with buffer / “uncertainty”)
    BE_total:               { type: Number, default: 0 },  // Sum of all Bi
    PE_total:               { type: Number, default: 0 },  // Sum of all Pi
    LE_total:               { type: Number, default: 0 },  // Sum of all Li

    netWithoutUncertainty:  { type: Number, default: 0 },  // BE_total - PE_total - LE_total
    netWithUncertainty:     { type: Number, default: 0 },  // (BE_total - PE_total - LE_total) after buffer%
    bufferPercent:          { type: Number, default: 0 },  // snapshot from Reduction.m3.buffer

    // 🔹 Project-level cumulative totals
    cumulativeBE: { type: Number, default: 0 },
    cumulativePE: { type: Number, default: 0 },
    cumulativeLE: { type: Number, default: 0 },
    cumulativeNetWithoutUncertainty: { type: Number, default: 0 },
    cumulativeNetWithUncertainty: { type: Number, default: 0 },

    // 🔹 Per-item breakdown with per-item cumulativeValue
    breakdown: {
      baseline: [{
        id:        { type: String },
        label:     { type: String },
        value:     { type: Number, default: 0 },  // evaluated result for Bi in THIS entry
        variables: { type: mongoose.Schema.Types.Mixed, default: {} }, // bag used (A, EF, etc.)
        // ✅ cumulative value of this Bi across all entries up to this one
        cumulativeValue: { type: Number, default: 0 }
      }],
      project: [{
        id:        { type: String },
        label:     { type: String },
        value:     { type: Number, default: 0 },
        variables: { type: mongoose.Schema.Types.Mixed, default: {} },
        cumulativeValue: { type: Number, default: 0 }
      }],
      leakage: [{
        id:        { type: String },
        label:     { type: String },
        value:     { type: Number, default: 0 },
        variables: { type: mongoose.Schema.Types.Mixed, default: {} },
        cumulativeValue: { type: Number, default: 0 }
      }]
    }
  }
});


NetReductionEntrySchema.pre('save', async function(next) {
  try {
    // M1 → compute from inputValue * rate (unchanged behavior)
    // M2 → controller provides netReduction; don't overwrite here
    if (this.calculationMethodology === 'methodology1') {
  // M1 → compute from inputValue * rate (unchanged behavior)
  this.netReduction = round6((this.inputValue || 0) * (this.emissionReductionRate || 0));
} else if (
  this.calculationMethodology === 'methodology2' || 
  this.calculationMethodology === 'methodology3'
) {
  // M2 & M3 → controller computes netReduction; we only normalize/round here
  this.netReduction = round6(Number(this.netReduction || 0));
}

    // Find the latest earlier entry for same project/methodology
    const prev = await this.constructor.findOne({
      clientId: this.clientId,
      projectId: this.projectId,
      calculationMethodology: this.calculationMethodology,
      _id: { $ne: this._id },
      timestamp: { $lt: this.timestamp }
    })
      .sort({ timestamp: -1 })
      .select('cumulativeNetReduction highNetReduction lowNetReduction');

    // Cumulative & min/max tracking
    if (prev) {
      this.cumulativeNetReduction = round6((prev.cumulativeNetReduction || 0) + (this.netReduction || 0));
      this.highNetReduction = Math.max(prev.highNetReduction ?? this.netReduction, this.netReduction);
      this.lowNetReduction  = Math.min(
        (typeof prev.lowNetReduction === 'number' ? prev.lowNetReduction : this.netReduction),
        this.netReduction
      );
    } else {
      this.cumulativeNetReduction = round6(this.netReduction || 0);
      this.highNetReduction = this.netReduction || 0;
      this.lowNetReduction  = this.netReduction || 0;
    }

    next();
  } catch (err) {
    next(err);
  }
});
module.exports = mongoose.model('NetReductionEntry', NetReductionEntrySchema);
