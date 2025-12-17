  // controllers/netReductionController.js
  const moment = require('moment');
  const csvtojson = require('csvtojson');
  const NetReductionEntry = require('../../models/Reduction/NetReductionEntry');
  const Reduction = require('../../models/Reduction/Reduction');
  const ReductionFormula = require('../../models/Reduction/Formula');
  const { Parser } = require('expr-eval'); 
  const Client = require('../../models/Client');
  const User = require('../../models/User');

// controllers/Reduction/netReductionController.js
const { recomputeClientNetReductionSummary } = require('./netReductionSummaryController');

const fs = require('fs');
const { uploadReductionCSVCreate } = require('../../utils/uploads/Reduction/csv/create');


// --- Socket wiring (copy the pattern from dataCollectionController) ---
let io;
exports.setSocketIO = (socketIO) => { io = socketIO; };

function round6(n){ return Math.round((Number(n)||0)*1e6)/1e6; }

// Emit to both room styles to be backward/forward compatible
function emitNR(eventType, payload) {
  if (!io || !payload?.clientId) return;
  const p = { eventType, timestamp: new Date().toISOString(), ...payload };

  // underscore room (current join code)
  io.to(`client_${payload.clientId}`).emit(eventType, p);
  // hyphen room (legacy)
  io.to(`client-${payload.clientId}`).emit(eventType, p);
}

  // --- permissions: only creator consultant_admin OR assigned consultant can write ---

  async function canWriteReductionData(user, clientId) {
    if (!user) return { ok:false, reason:'Unauthenticated' };

    // 1) Client-side users from the same client can enter data
    // (restrict to roles allowed to write; exclude viewer/auditor)
    const clientWriteRoles = ['client_admin', 'client_employee_head', 'employee'];
    if (clientWriteRoles.includes(user.userType) && user.clientId === clientId) {
      return { ok: true };
    }

    // 2) consultant_admin who created the lead
    if (user.userType === 'consultant_admin') {
      const client = await Client.findOne({ clientId })
        .select('leadInfo.createdBy');
      if (!client) return { ok:false, reason:'Client not found' };
      if (client.leadInfo?.createdBy?.toString() === (user._id || user.id).toString()) {
        return { ok: true };
      }
      return { ok:false, reason:'Only creator consultant_admin can write' };
    }

    // 3) consultant assigned to this client
    if (user.userType === 'consultant') {
      const client = await Client.findOne({ clientId })
        .select('leadInfo.assignedConsultantId');
      if (!client) return { ok:false, reason:'Client not found' };
      if (client.leadInfo?.assignedConsultantId?.toString() === (user._id || user.id).toString()) {
        return { ok: true };
      }
      return { ok:false, reason:'Consultant not assigned to this client' };
    }

    return { ok:false, reason:'Forbidden' };
  }

  function startOfPeriod(ts, frequency) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0..11
  if (frequency === 'monthly')   return new Date(Date.UTC(y, m, 1, 0,0,0,0));
  if (frequency === 'quarterly') return new Date(Date.UTC(y, Math.floor(m/3)*3, 1, 0,0,0,0));
  if (frequency === 'semiannual')return new Date(Date.UTC(y, (m < 6 ? 0 : 6), 1, 0,0,0,0));
  if (frequency === 'yearly')    return new Date(Date.UTC(y, 0, 1, 0,0,0,0));
  return new Date(Date.UTC(y, m, 1, 0,0,0,0)); // default monthly
}

function inRange(ts, from, to) {
  const t = +ts;
  const a = +new Date(from);
  const b = to ? +new Date(to) : Infinity;
  return t >= a && t <= b;
}

/**
 * Pick frozen var's value at timestamp ts.
 * - If policy.isConstant: return base value.
 * - Else: find matching history entry for the period; if none, carry-forward
 *   the latest past value; otherwise fall back to base value.
 */
function resolveFrozenVarValue(doc, varName, ts) {
  const fvMap = doc?.m2?.formulaRef?.variables;
  if (!fvMap) throw new Error(`Frozen variable map missing`);
  const fv = fvMap.get ? fvMap.get(varName) : fvMap[varName];
  if (!fv) throw new Error(`Frozen variable '${varName}' is not configured on this reduction`);

  const base = Number(fv.value ?? 0);
  const pol  = fv.policy || { isConstant: true, schedule: { frequency: 'monthly' } };

  // Constant → always base
  if (pol.isConstant !== false) return base;

  const freq = pol.schedule?.frequency || 'monthly';
  const sod  = startOfPeriod(ts, freq);
  const eod  = new Date(sod); // end = next period start - 1ms
  if (freq === 'monthly')    eod.setUTCMonth(eod.getUTCMonth()+1);
  else if (freq === 'quarterly') eod.setUTCMonth(eod.getUTCMonth()+3);
  else if (freq === 'semiannual')eod.setUTCMonth(eod.getUTCMonth()+6);
  else if (freq === 'yearly')    eod.setUTCFullYear(eod.getUTCFullYear()+1);
  eod.setUTCMilliseconds(eod.getUTCMilliseconds()-1);

  // Optional global bounds
  if (pol.schedule?.fromDate && ts < new Date(pol.schedule.fromDate)) {
    // before policy window → use base (or 0, but base is safer)
    return base;
  }
  if (pol.schedule?.toDate && ts > new Date(pol.schedule.toDate)) {
    // after policy window → carry-forward last known in-window if any, else base
    const last = (fv.history || [])
      .filter(h => h.from && new Date(h.from) <= pol.schedule.toDate)
      .sort((a,b) => +new Date(a.from) - +new Date(b.from))
      .slice(-1)[0];
    return last ? Number(last.value || 0) : base;
  }

  // 1) exact period match
  const exact = (fv.history || []).find(h => inRange(sod, h.from, h.to || eod));
  if (exact) return Number(exact.value || 0);

  // 2) carry forward from latest prior history
  const past = (fv.history || [])
    .filter(h => new Date(h.from) <= sod)
    .sort((a,b) => +new Date(a.from) - +new Date(b.from))
    .slice(-1)[0];

  if (past) return Number(past.value || 0);

  // 3) fallback to base
  return base;
}

// === M2 helpers: build bag + evaluate with frozen policy/date =================
function buildVariableBagForM2(doc, formula, incoming, ts) {
  // Start with incoming realtime/manual variables (request body)
  const bag = { ...(incoming || {}) }; // e.g., { NCV, EF_CO2, EF_nonCO2 }

  // For each symbol in the formula, if role is 'frozen', resolve by policy/date
  const kinds = doc.m2?.formulaRef?.variableKinds || new Map();
  const list  = formula.variables || []; // [{name:'U'}, ...]
  for (const v of list) {
    const name = v.name;
    const role = kinds.get ? kinds.get(name) : kinds[name];
    if (role === 'frozen') {
      bag[name] = resolveFrozenVarValue(doc, name, ts);
    }
  }
  return bag;
}

// Uses expr-eval like your existing evaluateM2
function evaluateM2WithPolicy(doc, formula, incoming, whenTs) {
  const { Parser } = require('expr-eval');
  const parser = new Parser();

  const bag = buildVariableBagForM2(doc, formula, incoming, whenTs);

  // Compute netInFormula from formula.expression using the bag
  const expr = parser.parse(formula.expression);
  const symbols = expr.variables();
  for (const s of symbols) {
    if (!(s in bag)) {
      throw new Error(`Missing variable '${s}' for formula evaluation`);
    }
  }

  const netInFormula = Number(expr.evaluate(bag)) || 0;

  // LE already computed/stored on reduction doc (m2.LE)
  const LE = Number(doc.m2?.LE || 0);

  // final = formulaResult - LE (rounded to 6 decimals like elsewhere)
  const finalNet = Math.round((Number(netInFormula || 0) - LE) * 1e6) / 1e6;

  return { netInFormula, LE, finalNet, bagUsed: bag };
}


  // Ensure the project exists, methodology matches, and data-entry channel matches this endpoint.
  // Returns { doc, rate } with emissionReductionRate snapshot.
  // Ensure the project exists, methodology matches, and data-entry channel matches this endpoint.
  // Returns an object describing the mode:
  //  - M1: { mode:'m1', doc, rate }
  //  - M2: { mode:'m2', doc, formula }
 /**
 * Load reduction + validate input channel + branch based on methodology
 * Returns:
 *   ctx = { mode:'m1'|'m2'|'m3', doc, formula?, rate? }
 */
async function requireReductionForEntry(clientId, projectId, methodology, channel) {
  const doc = await Reduction.findOne({ clientId, projectId, isDeleted: false })
    .lean();

  if (!doc) throw new Error("Reduction project not found");
  if (doc.calculationMethodology !== methodology)
    throw new Error(`This reduction uses ${doc.calculationMethodology}, not ${methodology}`);

  // ---------------------
  // METHOD 1
  // ---------------------
  if (methodology === "methodology1") {
    if (!doc.m1 || !Array.isArray(doc.m1.ABD))
      throw new Error("M1 data missing in reduction");

    const rate = Number(doc.m1?.emissionReductionRate ?? 0);
    return { mode: "m1", doc, rate };
  }

  // ---------------------
  // METHOD 2
  // ---------------------
  if (methodology === "methodology2") {
    const ref = doc.m2?.formulaRef;
    if (!ref || !ref.formulaId)
      throw new Error("No formula attached to this reduction (m2.formulaRef.formulaId)");

    const formula = await ReductionFormula.findById(ref.formulaId).lean();
    if (!formula) throw new Error("Formula not found in DB");

    return { mode: "m2", doc, formula };
  }

  // ---------------------
  // METHOD 3 (NEW)
  // ---------------------
  if (methodology === "methodology3") {
    if (!doc.m3)
      throw new Error("M3 configuration missing in reduction");

    return {
      mode: "m3",
      doc,
      m3: doc.m3,
      buffer: Number(doc.m3.buffer ?? 0)
    };
  }

  throw new Error("Unknown methodology");
}

async function handleM3ManualNetReduction(req, res, ctx) {
  try {
    const { clientId, projectId, calculationMethodology } = req.params;
    const { date, time, entry } = req.body;

    if (!entry) {
      return res.status(400).json({ success:false, message:"entry is required for methodology3" });
    }

    const when = parseDateTimeOrNowIST(date, time);

    // Evaluate B, P, L
   // 1. collect formulaIds from reduction
const allItems = [
  ...(ctx.doc.m3.baselineEmissions || []),
  ...(ctx.doc.m3.projectEmissions || []),
  ...(ctx.doc.m3.leakageEmissions || [])
];

const formulaIds = [...new Set(allItems.map(it => it.formulaId.toString()))];

// 2. fetch formulas
const formulas = await ReductionFormula.find({ _id: { $in: formulaIds } });
const formulasById = {};
formulas.forEach(f => formulasById[f._id.toString()] = f);




// 3. evaluate correctly
const result = await evaluateM3(ctx.doc, formulasById, entry);

    const saved = await NetReductionEntry.create({
      clientId,
      projectId,
      calculationMethodology,
      inputType: "manual",
      sourceDetails: {
        uploadedBy: req.user._id || req.user.id,
        dataSource: "manual"
      },
      date: when.date,
      time: when.time,
      timestamp: when.timestamp,

      methodology3: {
        baseline: result.baselineDetails,
        project: result.projectDetails,
        leakage: result.leakageDetails,
        totals: {
          BE_total: result.BE_total,
          PE_total: result.PE_total,
          LE_total: result.LE_total,
          buffer: result.buffer,
          final: result.final
        }
      },

      netReduction: result.final
    });

    return res.status(201).json({
      success: true,
      message: "Net Reduction saved (M3)",
      data: saved
    });

  } catch (err) {
    return res.status(500).json({
      success:false,
      message:"Failed M3 processing",
      error: err.message
    });
  }
}


