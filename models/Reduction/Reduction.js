// models/Reduction.js
const mongoose = require('mongoose');
const { Schema } = mongoose; // ✅ FIX: needed for Schema.Types.ObjectId and nested Schema uses

// === ProcessFlow Snapshot (OPTIONAL) ===

const SnapshotNodeSchema = new Schema({
  id: { type: String, required: true },
  label: { type: String, default: '' },
  position: {
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 }
  },
  parentNode: { type: String, default: null },

  // Keep any structure you already use in Flowchart nodes
  details: { type: Schema.Types.Mixed, default: {} },

  // Arbitrary key/value pairs decided by the user at creation time (optional)
  kv: { type: Map, of: Schema.Types.Mixed, default: undefined }
}, { _id: false });

const SnapshotEdgeSchema = new Schema({
  id: { type: String, required: true },
  source: { type: String, required: true },
  target: { type: String, required: true },

  // Arbitrary key/value pairs on the edge (optional)
  kv: { type: Map, of: Schema.Types.Mixed, default: undefined }
}, { _id: false });

const ProcessFlowSnapshotSchema = new Schema({
  nodes: { type: [SnapshotNodeSchema], default: undefined },  // entirely optional
  edges: { type: [SnapshotEdgeSchema], default: undefined },  // entirely optional
  metadata: {
    title: { type: String, default: '' },
    description: { type: String, default: '' },
    version: { type: Number, default: 1 }
  }
}, { _id: false });



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
  uncertainty: { type: Number, default: 0 },     // percent; 5 = 5%
  remark : { type:String, default:''} //Remark
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
        // NEW: declare each symbol’s role at Reduction level
    // allowed: 'frozen' | 'realtime' | 'manual'
    variableKinds: {
      type: Map,
      of: { type: String, enum: ['frozen','realtime','manual'] },
      default: undefined
    },
    remark: { type: String, default: '' },

    // frozen variables current values (and optional policy info)
   variables: { 
  type: Map,
  of: new Schema({
    // base value (used if constant, or as initial carry-forward)
    value:        { type: Number, default: null },
    updatePolicy: { type: String, enum: ['manual','annual_automatic'], default: 'manual' },
    lastUpdatedAt:{ type: Date },

    // NEW: per-variable policy for “frozen”
    policy: {
      isConstant: { type: Boolean, default: true }, // true = constant; false = periodically changing
      schedule: {
        frequency: { type: String, enum: ['monthly','quarterly','semiannual','yearly'], default: 'monthly' },
        fromDate:  { type: Date },   // optional window start
        toDate:    { type: Date }    // optional window end
      }
    },

    // NEW: periodic value history (carry-forward if no exact period match)
    // You can populate this during updates when a period changes.
    history: [{
      value:     { type: Number, required: true },
      from:      { type: Date,   required: true },   // inclusive
      to:        { type: Date },                     // optional; if missing, applies until next period/change
      updatedAt: { type: Date,   default: Date.now }
    }],
      remark: { type: String, default: '' }
  }, { _id: false })
}
  }
}, { _id: false });


/**
 * Variable for a B/P/L item in Methodology 3
 * - name: symbol used in the formula (must match ReductionFormula.variables.name)
 * - type: 'constant' (value saved now) or 'manual' (value provided later in NetReductionEntry)
 * - value: only required when type === 'constant'
 */
const M3VariableSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,           // variable name is mandatory
    trim: true
  },
 type: {
  type: String,
  enum: ["manual", "constant", "internal"],
  default: "manual"
},

  value: {
    type: Number,
    default: null             // only used when type === 'constant'
  },
  unit:{
    type: String,
    default:null
  },
    remark: { type: String, default: '' },
  Reference: { type: String, default: '' },
  internalSources: {
  type: [String],     // store ["B1", "B3", "P1"]
  default: []
},

// auto-filled during evaluation
computedInternalValue: {
  type: Number,
  default: null
},

   // 🔥 NEW — Same as M2
      updatePolicy: { type: String, enum: ["manual", "annual_automatic"], default: "manual" },
      defaultValue: { type: Number, default: null },
      lastValue:    { type: Number, default: null },
      lastUpdatedAt:{ type: Date },

      policy: {
        isConstant: { type: Boolean, default: true },
        schedule: {
          frequency: { type: String, enum: ["none", "monthly", "quarterly", "yearly"], default: "none" },
          fromDate:  { type: Date, default: null },
          toDate:    { type: Date, default: null }
        },
        history: [
          {
            oldValue:   Number,
            newValue:   Number,
            updatedAt:  { type: Date, default: Date.now }
          }
        ],
      }

}, { _id: false });

