// models/Organization/ProcessEmissionDataEntry.js
// ─────────────────────────────────────────────────────────────────────────────
// This model mirrors DataEntry but is scoped to ProcessFlowchart nodes.
// When a DataEntry is saved and emission calculation completes, the system
// finds every ProcessFlowchart node that shares the same (clientId, scopeIdentifier)
// and creates one ProcessEmissionDataEntry per node, applying that node's
// allocationPct to scale the calculatedEmissions down.
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require('mongoose');

// ── Sub-schema: a single gas-level result (CO2, CH4, N2O, CO2e, …)
const GasValuesSchema = new mongoose.Schema(
  {
    CO2:                    { type: Number, default: 0 },
    CH4:                    { type: Number, default: 0 },
    N2O:                    { type: Number, default: 0 },
    CO2e:                   { type: Number, default: 0 },
    emission:               { type: Number, default: 0 }, // process emissions
    combinedUncertainty:    { type: Number, default: 0 },
    CO2eWithUncertainty:    { type: Number, default: 0 },
    emissionWithUncertainty:{ type: Number, default: 0 }
  },
  { _id: false }
);

// ── Sub-schema: one "bucket" (incoming OR cumulative) after allocation
//    Each bucket key is the scope activity / gas key from the original DataEntry.
//    We also store the allocationPct used so it is auditable at the record level.
const AllocatedBucketSchema = new mongoose.Schema(
  {
    // ── The allocation percentage that was applied to produce these values
    allocationPct: { type: Number, required: true, min: 0, max: 100 },

    // ── The raw (pre-allocation) values from the source DataEntry
    original: {
      type: Map,
      of: GasValuesSchema,
      default: () => new Map()
    },

    // ── The allocated values  =  original × (allocationPct / 100)
    allocated: {
      type: Map,
      of: GasValuesSchema,
      default: () => new Map()
    }
  },
  { _id: false }
);

// ── Main schema
const ProcessEmissionDataEntrySchema = new mongoose.Schema(
  {
    // ── Core identifiers (same as DataEntry) ────────────────────────────────
    clientId: { type: String, required: true, index: true },

    // The ProcessFlowchart node this record belongs to
    nodeId:   { type: String, required: true, index: true },

    // The original DataEntry that triggered this record
    sourceDataEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DataEntry',
      required: true,
      index: true
    },

    // ── Scope info ───────────────────────────────────────────────────────────
    scopeIdentifier: { type: String, required: true, index: true },
    scopeType: {
      type: String,
      required: true,
      enum: ['Scope 1', 'Scope 2', 'Scope 3']
    },
    inputType: {
      type: String,
      required: true,
      enum: ['manual', 'API', 'IOT']
    },

    // ── Timestamp mirrors the original DataEntry ─────────────────────────────
    date:      { type: String },   // "DD:MM:YYYY"
    time:      { type: String },   // "HH:mm:ss"
    timestamp: { type: Date, required: true, index: true },

    // ── Raw data values (copied from DataEntry for reference) ────────────────
    dataValues: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: () => new Map()
    },

    // ── Cumulative tracking (copied from DataEntry) ──────────────────────────
    dataEntryCumulative: {
      incomingTotalValue:  { type: Number, default: 0 },
      cumulativeTotalValue:{ type: Number, default: 0 },
      entryCount:          { type: Number, default: 0 },
      lastUpdatedAt:       { type: Date }
    },
    cumulativeValues: { type: Map, of: Number, default: () => new Map() },
    highData:         { type: Map, of: Number, default: () => new Map() },
    lowData:          { type: Map, of: Number, default: () => new Map() },
    lastEnteredData:  { type: Map, of: Number, default: () => new Map() },

    // ── Emission factor used for the original calculation ────────────────────
    emissionFactor: {
      type: String,
      enum: ['IPCC', 'DEFRA', 'EPA', 'Custom', 'Country', 'EmissionFactorHub', ''],
      default: ''
    },
    nodeType: {
      type: String,
      enum: ['Emission Source', 'Reduction'],
      default: 'Emission Source'
    },

    // ── Source details (who / what produced the original entry) ─────────────
    sourceDetails: {
      uploadedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      apiEndpoint: { type: String },
      iotDeviceId: { type: String },
      fileName:    { type: String },
      dataSource:  { type: String },
      requestId:   { type: String },
      batchId:     { type: String }
    },

    // ── Emission calculation status (mirrors DataEntry) ──────────────────────
    emissionCalculationStatus: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed', 'error'],
      default: 'pending'
    },

    // ── THE CORE NEW FIELD ───────────────────────────────────────────────────
    // calculatedEmissions stores:
    //   incoming  → allocated values for THIS data-entry period
    //   cumulative→ running total allocated values
    //
    // Inside each bucket we keep:
    //   allocationPct  : the percentage used
    //   original       : raw values from the source DataEntry
    //   allocated      : original × (allocationPct / 100)
    calculatedEmissions: {
      incoming:   { type: AllocatedBucketSchema, default: () => ({}) },
      cumulative: { type: AllocatedBucketSchema, default: () => ({}) },

      // Mirrors DataEntry metadata
      metadata: {
        scopeType:           String,
        category:            String,
        tier:                String,
        emissionFactorSource:String,
        UAD:                 Number,
        UEF:                 Number,
        gwpValues: {
          CO2:         Number,
          CH4:         Number,
          N2O:         Number,
          refrigerant: Number
        }
      }
    }
  },
  { timestamps: true }
);

// ── Compound indexes for efficient lookups ───────────────────────────────────
ProcessEmissionDataEntrySchema.index({ clientId: 1, nodeId: 1, scopeIdentifier: 1, timestamp: -1 });
ProcessEmissionDataEntrySchema.index({ clientId: 1, scopeIdentifier: 1, timestamp: -1 });
ProcessEmissionDataEntrySchema.index({ sourceDataEntryId: 1 });

module.exports = mongoose.model('ProcessEmissionDataEntry', ProcessEmissionDataEntrySchema);