function buildM2Context(red, formula, incomingVars = {}) {
  const ctx = {};
  const kinds = red.m2?.formulaRef?.variableKinds || new Map();

  // 1) seed frozen from reduction values
  if (red.m2?.formulaRef?.variables) {
    for (const [k, v] of red.m2.formulaRef.variables.entries()) {
      const role = kinds.get ? kinds.get(k) : kinds[k];
      if (role === 'frozen' && v && typeof v.value === 'number') {
        ctx[k] = v.value;
      }
    }
  }
  // 2) allow formula defaultValue as fallback ONLY if role is frozen
  for (const v of (formula.variables || [])) {
    const role = kinds.get ? kinds.get(v.name) : kinds[v.name];
    if (role === 'frozen' && ctx[v.name] == null && typeof v.defaultValue === 'number') {
      ctx[v.name] = v.defaultValue;
    }
  }
  // 3) apply realtime/manual from request
  for (const v of (formula.variables || [])) {
    const role = kinds.get ? kinds.get(v.name) : kinds[v.name];
    if ((role === 'realtime' || role === 'manual') && incomingVars[v.name] != null) {
      ctx[v.name] = Number(incomingVars[v.name]);
    }
  }
  return ctx;
}

function evaluateM2(red, formula, incomingVars) {
  const parser = new Parser();
  const expr = parser.parse(formula.expression);

  const ctx = buildM2Context(red, formula, incomingVars);
  const symbols = expr.variables();

  // require all symbols
  for (const s of symbols) {
    if (!(s in ctx)) {
      throw new Error(`Missing variable '${s}' for formula evaluation`);
    }
  }

  const netInFormula = Number(expr.evaluate(ctx)) || 0;
  const LE = Number(red.m2?.LE || 0);              // pull LE from Reduction.m2
  const finalNet = round6(netInFormula - LE);      // ✅ compute before returning

  return { netInFormula, LE, finalNet };
}



// === M3 helper: evaluate B/P/L groups using formulas & variable config =================

/**
 * Evaluate a single M3 item (e.g., B1, P2, L1)
 * - item: one entry from reduction.m3.baselineEmissions / projectEmissions / leakageEmissions
 * - formula: ReductionFormula document (expression + variables metadata)
 * - entryPayload: object like { B1: { A: 100 }, ... }
 */
/**
 * Evaluate a single M3 item (B1/P1/L1)
 * Supports: constant, manual, internal (auto-sum)
 */
/**
 * Evaluate a single M3 item (B1 / P1 / L1)
 */
/**
 * Evaluate a single M3 item (B1 / P1 / L1)
 * FIXED VERSION → no "entry is not defined", no undefined groupTotals
 */
/**
 * Evaluate a single M3 emission component (B1 / P1 / L1 / etc.)
 *
 * Supports:
 *  - manual variables (value entered per entry)
 *  - constant variables
 *  - internal variables → auto-sum from Bn / Pn / Ln totals
 *
 * PARAMS:
 *   item        = { id, formulaExpression, variables[] }
 *   formula     = Formula document
 *   entryPayload = { B1:{A:100}, P1:{A:80}, ... }
 *   groupTotals  = { B1:250, P1:96, ... }
 *
 * RETURNS:
 *   { id, label, value, variables }
 */
async function evaluateM3Item(item, entry, groupTotals, Formula) {

  const computedVars = {};
  const formulaBag = {};

  for (const v of item.variables) {
    const varName = v.name;
    const type = v.type;

    // constant
    if (type === "constant") {
      const num = Number(v.value || 0);
      computedVars[varName] = num;
      formulaBag[varName] = num;
      continue;
    }

    // manual
    if (type === "manual") {
      if (entry?.[varName] == null) {
        throw new Error(`Manual variable '${varName}' missing for ${item.id}`);
      }
      const num = Number(entry[varName]);
      computedVars[varName] = num;
      formulaBag[varName] = num;
      continue;
    }

    // internal → use cumulative totals
    if (type === "internal") {
      let sum = 0;
      for (const ref of v.internalSources || []) {
        sum += Number(groupTotals.cumulative[ref] || 0);
      }
      computedVars[varName] = sum;
      formulaBag[varName] = sum;
      continue;
    }
  }

  const formulaDoc = await Formula.findById(item.formulaId).lean();
  const parser = Parser.parse(formulaDoc.expression);
  const value = Number(parser.evaluate(formulaBag) || 0);

  return {
    id: item.id,
    label: item.label,
    formulaExpression: formulaDoc.expression,
    value,
    variables: computedVars
  };
}





/**
 * INTERNAL VARIABLE AUTO-SUM
 * internalSources example:
 *   ["B1","B3","P2"]
 *
 * Steps:
 *   1. Fetch B/P items from reductionDoc
 *   2. Evaluate formula for each referenced B/P item
 *   3. Sum all values
 */
async function computeInternalValueForM3Variable(v, reductionDoc, entryPayload) {
  let sum = 0;

  for (const ref of v.internalSources || []) {
    const isBaseline = ref.startsWith("B");
    const isProject = ref.startsWith("P");

    const group = isBaseline ? "baselineEmissions" :
                  isProject  ? "projectEmissions" :
                               null;

    if (!group) continue;

    const arr = reductionDoc.m3[group] || [];
    const target = arr.find(x => x.id === ref);
    if (!target) continue;

    const formula = await ReductionFormula.findById(target.formulaId).lean();
    if (!formula) continue;

    const parser = new Parser();
    const expr = parser.parse(formula.expression);

    const bag = {};
    const entry = entryPayload[ref] || {};

    for (const tv of (target.variables || [])) {
      if (tv.type === "constant") bag[tv.name] = Number(tv.value);
      if (tv.type === "manual")  bag[tv.name] = Number(entry[tv.name] || 0);
    }

    const value = Number(expr.evaluate(bag) || 0);
    sum += value;
  }

  return round6(sum);
}

function normalizeToFormatB(payload, reductionDoc) {
  const out = { baseline: [], project: [], leakage: [] };

  const baseline = reductionDoc.m3.baselineEmissions || [];
  const project = reductionDoc.m3.projectEmissions || [];
  const leakage = reductionDoc.m3.leakageEmissions || [];

  baseline.forEach(it => {
    out.baseline.push({
      id: it.id,
      vars: payload[it.id] || {}
    });
  });

  project.forEach(it => {
    out.project.push({
      id: it.id,
      vars: payload[it.id] || {}
    });
  });

  leakage.forEach(it => {
    out.leakage.push({
      id: it.id,
      vars: payload[it.id] || {}
    });
  });

  return out;
}

async function evaluateM3(reductionDoc, formulasById, entryPayload) {
  const m3 = reductionDoc.m3 || {};

  const baseline = m3.baselineEmissions || [];
  const project  = m3.projectEmissions  || [];
  const leakage  = m3.leakageEmissions  || [];

  let BE = 0, PE = 0, LE = 0;

  const breakdownBaseline = [];
  const breakdownProject  = [];
  const breakdownLeakage  = [];

  // Track per-item current + cumulative totals *within this entry*
  // (cross-entry cumulatives will be handled in the controller)
  const groupTotals = {
    current:   {}, // e.g. { B1: 250, P1: 96 }
    cumulative: {} // e.g. { B1: 250, B2: 400, P1: 96, ... } for this entry only
  };

  async function process(items, arr) {
    let sum = 0;

    for (const item of items) {
      const varsForItem = entryPayload[item.id] || {};

      const result = await evaluateM3Item(
        item,
        varsForItem,
        groupTotals,
        ReductionFormula
      );

      arr.push(result);
      sum += result.value;

      // store latest single-entry value
      groupTotals.current[item.id] = result.value;

      // maintain per-item cumulative (for internal variables inside THIS entry)
      const prevVal = Number(groupTotals.cumulative[item.id] || 0);
      groupTotals.cumulative[item.id] = round6(prevVal + Number(result.value || 0));
    }

    return round6(sum);
  }

  BE = await process(baseline, breakdownBaseline);
  PE = await process(project,  breakdownProject);
  LE = await process(leakage,  breakdownLeakage);

  const raw    = BE - PE - LE;
  const buffer = Number(m3.buffer || 0);

  const netWithout = round6(raw);
  const netWith    = round6(raw * (1 - buffer / 100));

  // For *this* entry, we can still derive “local” cumulatives by summing
  // the per-item cumulative map keyed by IDs.
  const cumulativeBE = round6(
    baseline.reduce((acc, it) => acc + Number(groupTotals.cumulative[it.id] || 0), 0)
  );
  const cumulativePE = round6(
    project.reduce((acc, it) => acc + Number(groupTotals.cumulative[it.id] || 0), 0)
  );
  const cumulativeLE = round6(
    leakage.reduce((acc, it) => acc + Number(groupTotals.cumulative[it.id] || 0), 0)
  );

  return {
    BE_total: BE,
    PE_total: PE,
    LE_total: LE,
    bufferPercent: buffer,
    netWithoutUncertainty: netWithout,
    netWithUncertainty: netWith,

    // “per-entry” cumulatives – will be rolled up across entries in controller
    cumulativeBE,
    cumulativePE,
    cumulativeLE,

    // placeholders – controller will fill cross-entry cumulatives
    cumulativeNetWithoutUncertainty: 0,
    cumulativeNetWithUncertainty: 0,

    breakdown: {
      baseline: breakdownBaseline,
      project:  breakdownProject,
      leakage:  breakdownLeakage
    }
  };
}





  function parseDateTimeOrNowIST(rawDate, rawTime) {
    // Accept either provided or default IST now; enforce "DD/MM/YYYY" and "HH:mm"
    const now = moment().utcOffset('+05:30');
    let mDate = rawDate ? moment(rawDate, ['DD/MM/YYYY', 'YYYY-MM-DD'], true) : now;
    if (!mDate.isValid()) mDate = now;

    let mTime = rawTime ? moment(rawTime, ['HH:mm','HH:mm:ss'], true) : now;
    if (!mTime.isValid()) mTime = now;

    const date = mDate.format('DD/MM/YYYY');
    const time = mTime.format('HH:mm');
    const ts = moment(`${date} ${time}`, 'DD/MM/YYYY HH:mm', true).toDate();
    return { date, time, timestamp: ts };
  }

  async function getRate(clientId, projectId, calculationMethodology) {
    const doc = await Reduction.findOne({ clientId, projectId, isDeleted:false }).select('calculationMethodology m1.emissionReductionRate');
    if (!doc) throw new Error('Reduction project not found');
    if (doc.calculationMethodology !== calculationMethodology) {
      throw new Error(`Methodology mismatch. Project uses ${doc.calculationMethodology}`);
    }
    if (calculationMethodology === 'methodology1') {
      const rate = Number(doc.m1?.emissionReductionRate || 0);
      if (!isFinite(rate)) throw new Error('emissionReductionRate unavailable');
      return rate;
    }
    // extend here for methodology2 once you define its rate
    throw new Error('Selected methodology not supported yet for net reduction');
  }


  // 🔹 Build per-item cumulative for baseline / project / leakage