/**
 * Single Baseline/Project/Leakage item (B1, B2, P1, L1, etc.)
 */
const M3ItemSchema = new mongoose.Schema({
  // e.g. "B1", "P3", "L2"
  id: {
    type: String,
    required: true,
    trim: true
  },

  // Human friendly label shown in UI
  label: {
    type: String,
    required: true,
    trim: true
  },

  /**
   * The formula used to compute this item's emission.
   *
   * We store:
   *   - formulaId: reference to ReductionFormula document
   *   - formulaExpression: optional snapshot of expression string
   *
   * NOTE: We will later use formulaId + variables inside NetReductionEntry
   * to actually evaluate the math.
   */
  formulaId: {
    type: Schema.Types.ObjectId,
    ref: 'ReductionFormula',
    required: true
  },

  // Optional: store expression snapshot for easier debugging / UI
  formulaExpression: {
    type: String,
    default: ''
  },

  // Per-variable configuration for this item
  variables: {
    type: [M3VariableSchema],
    default: []
  },
    ssrType: { type: String, enum: ['Sink','Source','Reservoir'], required: true },
  remark: { type: String, default: '' },

}, { _id: false });

/**
 * Main Methodology 3 sub-schema
 */
const Methodology3Schema = new mongoose.Schema({
  /**
   * Project Activity
   *  - "Reduction"  → buffer can be 0
   *  - "Removal"    → buffer MUST be provided by controller validation
   */
  projectActivity: {
    type: String,
    enum: ['Reduction', 'Removal'],
    required: true
  },

  /**
   * Buffer percentage (e.g. 10 = 10%)
   * Controller will enforce: if projectActivity === 'Removal'
   * then this must be > 0 (or at least provided).
   */
  buffer: {
    type: Number,
    default: 0
  },

  // Arrays of B, P, L items
  baselineEmissions: {
    type: [M3ItemSchema],
    default: []
  },

  projectEmissions: {
    type: [M3ItemSchema],
    default: []
  },

  leakageEmissions: {
    type: [M3ItemSchema],
    default: []
  }
}, {
  _id: false,
  timestamps: false
});

// ===============================================================================
// CHANGES TO Reduction.js MODEL
// ===============================================================================
// 
// Add this to the ReductionEntrySchema (around line 277)
// Replace lines 277-295 with this updated schema:
// ===============================================================================

