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
    // Totals (without and with buffer / "uncertainty")
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
    // 🔹 SKIP RECALCULATION FLAG - used when recalculating historical entries
    // to prevent infinite loops
    if (this._skipRecalculation) {
      delete this._skipRecalculation;
      return next();
    }
    
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
      .select('cumulativeNetReduction highNetReduction lowNetReduction m3');

    // Cumulative & min/max tracking
    if (prev) {
      this.cumulativeNetReduction = round6((prev.cumulativeNetReduction || 0) + (this.netReduction || 0));
      this.highNetReduction = Math.max(prev.highNetReduction ?? this.netReduction, this.netReduction);
      this.lowNetReduction  = Math.min(
        (typeof prev.lowNetReduction === 'number' ? prev.lowNetReduction : this.netReduction),
        this.netReduction
      );
      
      // 🔹 For Methodology 3, calculate cumulative M3 values
      if (this.calculationMethodology === 'methodology3' && this.m3 && prev.m3) {
        this.m3.cumulativeBE = round6((prev.m3.cumulativeBE || 0) + (this.m3.BE_total || 0));
        this.m3.cumulativePE = round6((prev.m3.cumulativePE || 0) + (this.m3.PE_total || 0));
        this.m3.cumulativeLE = round6((prev.m3.cumulativeLE || 0) + (this.m3.LE_total || 0));
        this.m3.cumulativeNetWithoutUncertainty = round6(
          (prev.m3.cumulativeNetWithoutUncertainty || 0) + (this.m3.netWithoutUncertainty || 0)
        );
        this.m3.cumulativeNetWithUncertainty = round6(
          (prev.m3.cumulativeNetWithUncertainty || 0) + (this.m3.netWithUncertainty || 0)
        );
        
        // Calculate per-item cumulative values
        if (this.m3.breakdown) {
          // Baseline items
          if (this.m3.breakdown.baseline && Array.isArray(this.m3.breakdown.baseline)) {
            for (const item of this.m3.breakdown.baseline) {
              const prevItem = prev.m3.breakdown?.baseline?.find(b => b.id === item.id);
              item.cumulativeValue = round6(
                (prevItem?.cumulativeValue || 0) + (item.value || 0)
              );
            }
          }
          
          // Project items
          if (this.m3.breakdown.project && Array.isArray(this.m3.breakdown.project)) {
            for (const item of this.m3.breakdown.project) {
              const prevItem = prev.m3.breakdown?.project?.find(p => p.id === item.id);
              item.cumulativeValue = round6(
                (prevItem?.cumulativeValue || 0) + (item.value || 0)
              );
            }
          }
          
          // Leakage items
          if (this.m3.breakdown.leakage && Array.isArray(this.m3.breakdown.leakage)) {
            for (const item of this.m3.breakdown.leakage) {
              const prevItem = prev.m3.breakdown?.leakage?.find(l => l.id === item.id);
              item.cumulativeValue = round6(
                (prevItem?.cumulativeValue || 0) + (item.value || 0)
              );
            }
          }
        }
      }
    } else {
      this.cumulativeNetReduction = round6(this.netReduction || 0);
      this.highNetReduction = this.netReduction || 0;
      this.lowNetReduction  = this.netReduction || 0;
      
      // For M3 without previous entry, cumulative = current values
      if (this.calculationMethodology === 'methodology3' && this.m3) {
        this.m3.cumulativeBE = this.m3.BE_total || 0;
        this.m3.cumulativePE = this.m3.PE_total || 0;
        this.m3.cumulativeLE = this.m3.LE_total || 0;
        this.m3.cumulativeNetWithoutUncertainty = this.m3.netWithoutUncertainty || 0;
        this.m3.cumulativeNetWithUncertainty = this.m3.netWithUncertainty || 0;
        
        // Set per-item cumulative values equal to current values
        if (this.m3.breakdown) {
          if (this.m3.breakdown.baseline) {
            for (const item of this.m3.breakdown.baseline) {
              item.cumulativeValue = item.value || 0;
            }
          }
          if (this.m3.breakdown.project) {
            for (const item of this.m3.breakdown.project) {
              item.cumulativeValue = item.value || 0;
            }
          }
          if (this.m3.breakdown.leakage) {
            for (const item of this.m3.breakdown.leakage) {
              item.cumulativeValue = item.value || 0;
            }
          }
        }
      }
    }

    next();
  } catch (err) {
    next(err);
  }
});

async function recalculateNetReductionEntriesAfter(seedDoc) {
  const Model = seedDoc.constructor; // NetReductionEntry model

  const laterEntries = await Model.find({
    clientId: seedDoc.clientId,
    projectId: seedDoc.projectId,
    calculationMethodology: seedDoc.calculationMethodology,
    timestamp: { $gt: seedDoc.timestamp },
    _id: { $ne: seedDoc._id }
  }).sort({ timestamp: 1 });

  for (const e of laterEntries) {
    e._isRecalculating = true;   // prevents post-save loop
    await e.save();              // runs pre-save and rebuilds cumulative values
  }
}


// 🔹 POST-SAVE HOOK - Trigger recalculation of later entries when a historical entry is inserted
NetReductionEntrySchema.post('save', async function(doc) {
  try {
    // Skip if this is part of a recalculation process
    if (doc._skipRecalculation || doc._isRecalculating) {
      return;
    }
    
    // Check if there are any entries after this timestamp that need recalculation
    const laterEntriesCount = await this.constructor.countDocuments({
      clientId: doc.clientId,
      projectId: doc.projectId,
      calculationMethodology: doc.calculationMethodology,
      timestamp: { $gt: doc.timestamp },
      _id: { $ne: doc._id }
    });
    
    if (laterEntriesCount > 0) {
      console.log(`🔄 Found ${laterEntriesCount} entries after this timestamp. Triggering recalculation...`);
      
      // Import the recalculation helper
      const { recalculateDataEntriesAfter } = require('../../utils/Calculation/recalculateHelpers');
      
      // Trigger recalculation in background (don't await to avoid blocking)
      setImmediate(async () => {
        try {
          await recalculateNetReductionEntriesAfter(doc);
          
          // 🔹 After recalculation, trigger summary updates
          console.log(`📊 Triggering summary recalculation for client: ${doc.clientId}`);
          try {
            const { recomputeClientNetReductionSummary } = require('../../controllers/Reduction/netReductionSummaryController');
            await recomputeClientNetReductionSummary(doc.clientId);
            console.log(`📊 ✅ Summary recalculation completed`);
          } catch (summaryError) {
            console.error(`📊 ❌ Error recalculating summary:`, summaryError);
          }
        } catch (recalcError) {
          console.error('❌ Error in post-save recalculation:', recalcError);
        }
      });
    } else {
      // No later entries, but still trigger summary update for this period
      console.log(`📊 No later entries. Triggering summary update for client: ${doc.clientId}`);
      setImmediate(async () => {
        try {
          const { recomputeClientNetReductionSummary } = require('../../controllers/Reduction/netReductionSummaryController');
          await recomputeClientNetReductionSummary(doc.clientId);
          console.log(`📊 ✅ Summary update completed`);
        } catch (summaryError) {
          console.error(`📊 ❌ Error updating summary:`, summaryError);
        }
      });
    }
  } catch (error) {
    console.error('❌ Error in NetReductionEntry post-save hook:', error);
    // Don't throw - we don't want to break the save operation
  }
});

module.exports = mongoose.model('NetReductionEntry', NetReductionEntrySchema);