function buildM3BreakdownWithCumulative(prevM3, currentResult) {
  const prevBaseline = prevM3?.breakdown?.baseline || [];
  const prevProject  = prevM3?.breakdown?.project  || [];
  const prevLeakage  = prevM3?.breakdown?.leakage  || [];

  const prevBMap = {};
  const prevPMap = {};
  const prevLMap = {};

  // previous cumulative per ID (fallback to previous value if no cumulativeValue yet)
  for (const it of prevBaseline) {
    if (!it.id) continue;
    prevBMap[it.id] = Number(it.cumulativeValue ?? it.value ?? 0);
  }
  for (const it of prevProject) {
    if (!it.id) continue;
    prevPMap[it.id] = Number(it.cumulativeValue ?? it.value ?? 0);
  }
  for (const it of prevLeakage) {
    if (!it.id) continue;
    prevLMap[it.id] = Number(it.cumulativeValue ?? it.value ?? 0);
  }

  const withCum = (currArr, prevMap) =>
    (currArr || []).map(it => {
      const currVal = Number(it.value || 0);
      const prevCum = Number(prevMap[it.id] || 0);
      return {
        ...it,
        cumulativeValue: round6(prevCum + currVal)
      };
    });

  return {
    baseline: withCum(currentResult.breakdown.baseline, prevBMap),
    project:  withCum(currentResult.breakdown.project,  prevPMap),
    leakage:  withCum(currentResult.breakdown.leakage,  prevLMap)
  };
}




  /**
 * Evaluate full Methodology 3 for a Reduction document:
 *  - sums BE_total, PE_total, LE_total
 *  - computes netWithoutUncertainty = BE_total - PE_total - LE_total
 *  - applies buffer% to get netWithUncertainty
 *
 * @param {Object} reductionDoc  Reduction document with m3 populated
 * @param {Object} formulasById  Map: formulaId (string) → ReductionFormula doc
 * @param {Object} entryPayload  e.g.
 *   {
 *     B1: { A: 100 },
 *     B2: { A: 120 },
 *     P1: { A: 80 },
 *     P2: { A: 85 },
 *     L1: { A: 15 },
 *     L2: { A: 20 }
 *   }
 */

/**
 * Save a single Methodology 3 Net Reduction entry (manual channel)
 *
 * Route example (see netReductionR.js notes below):
 *   POST /api/net-reduction/:clientId/:projectId/methodology3/manual
 *
 * Body example:
 * {
 *   "date": "2025-02-01",
 *   "time": "10:30",
 *   "entry": {
 *     "B1": { "A": 100 },
 *     "B2": { "A": 120 },
 *     "P1": { "A": 80 },
 *     "P2": { "A": 85 },
 *     "L1": { "A": 15 },
 *     "L2": { "A": 20 }
 *   }
 * }
 */
/**
 * Save a single Methodology 3 Net Reduction entry (manual channel)
 *
 * Route:
 *   POST /api/net-reduction/:clientId/:projectId/methodology3/manual
 *
 * Body example:
 * {
 *   "date": "2025-04-02",
 *   "time": "10:30",
 *   "entry": {
 *     "B1": { "A": 200 },
 *     "P1": { "A": 160 }
 *   }
 * }
 */
/**
 * Save a single Methodology 3 Net Reduction entry (manual channel)
 *
 * Route:
 *   POST /api/net-reduction/:clientId/:projectId/methodology3/manual
 *
 * Body example:
 * {
 *   "date": "2025-04-02",
 *   "time": "10:30",
 *   "entry": {
 *     "B1": { "A": 200 },
 *     "P1": { "A": 160 }
 *   }
 * }
 */
exports.saveM3NetReduction = async (req, res) => {
  try {
    const { clientId, projectId } = req.params;

    // 1. Load reduction
    const reductionDoc = await Reduction.findOne({
      clientId,
      projectId,
      isDeleted: false
    }).select("calculationMethodology m3 reductionDataEntry");

    if (!reductionDoc) {
      return res.status(404).json({
        success: false,
        message: "Reduction project not found"
      });
    }

    if (reductionDoc.calculationMethodology !== "methodology3") {
      return res.status(400).json({
        success: false,
        message: `Project uses ${reductionDoc.calculationMethodology}`
      });
    }

    // 2. Must be manual channel
    const inputType = (reductionDoc.reductionDataEntry?.inputType || "manual").toLowerCase();
    if (inputType !== "manual") {
      return res.status(400).json({
        success: false,
        message: "This endpoint only supports MANUAL input"
      });
    }

    // 3. Parse timestamp (IST)
    const { date, time } = req.body;
    const when = parseDateTimeOrNowIST(date, time);

    // 4. Entry payload (Format B: { B1:{A:..}, P1:{A:..}, ... })
    const entryPayload = req.body.entry;
    if (!entryPayload || typeof entryPayload !== "object") {
      return res.status(400).json({
        success: false,
        message: "entry object required for M3 (example: { B1:{A:100}, P1:{A:80} })"
      });
    }

    // 5. Collect formulas referred by M3 config
    const allItems = [
      ...(reductionDoc?.m3?.baselineEmissions || []),
      ...(reductionDoc?.m3?.projectEmissions  || []),
      ...(reductionDoc?.m3?.leakageEmissions  || [])
    ];

    const formulaIds = [...new Set(allItems.map(it => it.formulaId.toString()))];

    const formulas = await ReductionFormula.find({
      _id: { $in: formulaIds }
    });

    const formulasById = {};
    formulas.forEach(f => {
      formulasById[f._id.toString()] = f;
    });

    // 6. Evaluate THIS entry (per-entry totals)
    const result = await evaluateM3(reductionDoc, formulasById, entryPayload);

    const BE_now  = Number(result.BE_total || 0);
    const PE_now  = Number(result.PE_total || 0);
    const LE_now  = Number(result.LE_total || 0);
    const Nw_now  = Number(result.netWithoutUncertainty || 0);
    const NwU_now = Number(result.netWithUncertainty || 0);

    // 7. Find latest previous entry for this project & methodology
    const prev = await NetReductionEntry.findOne({
      clientId,
      projectId,
      calculationMethodology: "methodology3"
    })
      .sort({ timestamp: -1 })
      .lean();

    const prevM3 = (prev && prev.m3) ? prev.m3 : {};

    const prevCumBE  = Number(prevM3.cumulativeBE  ?? 0);
    const prevCumPE  = Number(prevM3.cumulativePE  ?? 0);
    const prevCumLE  = Number(prevM3.cumulativeLE  ?? 0);
    const prevCumNw  = Number(prevM3.cumulativeNetWithoutUncertainty ?? 0);
    const prevCumNwU = Number(prevM3.cumulativeNetWithUncertainty   ?? 0);

    // 🔹 Per-item cumulative breakdown
    const breakdownWithCum = buildM3BreakdownWithCumulative(prevM3, result);

    // 8. Build final M3 block with CROSS-ENTRY cumulatives
    const m3Final = {
      ...result,

      cumulativeBE: round6(prevCumBE + BE_now),
      cumulativePE: round6(prevCumPE + PE_now),
      cumulativeLE: round6(prevCumLE + LE_now),

      cumulativeNetWithoutUncertainty: round6(prevCumNw + Nw_now),
      cumulativeNetWithUncertainty:   round6(prevCumNwU + NwU_now),

      breakdown: breakdownWithCum
    };

    // 9. Save entry
    const entry = await NetReductionEntry.create({
      clientId,
      projectId,
      calculationMethodology: "methodology3",
      inputType: "manual",
      sourceDetails: {
        uploadedBy: req.user._id || req.user.id,
        dataSource: "manual"
      },
      date: when.date,
      time: when.time,
      timestamp: when.timestamp,

      m3: m3Final,

      // ⚠️ netReduction is per-entry final, NOT cumulative
      netReduction: NwU_now
    });

    // 10. Recompute project-level cumulative stats (uses netReduction series)
    await recomputeProjectCumulative(clientId, projectId, "methodology3");
    try {
      await recomputeClientNetReductionSummary(clientId);
    } catch (e) {
      console.warn("recomputeClientNetReductionSummary failed:", e.message);
    }

    // 11. Socket broadcast
    emitNR("net-reduction:m3-manual-saved", {
      clientId,
      projectId,
      methodology: "methodology3",
      m3: entry.m3,
      netReduction: entry.netReduction,
      cumulativeNetReduction: entry.cumulativeNetReduction
    });

    return res.status(201).json({
      success: true,
      message: "Methodology 3 net reduction entry saved",
      data: entry
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to save M3 net reduction",
      error: err.message
    });
  }
};





  function makeEntryBase(req, rate, extraSource={}) {
    const { clientId, projectId, calculationMethodology } = req.params;
    const { date, time } = req.body;
    const when = parseDateTimeOrNowIST(date, time);
    return {
      clientId,
      projectId,
      calculationMethodology,
      emissionReductionRate: rate,
      date: when.date,
      time: when.time,
      timestamp: when.timestamp,
      sourceDetails: {
        uploadedBy: req.user._id || req.user.id,
        dataSource: extraSource.dataSource,
        apiEndpoint: extraSource.apiEndpoint,
        iotDeviceId: extraSource.iotDeviceId,
        fileName: extraSource.fileName
      }
    };
  }

  /**
 * Recompute cumulativeNetReduction / highNetReduction / lowNetReduction
 * for ALL entries in a project+methodology after an update/delete.
 */
async function recomputeProjectCumulative(clientId, projectId, calculationMethodology) {
  const rows = await NetReductionEntry
    .find({ clientId, projectId, calculationMethodology })
    .sort({ timestamp: 1 }) // chronological
    .select('_id netReduction');

  let cum = 0;
  let hi = null;
  let lo = null;
  const ops = [];

  for (const r of rows) {
    const nr = Number(r.netReduction) || 0;
    cum = round6(cum + nr);
    hi = (hi == null) ? nr : Math.max(hi, nr);
    lo = (lo == null) ? nr : Math.min(lo, nr);

    ops.push({
      updateOne: {
        filter: { _id: r._id },
        update: {
          $set: {
            cumulativeNetReduction: cum,
            highNetReduction: hi,
            lowNetReduction: lo
          }
        }
      }
    });
  }

  if (ops.length) await NetReductionEntry.bulkWrite(ops);
}

  /** MANUAL: M1 { value } | M2 { variables:{} } + date?, time? */

 /** MANUAL: M1 { value } | M2 { variables:{} } + date?, time?
 *  Now supports batch:
 *    { entries: [ {date,time,value}, ... ] }   // M1
 *    { entries: [ {date,time,variables:{}}, ... ] } // M2
 *  Backward compatible with single entry body.
 */