const ReductionEntrySchema = new mongoose.Schema({
  // normalized type stored in the document
  inputType: { type: String, enum: ['manual', 'API', 'IOT'], default: 'manual' },

  // what the user originally sent; CSV is allowed here but we normalize to manual
  originalInputType: {
    type: String,
    enum: ['manual', 'API', 'IOT', 'CSV'],
    default: 'manual'
  },

  // Connection info (never deleted by disconnect)
  apiEndpoint: { type: String, default: '' },   // used when inputType === 'API'
  iotDeviceId: { type: String, default: '' },   // used when inputType === 'IOT'

  // NEW: connection status flags (true = connected, false = disconnected)
  apiStatus: { type: Boolean, default: true },  // relevant for API
  iotStatus: { type: Boolean, default: true },  // relevant for IOT

  // ✅ NEW: API Key Request Tracking
  apiKeyRequest: {
    status: {
      type: String,
      enum: ['none', 'pending', 'approved', 'rejected'],
      default: 'none',
      description: 'Current status of API key request'
    },
    requestedInputType: {
      type: String,
      enum: ['API', 'IOT'],
      default: null,
      description: 'The input type that was requested (API or IOT)'
    },
    requestedAt: {
      type: Date,
      default: null,
      description: 'When the API key was requested'
    },
    approvedAt: {
      type: Date,
      default: null,
      description: 'When the API key request was approved'
    },
    rejectedAt: {
      type: Date,
      default: null,
      description: 'When the API key request was rejected'
    },
    apiKeyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ApiKey',
      default: null,
      description: 'Reference to the approved API key'
    },
    requestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ApiKeyRequest',
      default: null,
      description: 'Reference to the ApiKeyRequest document'
    }
  }
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
  projectActivity: { type: String, enum: ['Reduction','Removal'], required: true },
  
  // Project status for workflow tracking
  status: {
    type: String,
    enum: ['not_started', 'on_going', 'pending', 'completed'],
    default: 'not_started'
  },
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

  // --- Media (optional) ---
    coverImage: {
      filename:   { type: String, default: '' },       // e.g. RED-Greon001-0001.jpg
      path:       { type: String, default: '' },       // filesystem path (server)
      url:        { type: String, default: '' },       // public url (served from /uploads)
      uploadedAt: { type: Date }
    },
    images: [{
      filename:   { type: String, default: '' },       // e.g. RED-Greon001-0001-1.jpg
      path:       { type: String, default: '' },
      url:        { type: String, default: '' },
      uploadedAt: { type: Date }
    }],


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
  calculationMethodology: { 
    type: String, 
    enum: ['methodology1', 'methodology2', 'methodology3'], 
    required: true 
  },



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

   // Methodology 3 configuration (B/P/L + buffer + formula/variables)
  m3: { type: Methodology3Schema, default: undefined }, // only when methodology3

  // === processFlow (ENTIRELY OPTIONAL) ===
    processFlow: {
      mode: { type: String, enum: ['snapshot', 'reference', 'both'], default: 'snapshot' },

      // Optional reference to an existing Flowchart document
      flowchartId: { type: Schema.Types.ObjectId, ref: 'Flowchart', default: null },

      // Optional embedded snapshot frozen at creation/update time
      snapshot: { type: ProcessFlowSnapshotSchema, default: undefined },

      snapshotCreatedAt: { type: Date },
      snapshotCreatedBy: { type: Schema.Types.ObjectId, ref: 'User' },

      // Optional mapping scaffolds if you want to bind ABD/APD/ALD later
      mapping: {
        ABD: [{ nodeId: String, field: String }],
        APD: [{ nodeId: String, field: String }],
        ALD: [{ nodeId: String, field: String }]
      }
    },


  reductionDataEntry: { type: ReductionEntrySchema, default: () => ({ inputType:'manual', originalInputType:'manual' }) },

  assignedTeam: {
  employeeHeadId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  employeeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', default: undefined }],
  history: [{
    action: { type: String, enum: ['assign_head','change_head','assign_employees','unassign_employees'], required: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
    details: { type: mongoose.Schema.Types.Mixed, default: {} }
  }]
},
  

  // Soft delete / meta
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date },
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });


reductionSchema.index({ clientId: 1, "assignedTeam.employeeHeadId": 1 });
reductionSchema.index({ clientId: 1, "assignedTeam.employeeIds": 1 });


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

function validateProcessFlowSnapshot(pf) {
  if (!pf || !pf.snapshot) return;
  const snap = pf.snapshot;
  if (!Array.isArray(snap.nodes) || !Array.isArray(snap.edges)) return; // nothing to validate

  const ids = new Set(snap.nodes.map(n => String(n.id || '').trim()).filter(Boolean));
  // unique node ids
  if (ids.size !== (snap.nodes || []).length) {
    throw new Error('processFlow.snapshot.nodes must have unique, non-empty ids');
  }
  // edges must reference existing nodes
  for (const e of (snap.edges || [])) {
    const s = String(e.source || '').trim();
    const t = String(e.target || '').trim();
    if (!ids.has(s) || !ids.has(t)) {
      throw new Error(`processFlow edge "${e.id}" references unknown node(s)`);
    }
  }
}

