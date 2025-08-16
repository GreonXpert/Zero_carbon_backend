// models/NetReductionEntry.js
const mongoose = require('mongoose');
const moment = require('moment');

const NetReductionEntrySchema = new mongoose.Schema({
  // Keys
  clientId:        { type: String, required: true, index: true },
  projectId:       { type: String, required: true, index: true },
  calculationMethodology: { type: String, enum: ['methodology1','methodology2'], required: true },

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
  inputValue:              { type: Number, required: true },  // for M1; M2 controllers can leave this 0
  emissionReductionRate:   { type: Number, required: true },  // for M1; M2 controllers can leave this 0
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
  netReductionInFormula:{ type: Number, default: 0 }                         // result before subtracting LE
});

NetReductionEntrySchema.pre('save', async function(next) {
  try {
    // M1 → compute from inputValue * rate (unchanged behavior)
    // M2 → controller provides netReduction; don't overwrite here
    if (this.calculationMethodology === 'methodology1') {
      this.netReduction = round6((this.inputValue || 0) * (this.emissionReductionRate || 0));
    } else if (this.calculationMethodology === 'methodology2') {
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