exports.saveManualNetReduction = async (req, res) => {
  try {
    const { clientId, projectId, calculationMethodology } = req.params;

    const can = await canWriteReductionData(req.user, clientId);
    if (!can.ok)
      return res.status(403).json({ success: false, message: can.reason });

    // Load project + determine mode (M1 / M2 / M3)
    let ctx;
    try {
      ctx = await requireReductionForEntry(
        clientId,
        projectId,
        calculationMethodology,
        "manual"
      );
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message });
    }

    // -----------------------------------------------------
    // 🚀 *** NEW: HANDLE METHODOLOGY 3 ***
    // -----------------------------------------------------
    if (calculationMethodology === "methodology3") {
      // Delegate to existing M3 evaluator function
      return exports.saveM3NetReduction(req, res);
    }

    // -----------------------------------------------------
    // Existing batching for M1 / M2
    // -----------------------------------------------------
    const rows =
      Array.isArray(req.body.entries) && req.body.entries.length
        ? req.body.entries
        : [
            {
              date: req.body.date,
              time: req.body.time,
              value: req.body.value,
              variables: req.body.variables,
            },
          ];

    const docsToInsert = [];
    const errors = [];

    // -----------------------------------------------------
    // 🚀 M1 IMPLEMENTATION (Unchanged)
    // -----------------------------------------------------
    if (ctx.mode === "m1") {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] || {};
        const v = Number(r.value);

        if (!isFinite(v)) {
          errors.push({ row: i + 1, error: "value must be numeric" });
          continue;
        }

        const when = parseDateTimeOrNowIST(r.date, r.time);
        const net = round6(v * ctx.rate);

        docsToInsert.push({
          clientId,
          projectId,
          calculationMethodology,
          inputType: "manual",
          sourceDetails: {
            uploadedBy: req.user._id || req.user.id,
            dataSource: "manual",
          },
          date: when.date,
          time: when.time,
          timestamp: when.timestamp,

          inputValue: v,
          emissionReductionRate: ctx.rate,
          netReduction: net,

          formulaId: null,
          variables: {},
          netReductionInFormula: 0,
        });
      }

      if (!docsToInsert.length)
        return res.status(400).json({
          success: false,
          message: "No valid rows",
          errors,
        });

      const inserted = await NetReductionEntry.insertMany(docsToInsert, {
        ordered: false,
      });

      await recomputeSeries(clientId, projectId, calculationMethodology);
      try {
        await recomputeClientNetReductionSummary(clientId);
      } catch {}

      const fresh = await NetReductionEntry.find({
        _id: { $in: inserted.map((d) => d._id) },
      })
        .select("-__v")
        .lean();

      return res.status(201).json({
        success: true,
        message:
          fresh.length > 1
            ? "Net reductions saved (manual, m1 batch)"
            : "Net reduction saved (manual, m1)",
        saved: fresh.length,
        errors,
        data: fresh,
      });
    }

    // -----------------------------------------------------
    // 🚀 M2 IMPLEMENTATION (Unchanged)
    // -----------------------------------------------------
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const incoming = r.variables || {};

      try {
        const when = parseDateTimeOrNowIST(r.date, r.time);

        const { netInFormula, LE, finalNet } = evaluateM2WithPolicy(
          ctx.doc,
          ctx.formula,
          incoming,
          when.timestamp
        );

        docsToInsert.push({
          clientId,
          projectId,
          calculationMethodology,

          formulaId: ctx.formula._id,
          variables: incoming,
          netReductionInFormula: netInFormula,
          netReduction: finalNet,

          inputType: "manual",
          sourceDetails: {
            uploadedBy: req.user._id || req.user.id,
            dataSource: "manual",
          },

          inputValue: 0,
          emissionReductionRate: 0,
          date: when.date,
          time: when.time,
          timestamp: when.timestamp,

          _tmpLE: LE,
        });
      } catch (e) {
        errors.push({ row: i + 1, error: e.message });
      }
    }

    if (!docsToInsert.length)
      return res.status(400).json({
        success: false,
        message: "No valid rows",
        errors,
      });

    const toSave = docsToInsert.map((d) => {
      const { _tmpLE, ...rest } = d;
      return rest;
    });

    const inserted = await NetReductionEntry.insertMany(toSave, {
      ordered: false,
    });

    await recomputeSeries(clientId, projectId, calculationMethodology);
    try {
      await recomputeClientNetReductionSummary(clientId);
    } catch {}

    const fresh = await NetReductionEntry.find({
      _id: { $in: inserted.map((d) => d._id) },
    })
      .select("-__v")
      .lean();

    return res.status(201).json({
      success: true,
      message:
        fresh.length > 1
          ? "Net reductions saved (manual, m2 batch)"
          : "Net reduction saved (manual, m2)",
      saved: fresh.length,
      errors,
      data: fresh,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to save net reduction (manual)",
      error: err.message,
    });
  }
};





// ==============================================
// 1) API NET REDUCTION – AUTH REMOVED HERE ✅
// ==============================================

/**
 * BEFORE:
 *   - This function called canWriteReductionData(req.user, clientId)
 *   - It also used req.user._id / req.user.id in sourceDetails.uploadedBy
 *
 * NOW:
 *   - NO permission check; works without auth token
 *   - uploadedBy is left undefined (optional)
 */
// ==============================================
// 1) API NET REDUCTION – AUTH REMOVED HERE ✅
// ==============================================

// ==============================================
// 1) API NET REDUCTION – AUTH REMOVED (as requested)
// ==============================================

exports.saveApiNetReduction = async (req, res) => {
  try {
    const { clientId, projectId, calculationMethodology } = req.params;

    // Load project + determine M1/M2/M3 + validate channel
    let ctx;
    try {
      ctx = await requireReductionForEntry(
        clientId,
        projectId,
        calculationMethodology,
        "api"
      );
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message });
    }

    const when = parseDateTimeOrNowIST(req.body.date, req.body.time);
    const apiEndpoint = req.body.apiEndpoint || "";

    // ============================================================
    // 🟦 M1 PATH
    // ============================================================
    if (ctx.mode === "m1") {
      const value = Number(req.body.value);
      if (!isFinite(value)) {
        return res.status(400).json({
          success: false,
          message: "value must be numeric"
        });
      }

      const net = round6(value * ctx.rate);

      const entry = await NetReductionEntry.create({
        clientId,
        projectId,
        calculationMethodology,
        inputType: "API",
        sourceDetails: {
          dataSource: "API",
          apiEndpoint
        },
        date: when.date,
        time: when.time,
        timestamp: when.timestamp,

        inputValue: value,
        emissionReductionRate: ctx.rate,
        netReduction: net
      });

      try { await recomputeProjectCumulative(clientId, projectId, calculationMethodology); } catch {}
      try { await recomputeClientNetReductionSummary(clientId); } catch {}

      emitNR("net-reduction:api-saved", {
        clientId,
        projectId,
        calculationMethodology,
        mode: "m1",
        entryId: entry._id,
        date: entry.date,
        time: entry.time,
        netReduction: entry.netReduction,
        cumulativeNetReduction: entry.cumulativeNetReduction,
        highNetReduction: entry.highNetReduction,
        lowNetReduction: entry.lowNetReduction
      });

      return res.status(201).json({
        success: true,
        message: "Net reduction saved (API, m1)",
        data: entry
      });
    }

    // ============================================================
    // 🟪 M2 PATH
    // ============================================================
    if (ctx.mode === "m2") {
      const incoming = req.body.variables || {};

      try {
        const { netInFormula, LE, finalNet } = evaluateM2WithPolicy(
          ctx.doc,
          ctx.formula,
          incoming,
          when.timestamp
        );

        const entry = await NetReductionEntry.create({
          clientId,
          projectId,
          calculationMethodology,
          formulaId: ctx.formula._id,
          variables: incoming,
          netReductionInFormula: netInFormula,
          netReduction: finalNet,
          inputType: "API",
          sourceDetails: {
            dataSource: "API",
            apiEndpoint
          },
          inputValue: 0,
          emissionReductionRate: 0,
          date: when.date,
          time: when.time,
          timestamp: when.timestamp
        });

        try { await recomputeProjectCumulative(clientId, projectId, calculationMethodology); } catch {}
        try { await recomputeClientNetReductionSummary(clientId); } catch {}

        emitNR("net-reduction:api-saved", {
          clientId,
          projectId,
          calculationMethodology,
          mode: "m2",
          entryId: entry._id,
          date: entry.date,
          time: entry.time,
          netReductionInFormula: entry.netReductionInFormula,
          netReduction: entry.netReduction,
          cumulativeNetReduction: entry.cumulativeNetReduction,
          highNetReduction: entry.highNetReduction,
          lowNetReduction: entry.lowNetReduction
        });

        return res.status(201).json({
          success: true,
          message: "Net reduction saved (API, m2)",
          data: entry
        });
      } catch (e) {
        return res.status(400).json({ success: false, message: e.message });
      }
    }

    // ============================================================
    // 🟧 M3 PATH
    // ============================================================
    if (ctx.mode === "m3") {
      const entryPayload = req.body.entry || {};
      if (!entryPayload || typeof entryPayload !== "object") {
        return res.status(400).json({
          success: false,
          message: "entry object is required for M3 (B1,B2,P1,P2,L1,L2...)"
        });
      }

      // Collect all formulas
      const m3 = ctx.doc.m3 || {};
      const allItems = [
        ...(m3.baselineEmissions || []),
        ...(m3.projectEmissions || []),
        ...(m3.leakageEmissions || [])
      ];

      const formulaIds = [
        ...new Set(allItems.map(it => it.formulaId.toString()))
      ];

      const formulas = await ReductionFormula.find({ _id: { $in: formulaIds } });
      const formulasById = {};
      formulas.forEach(f => (formulasById[f._id.toString()] = f));

      // Evaluate Methodology 3
      const result = await evaluateM3(ctx.doc, formulasById, entryPayload);

      const entry = await NetReductionEntry.create({
        clientId,
        projectId,
        calculationMethodology,
        inputType: "API",
        sourceDetails: {
          dataSource: "API",
          apiEndpoint
        },

        date: when.date,
        time: when.time,
        timestamp: when.timestamp,

        m3: result,
        netReduction: result.netWithUncertainty
      });

      try { await recomputeProjectCumulative(clientId, projectId, calculationMethodology); } catch {}
      try { await recomputeClientNetReductionSummary(clientId); } catch {}

      emitNR("net-reduction:api-saved", {
        clientId,
        projectId,
        calculationMethodology,
        mode: "m3",
        entryId: entry._id,
        date: entry.date,
        time: entry.time,
        netReduction: entry.netReduction,
        m3: entry.m3
      });

      return res.status(201).json({
        success: true,
        message: "Net reduction saved (API, m3)",
        data: entry
      });
    }

    // ============================================================
    // Unknown
    // ============================================================
    return res.status(400).json({
      success: false,
      message: `Unsupported methodology mode: ${ctx.mode}`
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to save net reduction (API)",
      error: err.message
    });
  }
};



// ==============================================
// 2) IOT NET REDUCTION – AUTH REMOVED HERE ✅
// ==============================================

/**
 * BEFORE:
 *   - used canWriteReductionData(req.user, clientId)
 *   - used req.user._id / req.user.id as uploadedBy
 *
 * NOW:
 *   - No permission check
 *   - uploadedBy omitted
 */
// ==============================================
// 2) IOT NET REDUCTION – AUTH REMOVED (as requested)
// ==============================================

