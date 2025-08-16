// models/Reduction/SummaryNetReduction.js
const mongoose = require('mongoose');

const ByProjectSchema = new mongoose.Schema({
  projectId: { type: String, required: true, index: true },
  reductionId: { type: String, default: '' },
  projectName: { type: String, default: '' },
  calculationMethodology: { type: String, enum: ['methodology1','methodology2'] },
  scope: { type: String, default: '' },
  category: { type: String, default: '' },
  locationPlace: { type: String, default: '' },
  inputType: { type: String, enum: ['manual','API','IOT'], default: 'manual' },

  stats: {
    entries: { type: Number, default: 0 },
    totalNet: { type: Number, default: 0 },          // sum of netReduction for this project
    firstDate: { type: Date },
    lastDate: { type: Date },
    latestCumulative: { type: Number, default: 0 },  // last entry's cumulativeNetReduction
    high: { type: Number, default: 0 },              // highest single entry
    low:  { type: Number, default: 0 }               // lowest single entry
  },

  // quick trend windows (IST date buckets)
  last7DaysTotal:  { type: Number, default: 0 },
  last30DaysTotal: { type: Number, default: 0 },

  // optional lightweight daily series (most recent 30 days)
  timeseries: [{
    day: { type: String },                 // 'DD/MM/YYYY'
    dayStart: { type: Date },              // ISO day start (for sorting)
    dayTotal: { type: Number, default: 0 } // sum of that day
  }]
}, { _id: false });

const GroupTotalSchema = new mongoose.Schema({
  key: { type: String, index: true },     // scope/category/place value
  projects: { type: Number, default: 0 },
  totalNet: { type: Number, default: 0 }
}, { _id: false });

const SummaryNetReductionSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },

  totals: {
    projects: { type: Number, default: 0 },
    entries:  { type: Number, default: 0 },
    totalNetReduction: { type: Number, default: 0 },
    avgPerProject: { type: Number, default: 0 }
  },

  byProject: [ByProjectSchema],

  // rollups
  byScope:    [GroupTotalSchema],
  byCategory: [GroupTotalSchema],
  byLocation: [GroupTotalSchema], // uses location.place

  // metadata
  lastComputedAt: { type: Date, default: Date.now }
}, {
  timestamps: true,
  collection: 'summary_net_reduction'
});

SummaryNetReductionSchema.index({ clientId: 1 }, { unique: true });

module.exports = mongoose.model('SummaryNetReduction', SummaryNetReductionSchema);