function buildAutoEndpoint(base, clientId, projectId, methodology, ioKind) {
  const host = (base || process.env.SERVER_BASE_URL || process.env.BASE_URL || 'http://localhost:5000').replace(/\/+$/,'');
  const meth = String(methodology || '').toLowerCase();
  const last = String(ioKind || '').toUpperCase() === 'IOT' ? 'iot' : 'api';
  return `${host}/api/net-reduction/${clientId}/${projectId}/${meth}/${last}`;
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

if (this.reductionDataEntry) {
  const r = this.reductionDataEntry;
  
  // ✅ Initialize apiKeyRequest if it doesn't exist (backward compatibility)
  if (!r.apiKeyRequest) {
    r.apiKeyRequest = {
      status: 'none',
      requestedInputType: null,
      requestedAt: null,
      approvedAt: null,
      rejectedAt: null,
      apiKeyId: null,
      requestId: null
    };
  }
  
  // ✅ FIX: If inputType is already API/IOT AND status is approved, respect it
  // This prevents the hook from overwriting approved API/IOT connections
  if (['API', 'IOT'].includes(r.inputType) && r.apiKeyRequest.status === 'approved') {
    // Keep existing values, just ensure status flags match
    if (typeof r.apiStatus !== 'boolean') r.apiStatus = r.inputType === 'API';
    if (typeof r.iotStatus !== 'boolean') r.iotStatus = r.inputType === 'IOT';
    
    // Don't overwrite the endpoint if it has an API key
    const hasApiKey = r.apiEndpoint && r.apiEndpoint.length > 50;
    if (hasApiKey) {
      // Keep the existing endpoint with the key
      // Skip the auto-generation below
    } else if (this.clientId && this.projectId) {
      // Only generate if no endpoint exists
      const ioKind = r.inputType;
      const meth = this.calculationMethodology || 'methodology1';
      r.apiEndpoint = buildAutoEndpoint(
        process.env.SERVER_BASE_URL,
        this.clientId,
        this.projectId,
        meth,
        ioKind
      );
    }
  }
  // ✅ If request is pending, keep current state (don't change inputType)
  else if (r.apiKeyRequest.status === 'pending') {
    // Keep inputType as is (probably still 'manual')
    // The requestedInputType field shows what they want
    // Status flags should reflect current (not requested) state
    if (r.inputType === 'manual') {
      r.apiStatus = false;
      r.iotStatus = false;
    }
  }
  // ✅ Normal processing for non-API/IOT or when not approved
  else {
    const rawType = (r.originalInputType || r.inputType || 'manual').toString().toLowerCase();

    // Make sure status flags exist (for old documents)
    if (typeof r.apiStatus !== 'boolean') r.apiStatus = true;
    if (typeof r.iotStatus !== 'boolean') r.iotStatus = true;

    if (rawType === 'csv') {
      r.originalInputType = 'CSV';
      r.inputType = 'manual';
      r.apiEndpoint = '';
      r.iotDeviceId = '';
      r.apiStatus = false;
      r.iotStatus = false;
    } else if (rawType === 'api') {
      r.originalInputType = 'API';
      r.inputType = 'API';
      r.iotDeviceId = '';
      if (typeof r.apiStatus !== 'boolean') r.apiStatus = true;
      r.iotStatus = false;
    } else if (rawType === 'iot') {
      r.originalInputType = 'IOT';
      r.inputType = 'IOT';
      r.apiEndpoint = '';
      if (typeof r.iotStatus !== 'boolean') r.iotStatus = true;
      r.apiStatus = false;
    } else {
      r.originalInputType = 'manual';
      r.inputType = 'manual';
      r.apiEndpoint = '';
      r.iotDeviceId = '';
      r.apiStatus = false;
      r.iotStatus = false;
    }

    // Auto-compose endpoint when API/IOT (if not already set with key)
    if (['API', 'IOT'].includes(r.inputType) && this.clientId && this.projectId) {
      const hasApiKey = r.apiEndpoint && r.apiEndpoint.length > 50;
      
      if (!r.apiEndpoint || !hasApiKey) {
        const ioKind = r.inputType;
        const meth = this.calculationMethodology || 'methodology1';
        r.apiEndpoint = buildAutoEndpoint(
          process.env.SERVER_BASE_URL,
          this.clientId,
          this.projectId,
          meth,
          ioKind
        );
      }
    }
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
            // --- M2 variable role validation ---
    if (this.calculationMethodology === 'methodology2' && this.m2?.formulaRef?.formulaId) {
      const Formula = mongoose.model('ReductionFormula');
      const f = await Formula.findById(this.m2.formulaRef.formulaId).lean();
      if (!f || f.isDeleted) throw new Error('Formula not found for this reduction');

      const kinds = this.m2.formulaRef.variableKinds || new Map();
      const frozenVals = this.m2.formulaRef.variables || new Map();

      // Every formula symbol must have a role
      for (const v of (f.variables || [])) {
        const name = v.name;
        const role = kinds.get ? kinds.get(name) : kinds[name];
        if (!role) {
          throw new Error(`m2.formulaRef.variableKinds is missing a role for '${name}'`);
        }
        if (!['frozen','realtime','manual'].includes(role)) {
          throw new Error(`Invalid role '${role}' for '${name}' (use frozen|realtime|manual)`);
        }
        if (role === 'frozen') {
          const fv = frozenVals.get ? frozenVals.get(name) : frozenVals[name];
          const val = fv && typeof fv.value === 'number' ? fv.value : null;
          if (val == null || !isFinite(val)) {
            throw new Error(`Frozen variable '${name}' must have a numeric value in m2.formulaRef.variables`);
          }
        }
      }
    }
    if (this.processFlow) {
      validateProcessFlowSnapshot(this.processFlow);
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