exports.saveIotNetReduction = async (req, res) => {
  try {
    const { clientId, projectId, calculationMethodology } = req.params;

    // 🚫 NO AUTH CHECK (IoT ingestion is open)
    // const can = await canWriteReductionData(req.user, clientId);

    // Load reduction project + detect methodology mode
    let ctx;
    try {
      ctx = await requireReductionForEntry(
        clientId,
        projectId,
        calculationMethodology,
        "iot"
      );
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message });
    }

    const when = parseDateTimeOrNowIST(req.body.date, req.body.time);
    const deviceId = req.body.deviceId || "";

    // ============================================================
    // 🟦 METHOD 1 (M1)
    // ============================================================
    if (ctx.mode === "m1") {
      const value = Number(req.body.value);
      if (!isFinite(value)) {
        return res.status(400).json({
          success: false,
          message: "value must be numeric"
        });
      }

      const net = round6(value * ctx.rate);

      const entry = await NetReductionEntry.create({
        clientId,
        projectId,
        calculationMethodology,
        inputType: "IOT",
        sourceDetails: {
          dataSource: "IOT",
          iotDeviceId: deviceId
        },
        date: when.date,
        time: when.time,
        timestamp: when.timestamp,

        inputValue: value,
        emissionReductionRate: ctx.rate,
        netReduction: net
      });

      try { await recomputeProjectCumulative(clientId, projectId, calculationMethodology); } catch {}
      try { await recomputeClientNetReductionSummary(clientId); } catch {}

      emitNR("net-reduction:iot-saved", {
        clientId,
        projectId,
        calculationMethodology,
        mode: "m1",
        entryId: entry._id,
        date: entry.date,
        time: entry.time,
        netReduction: entry.netReduction,
        cumulativeNetReduction: entry.cumulativeNetReduction,
        highNetReduction: entry.highNetReduction,
        lowNetReduction: entry.lowNetReduction
      });

      return res.status(201).json({
        success: true,
        message: "Net reduction saved (IoT, m1)",
        data: entry
      });
    }

    // ============================================================
    // 🟪 METHOD 2 (M2)
    // ============================================================
    if (ctx.mode === "m2") {
      const incoming = req.body.variables || {};

      try {
        const { netInFormula, LE, finalNet } = evaluateM2WithPolicy(
          ctx.doc,
          ctx.formula,
          incoming,
          when.timestamp
        );

        const entry = await NetReductionEntry.create({
          clientId,
          projectId,
          calculationMethodology,
          formulaId: ctx.formula._id,
          variables: incoming,
          netReductionInFormula: netInFormula,
          netReduction: finalNet,

          inputType: "IOT",
          sourceDetails: {
            dataSource: "IOT",
            iotDeviceId: deviceId
          },

          inputValue: 0,
          emissionReductionRate: 0,
          date: when.date,
          time: when.time,
          timestamp: when.timestamp
        });

        try { await recomputeProjectCumulative(clientId, projectId, calculationMethodology); } catch {}
        try { await recomputeClientNetReductionSummary(clientId); } catch {}

        emitNR("net-reduction:iot-saved", {
          clientId,
          projectId,
          calculationMethodology,
          mode: "m2",
          entryId: entry._id,
          date: entry.date,
          time: entry.time,
          netReductionInFormula: entry.netReductionInFormula,
          netReduction: entry.netReduction,
          cumulativeNetReduction: entry.cumulativeNetReduction,
          highNetReduction: entry.highNetReduction,
          lowNetReduction: entry.lowNetReduction
        });

        return res.status(201).json({
          success: true,
          message: "Net reduction saved (IoT, m2)",
          data: entry
        });
      } catch (e) {
        return res.status(400).json({ success: false, message: e.message });
      }
    }

    // ============================================================
    // 🟧 METHOD 3 (M3) — NEW
    // ============================================================
    if (ctx.mode === "m3") {
      const entryPayload = req.body.entry || {};

      if (!entryPayload || typeof entryPayload !== "object") {
        return res.status(400).json({
          success: false,
          message: "entry object required for M3 (example: {B1:{A:10}})"
        });
      }

      const m3 = ctx.doc.m3 || {};
      const allItems = [
        ...(m3.baselineEmissions || []),
        ...(m3.projectEmissions || []),
        ...(m3.leakageEmissions || [])
      ];

      const formulaIds = [...new Set(allItems.map(it => it.formulaId.toString()))];

      const formulas = await ReductionFormula.find({ _id: { $in: formulaIds } });
      const formulasById = {};
      formulas.forEach(f => (formulasById[f._id.toString()] = f));

      // Run Methodology-3 evaluator
      const result =await evaluateM3(ctx.doc, formulasById, entryPayload);

      const entry = await NetReductionEntry.create({
        clientId,
        projectId,
        calculationMethodology,

        inputType: "IOT",
        sourceDetails: {
          dataSource: "IOT",
          iotDeviceId: deviceId
        },

        date: when.date,
        time: when.time,
        timestamp: when.timestamp,

        m3: result,
        netReduction: result.netWithUncertainty
      });

      try { await recomputeProjectCumulative(clientId, projectId, calculationMethodology); } catch {}
      try { await recomputeClientNetReductionSummary(clientId); } catch {}

      emitNR("net-reduction:iot-saved", {
        clientId,
        projectId,
        calculationMethodology,
        mode: "m3",
        entryId: entry._id,
        date: entry.date,
        time: entry.time,
        m3: entry.m3,
        netReduction: entry.netReduction
      });

      return res.status(201).json({
        success: true,
        message: "Net reduction saved (IoT, m3)",
        data: entry
      });
    }

    // ============================================================
    // ❗ UNKNOWN MODE
    // ============================================================
    return res.status(400).json({
      success: false,
      message: `Unsupported methodology mode: ${ctx.mode}`
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to save net reduction (IOT)",
      error: err.message
    });
  }
};



/**
 * Converts CSV row fields into M3 entry payload
 * Example input keys:
 *   B1_A = 100
 *   P1_A = 80
 * Output:
 *   { B1:{A:100}, P1:{A:80} }
 */
function parseM3CsvRow(row) {
  const entry = {};

  for (const key of Object.keys(row)) {
    if (!key.includes("_")) continue;

    const [itemId, varName] = key.split("_");
    if (!itemId || !varName) continue;

    const raw = row[key];
    if (raw === "" || raw == null) continue;

    if (!entry[itemId]) entry[itemId] = {};
    entry[itemId][varName] = Number(raw);
  }

  return entry;
}


 /**
 * CSV Upload for Net Reduction
 *  - M1: expects columns: value, date?, time?
 *  - M2: expects columns matching formula variables (e.g., U,N,SFS,...) OR a JSON column: variables
 * CSV always saves as MANUAL input type.
 */
/**
 * CSV Upload for Net Reduction
 * Supports:
 *  - M1: value, date?, time?
 *  - M2: variables as columns OR JSON "variables"
 *  - M3: columns like B1_A, P1_A, L1_A mapping to M3 variables
 *
 * Always saved as MANUAL input type.
 */
exports.uploadCsvNetReduction = async (req, res) => {
  let tempPath = null;

  try {
    const { clientId, projectId, calculationMethodology } = req.params;

    // Permission
    const can = await canWriteReductionData(req.user, clientId);
    if (!can.ok) {
      return res.status(403).json({ success: false, message: can.reason });
    }

    // Context
    let ctx;
    try {
      ctx = await requireReductionForEntry(
        clientId,
        projectId,
        calculationMethodology,
        'manual'
      );
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message });
    }

    if (!req.file?.path) {
      return res.status(400).json({
        success: false,
        message: 'No CSV file uploaded'
      });
    }

    tempPath = req.file.path;

    // Read file → S3
    const buffer = fs.readFileSync(req.file.path);
    const s3Upload = await uploadReductionCSVCreate({
      clientId,
      projectId,
      calculationMethodology,
      fileName: req.file.originalname,
      buffer
    });

    // Parse CSV
    const rows = await csvtojson().fromFile(req.file.path);
    if (!rows.length) {
      return res.status(400).json({ success: false, message: 'CSV empty' });
    }

    const saved = [];
    const errors = [];

    // ============================
    // M1
    // ============================
    if (ctx.mode === 'm1') {
      for (let i = 0; i < rows.length; i++) {
        try {
          const r = rows[i];
          const value = Number(r.value);
          if (!isFinite(value)) throw new Error('value must be numeric');

          const when = parseDateTimeOrNowIST(r.date, r.time);

          const entry = await NetReductionEntry.create({
            clientId,
            projectId,
            calculationMethodology,
            inputType: 'CSV',
            sourceDetails: {
              uploadedBy: req.user._id || req.user.id,
              dataSource: 'CSV',
              fileName: req.file.originalname,
              s3: s3Upload
            },
            date: when.date,
            time: when.time,
            timestamp: when.timestamp,
            inputValue: value,
            emissionReductionRate: ctx.rate,
            netReduction: round6(value * ctx.rate)
          });

          saved.push(entry);
        } catch (e) {
          errors.push({ row: i + 1, error: e.message });
        }
      }
    }

    // ============================
    // M2
    // ============================
    else if (ctx.mode === 'm2') {
      const expr = new Parser().parse(ctx.formula.expression);
      const vars = expr.variables();

      for (let i = 0; i < rows.length; i++) {
        try {
          const r = rows[i];
          let incoming = {};

          if (r.variables) {
            incoming = JSON.parse(r.variables);
          }

          vars.forEach(v => {
            if (r[v] !== undefined && r[v] !== '') {
              incoming[v] = Number(r[v]);
            }
          });

          const when = parseDateTimeOrNowIST(r.date, r.time);
          const { netInFormula, finalNet } = evaluateM2WithPolicy(
            ctx.doc,
            ctx.formula,
            incoming,
            when.timestamp
          );

          const entry = await NetReductionEntry.create({
            clientId,
            projectId,
            calculationMethodology,
            formulaId: ctx.formula._id,
            variables: incoming,
            netReductionInFormula: netInFormula,
            netReduction: finalNet,
            inputType: 'CSV',
            sourceDetails: {
              uploadedBy: req.user._id || req.user.id,
              dataSource: 'CSV',
              fileName: req.file.originalname,
              s3: s3Upload
            },
            date: when.date,
            time: when.time,
            timestamp: when.timestamp
          });

          saved.push(entry);
        } catch (e) {
          errors.push({ row: i + 1, error: e.message });
        }
      }
    }

    // ============================
    // M3
    // ============================
    else if (ctx.mode === 'm3') {
      for (let i = 0; i < rows.length; i++) {
        try {
          const payload = parseM3CsvRow(rows[i]);
          const when = parseDateTimeOrNowIST(rows[i].date, rows[i].time);

          const result = await evaluateM3(ctx.doc, ctx.formulasById, payload);

          const entry = await NetReductionEntry.create({
            clientId,
            projectId,
            calculationMethodology,
            inputType: 'CSV',
            sourceDetails: {
              uploadedBy: req.user._id || req.user.id,
              dataSource: 'CSV',
              fileName: req.file.originalname,
              s3: s3Upload
            },
            date: when.date,
            time: when.time,
            timestamp: when.timestamp,
            m3: result,
            netReduction: result.netWithUncertainty
          });

          saved.push(entry);
        } catch (e) {
          errors.push({ row: i + 1, error: e.message });
        }
      }
    }

    // Cleanup
    try { fs.unlinkSync(req.file.path); } catch {}

    // Recompute summaries
    await recomputeProjectCumulative(clientId, projectId, calculationMethodology);
    await recomputeClientNetReductionSummary(clientId);

    if (global.broadcastNetReductionCompletionUpdate) {
      global.broadcastNetReductionCompletionUpdate(clientId);
    }

    return res.status(201).json({
      success: true,
      message: 'CSV processed',
      saved: saved.length,
      errors,
      s3: s3Upload,
      lastSaved: saved[saved.length - 1] || null
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Failed to upload CSV net reduction',
      error: err.message
    });
  }
};





  /** Methodology-2: body { inputType, variables: {A:..,B:..}, date?, time?, apiEndpoint?, deviceId?, fileName? } */
  exports.saveM2NetReduction = async (req,res)=>{
    try {
      const { clientId, projectId, calculationMethodology } = req.params;
      if (calculationMethodology !== 'methodology2') {
        return res.status(400).json({ success:false, message:'Use methodology2 for this endpoint' });
      }

      // who can write (same policy you used earlier)
      const can = await canWriteReductionData(req.user, clientId);
      if (!can.ok) return res.status(403).json({ success:false, message: can.reason });

      // load reduction & formula
      const red = await Reduction.findOne({ clientId, projectId, isDeleted:false })
        .select('calculationMethodology m2');
      if (!red) return res.status(404).json({ success:false, message:'Reduction not found' });
      if (red.calculationMethodology !== 'methodology2') {
        return res.status(400).json({ success:false, message:`Project uses ${red.calculationMethodology}` });
      }
      if (!red.m2?.formulaRef?.formulaId) {
        return res.status(400).json({ success:false, message:'No formula attached to this reduction (m2.formulaRef.formulaId)' });
      }

      const formula = await ReductionFormula.findById(red.m2.formulaRef.formulaId);
      if (!formula || formula.isDeleted) {
        return res.status(404).json({ success:false, message:'Formula not found' });
      }

      // prepare variable context
      const incoming = req.body.variables || {};
      const ctx = {};

      // 1) seed frozen values from reduction.m2.formulaRef.variables (or variable default)
      if (red.m2.formulaRef.variables) {
        for (const [k, v] of red.m2.formulaRef.variables.entries()) {
          if (v && typeof v.value === 'number') ctx[k] = v.value;
        }
      }
      (formula.variables || []).forEach(v => {
        if (v.kind === 'frozen' && ctx[v.name] == null && typeof v.defaultValue === 'number') {
          ctx[v.name] = v.defaultValue;
        }
      });

      // 2) apply realtime variables from request
      (formula.variables || []).forEach(v => {
        if (v.kind === 'realtime') {
          if (incoming[v.name] == null) {
            // allow missing to be 0 or reject — here we enforce presence
            return;
          }
          ctx[v.name] = Number(incoming[v.name]);
        }
      });

      // sanity: all symbols used in expression must exist
      const parser = new Parser();
      const expr = parser.parse(formula.expression);
      const symbols = expr.variables();
      for (const s of symbols) {
        if (!(s in ctx)) {
          return res.status(400).json({ success:false, message:`Missing variable '${s}' for formula evaluation` });
        }
      }

      // evaluate
      const netInFormula = Number(expr.evaluate(ctx)) || 0;
      const LE = Number(red.m2?.LE || 0);
      const finalNet = Math.round((netInFormula - LE) * 1e6) / 1e6;

      // timestamps & source meta
      const when = parseDateTimeOrNowIST(req.body.date, req.body.time);
      const inputType = (req.body.inputType || 'manual').toString();

      const entry = await NetReductionEntry.create({
        clientId, projectId, calculationMethodology,
        // m2-specific fields
        formulaId: formula._id,
        variables: incoming,
        netReductionInFormula: netInFormula,

        // common provenance
        inputType,
        sourceDetails: {
          uploadedBy: req.user._id || req.user.id,
          dataSource: inputType.toUpperCase(),
          apiEndpoint: req.body.apiEndpoint || '',
          iotDeviceId: req.body.deviceId || '',
          fileName: req.body.fileName || ''
        },

        // we set the final netReduction directly for m2
        netReduction: finalNet,

        // placeholders to keep schema happy for m1 fields
        inputValue: 0,
        emissionReductionRate: 0,

        date: when.date,
        time: when.time,
        timestamp: when.timestamp
      });
      try { await recomputeClientNetReductionSummary(clientId); } catch (e) { console.warn('summary recompute failed:', e.message); }

            emitNR('net-reduction:iot-saved', {
        clientId, projectId, calculationMethodology, mode: 'm2',
        entryId: entry._id, date: entry.date, time: entry.time,
        netReductionInFormula: entry.netReductionInFormula,
        netReduction: entry.netReduction,
        cumulativeNetReduction: entry.cumulativeNetReduction,
        highNetReduction: entry.highNetReduction,
        lowNetReduction: entry.lowNetReduction
      });
      res.status(201).json({
        success:true,
        message:'Net reduction saved (m2, formula)',
        data:{
          clientId, projectId,
          date: entry.date, time: entry.time,
          variables: entry.variables,
          netReductionInFormula: entry.netReductionInFormula,
          LE,
          netReduction: entry.netReduction,
          cumulativeNetReduction: entry.cumulativeNetReduction,
          highNetReduction: entry.highNetReduction,
          lowNetReduction: entry.lowNetReduction
        }
      });
    } catch(e){
      res.status(500).json({ success:false, message:'Failed to save m2 net reduction', error: e.message });
    }
  };

  /** Optional: quick stats */
  exports.getNetReductionStats = async (req, res) => {
    try {
      const { clientId, projectId, calculationMethodology } = req.params;
      const latest = await NetReductionEntry.findOne({ clientId, projectId, calculationMethodology })
        .sort({ timestamp: -1 })
        .select('cumulativeNetReduction highNetReduction lowNetReduction date time');
      if (!latest) return res.status(404).json({ success:false, message:'No net reduction data' });
      res.status(200).json({ success:true, data: latest });
    } catch (err) {
      res.status(500).json({ success:false, message:'Failed to fetch net reduction stats', error: err.message });
    }
  };






  // --- ADD THIS HELPER NEAR THE TOP (below other helpers) ---
function round6(n){ return Math.round((Number(n)||0)*1e6)/1e6; }

/**
 * Recompute cumulativeNetReduction, highNetReduction, lowNetReduction
 * for the entire (clientId, projectId, methodology) series.
 * Uses chronological order and derives high/low from the cumulative.
 */
async function recomputeSeries(clientId, projectId, calculationMethodology) {
  const rows = await NetReductionEntry.find({
    clientId, projectId, calculationMethodology
  })
  .sort({ timestamp: 1 })
  .select('_id netReduction');

  let cum = 0;
  let high = null;
  let low  = null;

  const ops = [];
  for (const r of rows) {
    const nr = Number(r.netReduction || 0);
    cum = round6(cum + nr);

    // highs/lows must be based on the cumulative, not the single-row net
    high = (high === null) ? cum : Math.max(high, cum);
    low  = (low === null)  ? cum : Math.min(low,  cum);

    ops.push({
      updateOne: {
        filter: { _id: r._id },
        update: {
          $set: {
            cumulativeNetReduction: cum,
            highNetReduction: high,
            lowNetReduction: low
          }
        }
      }
    });
  }

  if (ops.length) await NetReductionEntry.bulkWrite(ops);
  return { count: rows.length, cumulative: cum, high, low };
}




// controllers/Reduction/netReductionController.js

/**
 * GET NET REDUCTION ENTRIES
 * 
 * Route: GET /api/net-reduction?clientId=Greon216&projectId=PROJECT123&limit=50&page=1
 * 
 * Query Parameters:
 *   - clientId (REQUIRED): Client ID to fetch data for
 *   - projectId (OPTIONAL): Specific project ID filter
 *   - calculationMethodology (OPTIONAL): methodology1, methodology2, or methodology3
 *   - limit (OPTIONAL): Number of records per page (default: 20, max: 200)
 *   - page (OPTIONAL): Page number (default: 1)
 *   - sortBy (OPTIONAL): Field to sort by (default: 'timestamp')
 *   - sortOrder (OPTIONAL): 'asc' or 'desc' (default: 'desc')
 *   - from (OPTIONAL): Start date filter (DD/MM/YYYY or YYYY-MM-DD)
 *   - to (OPTIONAL): End date filter (DD/MM/YYYY or YYYY-MM-DD)
 * 
 * Response:
 * {
 *   "success": true,
 *   "message": "Net reduction entries fetched successfully",
 *   "meta": {
 *     "page": 1,
 *     "limit": 50,
 *     "total": 150,
 *     "totalPages": 3,
 *     "hasNextPage": true,
 *     "hasPrevPage": false
 *   },
 *   "filter": {
 *     "clientId": "Greon216",
 *     "projectId": "PROJECT123"
 *   },
 *   "data": [...]
 * }
 */
exports.getNetReduction = async (req, res) => {
  try {
    const user = req.user;
    
    // ============================================
    // 1. VALIDATE REQUIRED PARAMS
    // ============================================
    const { clientId } = req.query;
    
    if (!clientId) {
      return res.status(400).json({
        success: false,
        message: 'clientId is required as a query parameter'
      });
    }

    // ============================================
    // 2. PERMISSION CHECK
    // ============================================
    const hasAccess = await checkNetReductionReadAccess(user, clientId);
    
    if (!hasAccess.allowed) {
      return res.status(403).json({
        success: false,
        message: 'Permission denied',
        reason: hasAccess.reason
      });
    }

    // ============================================
    // 3. BUILD QUERY FILTER
    // ============================================
    const {
      projectId,
      calculationMethodology,
      limit = 20,
      page = 1,
      sortBy = 'timestamp',
      sortOrder = 'desc',
      from,
      to
    } = req.query;

    const filter = { clientId };

    // Optional project filter
    if (projectId) {
      filter.projectId = projectId;
    }

    // Optional methodology filter
    if (calculationMethodology) {
      if (!['methodology1', 'methodology2', 'methodology3'].includes(calculationMethodology)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid calculationMethodology. Must be methodology1, methodology2, or methodology3'
        });
      }
      filter.calculationMethodology = calculationMethodology;
    }

    // Date range filter
    if (from || to) {
      filter.timestamp = {};
      
      if (from) {
        const fromDate = parseDate(from);
        if (fromDate) {
          filter.timestamp.$gte = fromDate;
        }
      }
      
      if (to) {
        const toDate = parseDate(to);
        if (toDate) {
          // Set to end of day
          toDate.setHours(23, 59, 59, 999);
          filter.timestamp.$lte = toDate;
        }
      }
    }

    // ============================================
    // 4. PAGINATION & SORTING
    // ============================================
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const sortOptions = {};
    sortOptions[sortBy] = sortOrder.toLowerCase() === 'asc' ? 1 : -1;

    // ============================================
    // 5. FETCH DATA
    // ============================================
    const [total, entries] = await Promise.all([
      NetReductionEntry.countDocuments(filter),
      NetReductionEntry.find(filter)
        .sort(sortOptions)
        .skip(skip)
        .limit(limitNum)
        .populate('sourceDetails.uploadedBy', 'userName email')
        .populate('formulaId', 'name expression variables')
        .select('-__v')
        .lean()
    ]);

    // ============================================
    // 6. CALCULATE AGGREGATES (Optional)
    // ============================================
    const aggregates = await calculateAggregates(filter);

    // ============================================
    // 7. RESPONSE
    // ============================================
    return res.status(200).json({
      success: true,
      message: 'Net reduction entries fetched successfully',
      meta: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
        hasNextPage: pageNum < Math.ceil(total / limitNum),
        hasPrevPage: pageNum > 1
      },
      filter: {
        clientId,
        projectId: projectId || null,
        calculationMethodology: calculationMethodology || null,
        dateRange: {
          from: from || null,
          to: to || null
        }
      },
      aggregates,
      data: entries
    });

  } catch (error) {
    console.error('❌ getNetReduction error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch net reduction entries',
      error: error.message
    });
  }
};

// ============================================
// HELPER: CHECK READ ACCESS
// ============================================
async function checkNetReductionReadAccess(user, clientId) {
  if (!user) {
    return { allowed: false, reason: 'Authentication required' };
  }

  const userId = user._id || user.id;

  // 1. Super Admin - full access
  if (user.userType === 'super_admin') {
    return { allowed: true, reason: 'Super admin access' };
  }

  // 2. Client-side users (same clientId)
  const clientSideRoles = [
    'client_admin',
    'client_employee_head',
    'employee',
    'auditor',
    'viewer'
  ];
  
  if (clientSideRoles.includes(user.userType) && user.clientId === clientId) {
    return { allowed: true, reason: 'Client user access' };
  }

  // 3. Consultant Admin - created this client OR manages consultants assigned to it
  if (user.userType === 'consultant_admin') {
    const client = await Client.findOne({ clientId })
      .select('leadInfo.createdBy leadInfo.assignedConsultantId')
      .lean();

    if (!client) {
      return { allowed: false, reason: 'Client not found' };
    }

    // Created by this consultant admin
    if (client.leadInfo?.createdBy?.toString() === userId.toString()) {
      return { allowed: true, reason: 'Consultant admin (creator) access' };
    }

    // Check if assigned consultant reports to this consultant admin
    const assignedConsultantId = client.leadInfo?.assignedConsultantId;
    if (assignedConsultantId) {
      const consultant = await User.findById(assignedConsultantId)
        .select('consultantAdminId')
        .lean();

      if (consultant?.consultantAdminId?.toString() === userId.toString()) {
        return { allowed: true, reason: 'Consultant admin (manager) access' };
      }
    }

    return { allowed: false, reason: 'Not authorized for this client' };
  }

  // 4. Consultant - assigned to this client
  if (user.userType === 'consultant') {
    const client = await Client.findOne({
      clientId,
      'leadInfo.assignedConsultantId': userId
    }).lean();

    if (client) {
      return { allowed: true, reason: 'Assigned consultant access' };
    }

    return { allowed: false, reason: 'Not assigned to this client' };
  }

  return { allowed: false, reason: 'Insufficient permissions' };
}

// ============================================
// HELPER: PARSE DATE
// ============================================
function parseDate(dateStr) {
  if (!dateStr) return null;

  const moment = require('moment');
  
  // Try multiple formats
  const formats = ['DD/MM/YYYY', 'YYYY-MM-DD', 'DD-MM-YYYY'];
  const m = moment(dateStr, formats, true);
  
  return m.isValid() ? m.toDate() : null;
}

// ============================================
// HELPER: CALCULATE AGGREGATES
// ============================================
async function calculateAggregates(filter) {
  try {
    const pipeline = [
      { $match: filter },
      {
        $group: {
          _id: null,
          totalEntries: { $sum: 1 },
          totalNetReduction: { $sum: '$netReduction' },
          avgNetReduction: { $avg: '$netReduction' },
          maxNetReduction: { $max: '$netReduction' },
          minNetReduction: { $min: '$netReduction' },
          latestCumulative: { $max: '$cumulativeNetReduction' }
        }
      }
    ];

    const result = await NetReductionEntry.aggregate(pipeline);

    if (result.length === 0) {
      return {
        totalEntries: 0,
        totalNetReduction: 0,
        avgNetReduction: 0,
        maxNetReduction: 0,
        minNetReduction: 0,
        latestCumulative: 0
      };
    }

    const aggregates = result[0];
    delete aggregates._id;

    // Round values
    return {
      totalEntries: aggregates.totalEntries || 0,
      totalNetReduction: round6(aggregates.totalNetReduction || 0),
      avgNetReduction: round6(aggregates.avgNetReduction || 0),
      maxNetReduction: round6(aggregates.maxNetReduction || 0),
      minNetReduction: round6(aggregates.minNetReduction || 0),
      latestCumulative: round6(aggregates.latestCumulative || 0)
    };

  } catch (error) {
    console.error('Error calculating aggregates:', error);
    return {
      totalEntries: 0,
      totalNetReduction: 0,
      avgNetReduction: 0,
      maxNetReduction: 0,
      minNetReduction: 0,
      latestCumulative: 0
    };
  }
}

function round6(n) {
  return Math.round((Number(n) || 0) * 1e6) / 1e6;
}


// --- ADD THIS EXPORT ---
/**
 * Edit a MANUAL net-reduction entry.
 * Route (suggested):
 *   PATCH /net-reduction/:clientId/:projectId/:calculationMethodology/manual/:entryId
 *
 * Body (m1):
 *   { "value": 123.45, "date": "14/08/2025", "time": "11:00", "recalcRateFromProject": false }
 * Body (m2):
 *   { "variables": { "N": 12000, "U": 0.83 }, "date": "14/08/2025", "time": "11:05" }
 */
/**
 * UPDATE a MANUAL Net-Reduction Entry (M1, M2, M3)
 *
 * Route:
 *   PATCH /api/net-reduction/:clientId/:projectId/:calculationMethodology/manual/:entryId
 *
 * Supports:
 *   - methodology1  (value-based)
 *   - methodology2  (formula variable based)
 *   - methodology3  (baseline/project/leakage structured evaluation)
 */
/**
 * UPDATE a MANUAL Net-Reduction Entry (M1, M2, M3)
 *
 * Route:
 *   PATCH /api/net-reduction/:clientId/:projectId/:calculationMethodology/manual/:entryId
 *
 * For M3:
 *   Body:
 *   {
 *     "date": "2025-04-02",
 *     "time": "11:00",
 *     "entry": {
 *       "B1": { "A": 220 },
 *       "P1": { "A": 170 }
 *     }
 *   }
 */
/**
 * UPDATE a MANUAL Net-Reduction Entry (M1, M2, M3)
 *
 * Route:
 *   PATCH /api/net-reduction/:clientId/:projectId/:calculationMethodology/manual/:entryId
 *
 * For M3:
 *   Body:
 *   {
 *     "date": "2025-04-02",
 *     "time": "11:00",
 *     "entry": {
 *       "B1": { "A": 220 },
 *       "P1": { "A": 170 }
 *     }
 *   }
 */
exports.updateManualNetReductionEntry = async (req, res) => {
  try {
    const { clientId, projectId, calculationMethodology, entryId } = req.params;

    // Permission
    const can = await canWriteReductionData(req.user, clientId);
    if (!can.ok)
      return res.status(403).json({ success: false, message: can.reason });

    // Find entry
    const entry = await NetReductionEntry.findOne({
      _id: entryId,
      clientId,
      projectId,
      calculationMethodology
    });

    if (!entry)
      return res.status(404).json({ success: false, message: "Entry not found" });

    if ((entry.inputType || "").toLowerCase() !== "manual")
      return res
        .status(400)
        .json({ success: false, message: "Only manual entries can be updated" });

    // Load reduction
    const reductionDoc = await Reduction.findOne({
      clientId,
      projectId,
      isDeleted: false
    }).select("m3 calculationMethodology reductionDataEntry");

    if (!reductionDoc)
      return res
        .status(404)
        .json({ success: false, message: "Reduction not found" });

    // Date/time update
    const hasDateOrTime = req.body.date != null || req.body.time != null;
    if (hasDateOrTime) {
      const when = parseDateTimeOrNowIST(
        req.body.date || entry.date,
        req.body.time || entry.time
      );
      entry.date = when.date;
      entry.time = when.time;
      entry.timestamp = when.timestamp;
    }

    // Only M3 here
    if (reductionDoc.calculationMethodology !== "methodology3")
      return res.status(400).json({
        success: false,
        message: "This update endpoint only supports M3"
      });

    const payload = req.body.entry;
    if (!payload || typeof payload !== "object")
      return res
        .status(400)
        .json({ success: false, message: "entry payload required" });

    // Collect formulas
    const allItems = [
      ...(reductionDoc.m3.baselineEmissions || []),
      ...(reductionDoc.m3.projectEmissions || []),
      ...(reductionDoc.m3.leakageEmissions || [])
    ];

    const formulaIds = [...new Set(allItems.map(it => it.formulaId.toString()))];
    const formulas = await ReductionFormula.find({ _id: { $in: formulaIds } });

    const formulasById = {};
    formulas.forEach(f => (formulasById[f._id.toString()] = f));

    // Evaluate M3 for THIS updated entry
    const result = await evaluateM3(reductionDoc, formulasById, payload);

    const BE_now  = Number(result.BE_total || 0);
    const PE_now  = Number(result.PE_total || 0);
    const LE_now  = Number(result.LE_total || 0);
    const Nw_now  = Number(result.netWithoutUncertainty || 0);
    const NwU_now = Number(result.netWithUncertainty || 0);

    // Get previous entry (excluding this one)
    const prev = await NetReductionEntry.findOne({
      clientId,
      projectId,
      calculationMethodology,
      _id: { $ne: entry._id }
    })
      .sort({ timestamp: -1 })
      .lean();

    const prevM3 = prev && prev.m3 ? prev.m3 : {};

    const prevCumBE  = Number(prevM3.cumulativeBE  ?? 0);
    const prevCumPE  = Number(prevM3.cumulativePE  ?? 0);
    const prevCumLE  = Number(prevM3.cumulativeLE  ?? 0);
    const prevCumNw  = Number(prevM3.cumulativeNetWithoutUncertainty ?? 0);
    const prevCumNwU = Number(prevM3.cumulativeNetWithUncertainty   ?? 0);

    // Per-item cumulative breakdown
    const breakdownWithCum = buildM3BreakdownWithCumulative(prevM3, result);

    // Build final cumulative block
    const m3Final = {
      ...result,

      cumulativeBE: round6(prevCumBE + BE_now),
      cumulativePE: round6(prevCumPE + PE_now),
      cumulativeLE: round6(prevCumLE + LE_now),

      cumulativeNetWithoutUncertainty: round6(prevCumNw + Nw_now),
      cumulativeNetWithUncertainty:   round6(prevCumNwU + NwU_now),

      breakdown: breakdownWithCum
    };

    // Save on entry
    entry.m3 = m3Final;
    entry.netReduction = NwU_now; // per-entry value

    await entry.save({ validateBeforeSave: false });

    // Recompute full series (cumulativeNetReduction / high / low)
    const series = await recomputeProjectCumulative(
      clientId,
      projectId,
      calculationMethodology
    );

    try {
      await recomputeClientNetReductionSummary(clientId);
    } catch {}

    emitNR("net-reduction:m3-manual-updated", {
      clientId,
      projectId,
      entryId: entry._id,
      m3: entry.m3,
      netReduction: entry.netReduction,
      cumulativeNetReduction: entry.cumulativeNetReduction
    });

    return res.status(200).json({
      success: true,
      message: "M3 entry updated",
      series,
      data: entry
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to update M3 entry",
      error: err.message
    });
  }
};


// --- ADD THIS EXPORT ---
/**
 * Delete a MANUAL net-reduction entry and recompute the series.
 * Route (suggested):
 *   DELETE /net-reduction/:clientId/:projectId/:calculationMethodology/manual/:entryId
 */
exports.deleteManualNetReductionEntry = async (req, res) => {
  try {
    const { clientId, projectId, calculationMethodology, entryId } = req.params;

    // permission
    const can = await canWriteReductionData(req.user, clientId);
    if (!can.ok) return res.status(403).json({ success:false, message: can.reason });

    const entry = await NetReductionEntry.findOne({ _id: entryId, clientId, projectId, calculationMethodology });
    if (!entry) return res.status(404).json({ success:false, message: 'Entry not found' });
    if ((entry.inputType || '').toLowerCase() !== 'manual') {
      return res.status(400).json({ success:false, message: 'Only manual entries can be deleted with this endpoint' });
    }

    await NetReductionEntry.deleteOne({ _id: entry._id });

    const summary = await recomputeSeries(clientId, projectId, calculationMethodology);
    try { await recomputeClientNetReductionSummary(clientId); } catch (e) { console.warn('summary recompute failed:', e.message); }
    emitNR('net-reduction:manual-deleted', { clientId, projectId, calculationMethodology, entryId });
    return res.status(200).json({
      success: true,
      message: 'Manual entry deleted and series recomputed',
      series: summary
    });
  } catch (err) {
    return res.status(500).json({ success:false, message: 'Failed to delete manual net reduction entry', error: err.message });
  }
};


// ===============================================
// 4) NEW: SWITCH INPUT TYPE for REDUCTION PROJECT
// ===============================================

/**
 * Mirrors DataCollectionController.switchInputType, but for Reduction.reductionDataEntry.
 *
 * Route you can use:
 *   PATCH /api/net-reduction/:clientId/:projectId/input-type
 * Body:
 *   {
 *     "inputType": "manual" | "API" | "IOT",
 *     "connectionDetails": {
 *       "apiEndpoint": "...", // when API
 *       "deviceId": "..."     // when IOT
 *     }
 *   }
 *
 * Logic:
 *  - Only client_admin of SAME client can change this (same as DataCollection switch).
 *  - Updates Reduction.reductionDataEntry.inputType, originalInputType,
 *    apiEndpoint, iotDeviceId.
 *  - NO effect on NetReductionEntry, just config for how future data should come in.
 */
exports.switchNetReductionInputType = async (req, res) => {
  try {
    const { clientId, projectId } = req.params;
    const { inputType: newInputType, connectionDetails } = req.body;

    // ✅ Only client_admin of the SAME client
    if (
      !req.user ||
      req.user.userType !== 'client_admin' ||
      req.user.clientId !== clientId
    ) {
      return res.status(403).json({
        message: 'Permission denied. Only Client Admin can switch reduction input types.'
      });
    }

    // ✅ Validate input type
    if (!newInputType || !['manual', 'API', 'IOT'].includes(newInputType)) {
      return res.status(400).json({ message: 'Invalid input type' });
    }

    // Load reduction project
    const reduction = await Reduction.findOne({ clientId, projectId, isDeleted: false });
    if (!reduction) {
      return res.status(404).json({ message: 'Reduction project not found' });
    }

    const r = reduction.reductionDataEntry || {};
    const oldType = r.inputType || 'manual';

    // 1) Update types
    r.originalInputType = newInputType;
    r.inputType = newInputType;

    // 2) Reset connection fields
    r.apiEndpoint = '';
    r.iotDeviceId = '';

    // 3) Apply new connection details
    if (newInputType === 'API' && connectionDetails?.apiEndpoint) {
      r.apiEndpoint = connectionDetails.apiEndpoint;
    } else if (newInputType === 'IOT' && connectionDetails?.deviceId) {
      r.iotDeviceId = connectionDetails.deviceId;
    }

    reduction.reductionDataEntry = r;
    reduction.markModified('reductionDataEntry');
    await reduction.save();

    return res.status(200).json({
      message: `Reduction input type switched from ${oldType} to ${newInputType} successfully`,
      clientId,
      projectId,
      previousType: oldType,
      newType: newInputType,
      connectionDetails: {
        apiEndpoint: r.apiEndpoint,
        deviceId: r.iotDeviceId
      }
    });
  } catch (error) {
    console.error('switchNetReductionInputType error:', error);
    return res.status(500).json({
      message: 'Failed to switch reduction input type',
      error: error.message
    });
  }
};

// ===============================================
// 5) NEW: DISCONNECT / RECONNECT SOURCE for NET REDUCTION
// ===============================================

/**
 * These mirror DataCollectionController's disconnectSource / reconnectSource
 * but work on Reduction.reductionDataEntry (API endpoint / IoT device).
 *
 * Disconnect:
 *   - For API: conceptually "gate off" the API endpoint (we just clear endpoint in config)
 *   - For IOT: same for deviceId
 *   - For MANUAL: nothing to disconnect
 *
 * Reconnect:
 *   - For API/IOT: re-assert that the config is active; here we simply require that
 *     r.apiEndpoint / r.iotDeviceId is already set; if not, you can optionally
 *     accept a body to set them, but I’ll keep it simple like DataCollection.
 */

// Helper: who can connect/disconnect for reduction?
// We reuse similar logic to checkOperationPermission's connectOps:
//   - super_admin
//   - consultant_admin who created client
//   - consultant assigned to client
//   - (OPTIONALLY) client_admin of same client (I include this for convenience)
async function canManageReductionExternalSource(user, clientId) {
  if (!user) return { allowed: false, reason: 'Invalid user context' };

  const userId = user._id || user.id;

  if (user.userType === 'super_admin') {
    return { allowed: true, reason: 'Super admin access' };
  }

  const client = await Client.findOne(
    { clientId },
    { 'leadInfo.createdBy': 1, 'leadInfo.assignedConsultantId': 1 }
  ).lean();

  if (!client) {
    return { allowed: false, reason: 'Client not found' };
  }

  const isCreatorConsultantAdmin =
    user.userType === 'consultant_admin' &&
    client.leadInfo?.createdBy &&
    client.leadInfo.createdBy.toString() === userId.toString();

  const isAssignedConsultant =
    user.userType === 'consultant' &&
    client.leadInfo?.assignedConsultantId &&
    client.leadInfo.assignedConsultantId.toString() === userId.toString();

  if (isCreatorConsultantAdmin || isAssignedConsultant) {
    return { allowed: true, reason: 'Consultant-level control' };
  }

  // OPTIONAL: let client_admin also manage connect/disconnect for their own client
  if (user.userType === 'client_admin' && user.clientId === clientId) {
    return { allowed: true, reason: 'Client admin of same client' };
  }

  return {
    allowed: false,
    reason:
      'Only Super Admin, the Consultant Admin who created the client, the assigned Consultant, ' +
      'or the Client Admin of this client can connect/disconnect reduction sources.'
  };
}

// ---------- DISCONNECT ----------
exports.disconnectNetReductionSource = async (req, res) => {
  try {
    const { clientId, projectId } = req.params;

    // 1) Permission check
    const perm = await canManageReductionExternalSource(req.user, clientId);
    if (!perm.allowed) {
      return res.status(403).json({ message: 'Permission denied', reason: perm.reason });
    }

    // 2) Load reduction project
    const reduction = await Reduction.findOne({ clientId, projectId, isDeleted: false });
    if (!reduction) {
      return res.status(404).json({ message: 'Reduction project not found' });
    }

    // 3) Work on reductionDataEntry
    const r = reduction.reductionDataEntry || {};
    const inputType = (r.inputType || 'manual').toUpperCase();

    if (inputType === 'API') {
      // ❌ DO NOT clear endpoint
      // r.apiEndpoint stays as the configured URL
      // ✅ Only mark the API as disconnected
      r.apiStatus = false;
    } else if (inputType === 'IOT') {
      // ❌ DO NOT clear device ID
      // r.iotDeviceId stays as the configured device reference
      // ✅ Only mark the IOT as disconnected
      r.iotStatus = false;
    } else {
      return res
        .status(400)
        .json({ message: 'Nothing to disconnect for MANUAL input type' });
    }

    reduction.reductionDataEntry = r;
    reduction.markModified('reductionDataEntry');
    await reduction.save();

    return res.status(200).json({
      message: 'Net reduction source disconnected successfully',
      clientId,
      projectId,
      inputType: r.inputType,
      reductionDataEntry: r
    });
  } catch (error) {
    console.error('disconnectNetReductionSource error:', error);
    return res.status(500).json({
      message: 'Failed to disconnect net reduction source',
      error: error.message
    });
  }
};


// ---------- RECONNECT ----------
exports.reconnectNetReductionSource = async (req, res) => {
  try {
    const { clientId, projectId } = req.params;

    const perm = await canManageReductionExternalSource(req.user, clientId);
    if (!perm.allowed) {
      return res.status(403).json({ message: 'Permission denied', reason: perm.reason });
    }

    const reduction = await Reduction.findOne({ clientId, projectId, isDeleted: false });
    if (!reduction) {
      return res.status(404).json({ message: 'Reduction project not found' });
    }

    const r = reduction.reductionDataEntry || {};
    const inputType = (r.inputType || 'manual').toUpperCase();

    if (inputType === 'API') {
      // Keep endpoint, but allow updating it if body contains new value
      const apiEndpoint = req.body?.apiEndpoint || r.apiEndpoint;
      if (!apiEndpoint) {
        return res.status(400).json({
          message: 'Cannot reconnect API: apiEndpoint missing'
        });
      }
      r.apiEndpoint = apiEndpoint;
      r.apiStatus = true;   // ✅ mark as connected
    } else if (inputType === 'IOT') {
      const deviceId = req.body?.deviceId || r.iotDeviceId;
      if (!deviceId) {
        return res.status(400).json({
          message: 'Cannot reconnect IOT: deviceId missing'
        });
      }
      r.iotDeviceId = deviceId;
      r.iotStatus = true;   // ✅ mark as connected
    } else {
      return res.status(200).json({
        message: 'Nothing to reconnect for MANUAL input type; left unchanged'
      });
    }

    reduction.reductionDataEntry = r;
    reduction.markModified('reductionDataEntry');
    await reduction.save();

    return res.status(200).json({
      message: 'Net reduction source reconnected successfully',
      clientId,
      projectId,
      inputType: r.inputType,
      reductionDataEntry: r
    });
  } catch (error) {
    console.error('reconnectNetReductionSource error:', error);
    return res.status(500).json({
      message: 'Failed to reconnect net reduction source',
      error: error.message
    });
  }
};

// GET /api/net-reduction
exports.listNetReductions = async (req, res) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ success: false, message: 'Unauthenticated' });

    // ----------------------------
    // 1. PERMISSION SCOPING
    // ----------------------------
    let allowedClientIds = null;

    if (user.userType === 'consultant') {
      const assigned = await Client.find({ 'leadInfo.assignedConsultantId': user.id }).select('clientId');
      allowedClientIds = assigned.map(c => c.clientId);
    }

    if (user.userType === 'consultant_admin') {
      const consultants = await User.find({ consultantAdminId: user.id }).select('_id');
      const consultantIds = consultants.map(c => c._id.toString());
      consultantIds.push(user.id);

      const clients = await Client.find({
        $or: [
          { 'leadInfo.consultantAdminId': user.id },
          { 'leadInfo.assignedConsultantId': { $in: consultantIds } }
        ]
      }).select('clientId');

      allowedClientIds = clients.map(c => c.clientId);
    }

    // ----------------------------
    // 2. BUILD FILTER
    //----------------------------
    const {
      clientId: clientIdParam,
      projectId,
      methodology,
      inputType,
      q,
      from,
      to,
      minNet,
      maxNet,
      page = 1,
      limit = 20,
      sortBy = 'timestamp',
      sortOrder = 'desc'
    } = req.query;

    const filter = {};

    // Client filter + permission enforcement
    if (clientIdParam) {
      if (allowedClientIds && !allowedClientIds.includes(clientIdParam)) {
        return res.status(403).json({ success: false, message: 'Permission denied for this clientId' });
      }
      filter.clientId = clientIdParam;
    } else if (allowedClientIds) {
      filter.clientId = { $in: allowedClientIds };
    }

    // Project filter (partial match)
    if (projectId) {
      const esc = projectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.projectId = { $regex: new RegExp(esc, 'i') };
    }

    if (methodology) filter.calculationMethodology = methodology;
    if (inputType) filter.inputType = inputType;

    // Free text search
    if (q && q.trim()) {
      const rx = { $regex: q.trim(), $options: 'i' };
      filter.$or = [{ clientId: rx }, { projectId: rx }];
    }

    // Date filtering
    const parseDate = raw => {
      if (!raw) return null;
      const m = moment(raw, ['DD/MM/YYYY','YYYY-MM-DD'], true);
      return m.isValid() ? m.toDate() : null;
    };

    const fromDate = parseDate(from);
    const toDate = parseDate(to);

    if (fromDate || toDate) {
      filter.timestamp = {};
      if (fromDate) filter.timestamp.$gte = fromDate;
      if (toDate) filter.timestamp.$lte = toDate;
    }

    // Min-max Net Reduction
    const minNR = Number(minNet);
    const maxNR = Number(maxNet);

    if (isFinite(minNR) || isFinite(maxNR)) {
      filter.netReduction = {};
      if (isFinite(minNR)) filter.netReduction.$gte = minNR;
      if (isFinite(maxNR)) filter.netReduction.$lte = maxNR;
    }

    // ----------------------------
    // 3. PAGINATION + SORTING
    // ----------------------------
    const pageNum = Math.max(1, parseInt(page));
    const limNum = Math.min(200, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limNum;

    const sort = { [sortBy]: sortOrder.toLowerCase() === 'asc' ? 1 : -1 };

    // ----------------------------
    // 4. DB QUERY
    // ----------------------------
    const [total, rows] = await Promise.all([
      NetReductionEntry.countDocuments(filter),
      NetReductionEntry.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limNum)
        .select('-__v')
        .lean()
    ]);

    // ----------------------------
    // 5. RESPONSE
    // ----------------------------
    return res.status(200).json({
      success: true,
      meta: {
        page: pageNum,
        limit: limNum,
        total,
        totalPages: Math.ceil(total / limNum),
        hasNextPage: pageNum < Math.ceil(total / limNum),
        hasPrevPage: pageNum > 1
      },
      filter,
      data: rows
    });

  } catch (err) {
    console.error('listNetReductions error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch net reductions',
      error: err.message
    });
  }
};
