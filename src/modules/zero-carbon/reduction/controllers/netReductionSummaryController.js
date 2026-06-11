/**
 * controllers/Reduction/netReductionSummaryController.js
 * ------------------------------------------------------
 * OPTION A IMPLEMENTATION
 *
 * Stores reductionSummary INSIDE EmissionSummary, for:
 * daily, weekly, monthly, yearly, all-time
 *
 * Mirrors the exact behavior of Emission Summary system.
 */

const moment = require("moment");
const EmissionSummary = require("../../calculation/EmissionSummary");
const NetReductionEntry = require("../models/NetReductionEntry");
const Reduction = require("../models/Reduction");
const Client = require("../../../client-management/client/Client");

// ✅ NEW: calculationSummary builder (adds advanced analytics)
const {
  buildReductionCalculationSummary,
} = require("../services/reductionSummaryCalculationService");

// -------- SOCKET EMIT SETUP ----------
let io;
exports.setSocketIO = (socketIO) => { io = socketIO; };

function emitNRS(eventType, payload) {
  if (!io || !payload?.clientId) return;
  const data = { timestamp: new Date().toISOString(), ...payload };
  io.to(`summaries-${payload.clientId}`).emit(eventType, data);
}

// ---------- HELPER: ROUND ----------
function round6(n) {
  return Math.round((Number(n) || 0) * 1e6) / 1e6;
}

// ---------- BUILD DATE RANGE (SAME AS EMISSION SUMMARY) ----------
function buildDateRange(periodType, year, month, week, day) {
  const now = moment.utc();

  let from, to;
  switch (periodType) {
    case "daily":
      from = moment.utc({ year, month: month - 1, day }).startOf("day").toDate();
      to = moment.utc(from).endOf("day").toDate();
      break;

    case "weekly":
      from = moment.utc({ year, week }).startOf("isoWeek").toDate();
      to = moment.utc(from).endOf("isoWeek").toDate();
      break;

    case "monthly":
      from = moment.utc({ year, month: month - 1 }).startOf("month").toDate();
      to = moment.utc(from).endOf("month").toDate();
      break;

    case "yearly":
      from = moment.utc({ year }).startOf("year").toDate();
      to = moment.utc(from).endOf("year").toDate();
      break;

    case "all-time":
    default:
      from = new Date(Date.UTC(2000, 0, 1));
      to = new Date();
  }
  return { from, to };
}

// ===================================================================
//  METHODOLOGY HANDLER MAP
//  Adding a new methodology = add one entry here. computeSummary()
//  loop never needs touching.
// ===================================================================
const METHODOLOGY_HANDLERS = {
  methodology1: {
    initSummary: () => ({
      // project-level design values (BE/PE/LE from Reduction.m1)
      totalBE: 0,
      totalPE: 0,
      totalLE: 0,
      // entry-level actuals
      totalInputValue: 0,
      totalNetReduction: 0,
      _rateSum: 0,           // internal accumulator; deleted before returning
      avgEmissionReductionRate: 0,
      entriesCount: 0,
      byCategory: {},
    }),
    initProjectFields: () => ({
      // project-level design values (set once from Reduction.m1 after entry loop)
      projectBE: 0,
      projectPE: 0,
      projectLE: 0,
      // entry-level accumulators
      totalInputValue: 0,
      totalEmissionReductionRate: 0, // sum; divide by entriesCount for avg
    }),
    accumulate(acc, entry, category, pRow) {
      const iv   = Number(entry.inputValue || 0);
      const rate = Number(entry.emissionReductionRate || 0);
      const net  = Number(entry.netReduction || 0);
      acc.totalInputValue  = round6(acc.totalInputValue  + iv);
      acc.totalNetReduction = round6(acc.totalNetReduction + net);
      acc._rateSum         += rate;
      acc.entriesCount++;
      if (pRow) {
        pRow.totalInputValue           = round6(pRow.totalInputValue + iv);
        pRow.totalEmissionReductionRate = round6(pRow.totalEmissionReductionRate + rate);
      }
      if (!acc.byCategory[category])
        acc.byCategory[category] = { totalBE: 0, totalPE: 0, totalLE: 0, totalInputValue: 0, totalNetReduction: 0, entriesCount: 0 };
      acc.byCategory[category].totalInputValue   = round6(acc.byCategory[category].totalInputValue   + iv);
      acc.byCategory[category].totalNetReduction = round6(acc.byCategory[category].totalNetReduction + net);
      acc.byCategory[category].entriesCount++;
    },
    // Called once per project (not per entry) to add project-level BE/PE/LE
    accumulateProjectLevel(acc, meta, pRow, category) {
      const be = Number(meta.m1?.BE || 0);
      const pe = Number(meta.m1?.PE || 0);
      const le = Number(meta.m1?.LE || 0);
      acc.totalBE = round6(acc.totalBE + be);
      acc.totalPE = round6(acc.totalPE + pe);
      acc.totalLE = round6(acc.totalLE + le);
      if (pRow) { pRow.projectBE = be; pRow.projectPE = pe; pRow.projectLE = le; }
      if (category) {
        if (!acc.byCategory[category])
          acc.byCategory[category] = { totalBE: 0, totalPE: 0, totalLE: 0, totalInputValue: 0, totalNetReduction: 0, entriesCount: 0 };
        acc.byCategory[category].totalBE = round6(acc.byCategory[category].totalBE + be);
        acc.byCategory[category].totalPE = round6(acc.byCategory[category].totalPE + pe);
        acc.byCategory[category].totalLE = round6(acc.byCategory[category].totalLE + le);
      }
    },
    finalize(acc) {
      acc.avgEmissionReductionRate = acc.entriesCount
        ? round6(acc._rateSum / acc.entriesCount) : 0;
      delete acc._rateSum;
    },
  },

  methodology2: {
    initSummary: () => ({
      // project-level leakage (from Reduction.m2.LE)
      totalLE: 0,
      // entry-level actuals
      totalNetReduction: 0,
      totalNetReductionInFormula: 0,
      entriesCount: 0,
      byFormula: {},
      byCategory: {},
    }),
    initProjectFields: () => ({
      // project-level leakage (set once from Reduction.m2 after entry loop)
      projectLE: 0,
      // entry-level accumulators
      totalNetReductionInFormula: 0,
      formulaId: null, // captured from first entry for this project
    }),
    accumulate(acc, entry, category, pRow) {
      const net    = Number(entry.netReduction || 0);
      const inForm = Number(entry.netReductionInFormula || 0);
      const fid    = String(entry.formulaId || 'unknown');
      acc.totalNetReduction          = round6(acc.totalNetReduction          + net);
      acc.totalNetReductionInFormula = round6(acc.totalNetReductionInFormula + inForm);
      acc.entriesCount++;
      if (pRow) {
        pRow.totalNetReductionInFormula = round6(pRow.totalNetReductionInFormula + inForm);
        if (!pRow.formulaId) pRow.formulaId = fid;
      }
      if (!acc.byFormula[fid])
        acc.byFormula[fid] = { totalNetReduction: 0, totalNetReductionInFormula: 0, entriesCount: 0 };
      acc.byFormula[fid].totalNetReduction          = round6(acc.byFormula[fid].totalNetReduction          + net);
      acc.byFormula[fid].totalNetReductionInFormula = round6(acc.byFormula[fid].totalNetReductionInFormula + inForm);
      acc.byFormula[fid].entriesCount++;
      if (!acc.byCategory[category])
        acc.byCategory[category] = { totalLE: 0, totalNetReduction: 0, entriesCount: 0 };
      acc.byCategory[category].totalNetReduction = round6(acc.byCategory[category].totalNetReduction + net);
      acc.byCategory[category].entriesCount++;
    },
    // Called once per project to add project-level LE from Reduction.m2
    accumulateProjectLevel(acc, meta, pRow, category) {
      const le = Number(meta.m2?.LE || 0);
      acc.totalLE = round6(acc.totalLE + le);
      if (pRow) pRow.projectLE = le;
      if (category) {
        if (!acc.byCategory[category])
          acc.byCategory[category] = { totalLE: 0, totalNetReduction: 0, entriesCount: 0 };
        acc.byCategory[category].totalLE = round6(acc.byCategory[category].totalLE + le);
      }
    },
    finalize(_acc) {},
  },

  methodology3: {
    initSummary: () => ({
      totalBE: 0,
      totalPE: 0,
      totalLE: 0,
      totalNetWithoutUncertainty: 0,
      totalNetWithUncertainty: 0,
      entriesCount: 0,
      byCategory: {},
    }),
    initProjectFields: () => ({
      totalBE: 0,
      totalPE: 0,
      totalLE: 0,
    }),
    accumulate(acc, entry, category, pRow) {
      if (!entry.m3) return;
      const be   = Number(entry.m3.BE_total || 0);
      const pe   = Number(entry.m3.PE_total || 0);
      const le   = Number(entry.m3.LE_total || 0);
      const nwou = Number(entry.m3.netWithoutUncertainty || 0);
      const nwu  = Number(entry.m3.netWithUncertainty    || 0);
      acc.totalBE                    = round6(acc.totalBE + be);
      acc.totalPE                    = round6(acc.totalPE + pe);
      acc.totalLE                    = round6(acc.totalLE + le);
      acc.totalNetWithoutUncertainty = round6(acc.totalNetWithoutUncertainty + nwou);
      acc.totalNetWithUncertainty    = round6(acc.totalNetWithUncertainty    + nwu);
      acc.entriesCount++;
      if (pRow) {
        pRow.totalBE = round6(pRow.totalBE + be);
        pRow.totalPE = round6(pRow.totalPE + pe);
        pRow.totalLE = round6(pRow.totalLE + le);
      }
      if (!acc.byCategory[category])
        acc.byCategory[category] = { totalBE: 0, totalPE: 0, totalLE: 0, entriesCount: 0 };
      acc.byCategory[category].totalBE = round6(acc.byCategory[category].totalBE + be);
      acc.byCategory[category].totalPE = round6(acc.byCategory[category].totalPE + pe);
      acc.byCategory[category].totalLE = round6(acc.byCategory[category].totalLE + le);
      acc.byCategory[category].entriesCount++;
    },
    finalize(_acc) {},
  },
};

// Build the zero-state for all methodology summaries (used in empty-period defaults)
function buildEmptyMethodologySummaries() {
  const out = {};
  for (const [key, h] of Object.entries(METHODOLOGY_HANDLERS)) {
    out[key] = h.initSummary();
    h.finalize(out[key]);
  }
  return out;
}

// ===================================================================
//  CORE REDUCTION SUMMARIZER — SAME LOGIC AS YOUR CURRENT ALL-TIME
// ===================================================================
function computeSummary(entries, projectMeta) {
  // Initialise per-methodology accumulators
  const methodologySummaries = {};
  for (const [key, h] of Object.entries(METHODOLOGY_HANDLERS)) {
    methodologySummaries[key] = h.initSummary();
  }

  const summary = {
    totalNetReduction: 0,
    entriesCount: entries.length,
    byProject: [],
    byCategory: {},
    byScope: {},
    byLocation: {},
    byProjectActivity: {},
    byMethodology: {},
  };

  const projectMap = new Map();

  for (const e of entries) {
    const net = Number(e.netReduction || 0);
    summary.totalNetReduction = round6(summary.totalNetReduction + net);

    const meta = projectMeta.get(e.projectId) || {};

    const projectId      = e.projectId;
    const projectName    = meta.projectName    || e.projectId;
    const projectActivity = meta.projectActivity || "Unknown";
    const category       = meta.category       || "Unknown";
    const scope          = meta.scope          || "Unknown";
    const location       =
      meta.location?.place ||
      meta.location?.address ||
      (meta.location?.latitude && meta.location?.longitude
        ? `${meta.location.latitude},${meta.location.longitude}`
        : "Unknown");
    const methodology    = meta.calculationMethodology || "unknown";

    // --- byProject ---
    if (!projectMap.has(projectId)) {
      const handler = METHODOLOGY_HANDLERS[methodology];
      projectMap.set(projectId, {
        projectId,
        projectName,
        projectActivity,
        category,
        scope,
        location,
        methodology,
        totalNetReduction: 0,
        entriesCount: 0,
        // Methodology-specific per-project fields for filterReductionSummary recomputation
        ...(handler ? handler.initProjectFields() : {}),
      });
    }
    const row = projectMap.get(projectId);
    row.totalNetReduction = round6(row.totalNetReduction + net);
    row.entriesCount++;

    // --- CATEGORY ---
    if (!summary.byCategory[category])
      summary.byCategory[category] = { totalNetReduction: 0, entriesCount: 0 };
    summary.byCategory[category].totalNetReduction += net;
    summary.byCategory[category].entriesCount++;

    // --- SCOPE ---
    if (!summary.byScope[scope])
      summary.byScope[scope] = { totalNetReduction: 0, entriesCount: 0 };
    summary.byScope[scope].totalNetReduction += net;
    summary.byScope[scope].entriesCount++;

    // --- LOCATION ---
    if (!summary.byLocation[location])
      summary.byLocation[location] = { totalNetReduction: 0, entriesCount: 0 };
    summary.byLocation[location].totalNetReduction += net;
    summary.byLocation[location].entriesCount++;

    // --- PROJECT ACTIVITY ---
    if (!summary.byProjectActivity[projectActivity])
      summary.byProjectActivity[projectActivity] = { totalNetReduction: 0, entriesCount: 0 };
    summary.byProjectActivity[projectActivity].totalNetReduction += net;
    summary.byProjectActivity[projectActivity].entriesCount++;

    // --- METHODOLOGY ---
    if (!summary.byMethodology[methodology])
      summary.byMethodology[methodology] = { totalNetReduction: 0, entriesCount: 0 };
    summary.byMethodology[methodology].totalNetReduction += net;
    summary.byMethodology[methodology].entriesCount++;

    // --- METHODOLOGY-SPECIFIC ACCUMULATION ---
    const handler = METHODOLOGY_HANDLERS[e.calculationMethodology];
    if (handler) {
      handler.accumulate(
        methodologySummaries[e.calculationMethodology],
        e,
        category,
        projectMap.get(projectId)
      );
    }
  }

  // Project-level pass — add design-time BE/PE/LE from Reduction doc (m1, m2)
  // These are defined once when the project is created, not per entry.
  for (const [projectId, row] of projectMap) {
    const meta    = projectMeta.get(projectId) || {};
    const handler = METHODOLOGY_HANDLERS[row.methodology];
    if (handler?.accumulateProjectLevel) {
      handler.accumulateProjectLevel(
        methodologySummaries[row.methodology],
        meta,
        row,
        row.category
      );
    }
  }

  // Finalize each methodology summary (e.g. compute averages)
  for (const [key, h] of Object.entries(METHODOLOGY_HANDLERS)) {
    h.finalize(methodologySummaries[key]);
  }

  summary.byProject  = [...projectMap.values()];
  summary.m1Summary  = methodologySummaries.methodology1;
  summary.m2Summary  = methodologySummaries.methodology2;
  summary.m3Summary  = methodologySummaries.methodology3; // backward-compat alias
  return summary;
}

// ===================================================================
//   MASTER: CALCULATE ONE PERIOD
// ===================================================================
async function calculatePeriodSummary(clientId, periodType, year, month, week, day) {
  const { from, to } = buildDateRange(periodType, year, month, week, day);

  const entries = await NetReductionEntry.find({
    clientId,
    timestamp: { $gte: from, $lte: to },
  }).lean();

  if (!entries.length) {
    const calculationSummary = await buildReductionCalculationSummary({
      clientId, periodType, from, to,
    });
    const empty = buildEmptyMethodologySummaries();
    return {
      reductionSummary: {
        totalNetReduction: 0,
        entriesCount: 0,
        m1Summary: empty.methodology1,
        m2Summary: empty.methodology2,
        m3Summary: empty.methodology3,
        calculationSummary,
        byProject: [],
        byCategory: {},
        byScope: {},
        byLocation: {},
        byProjectActivity: {},
        byMethodology: {},
      },
    };
  }

  // load metadata for grouping
  const projectIds = [...new Set(entries.map((e) => e.projectId))];
  const projects = await Reduction.find({
    clientId,
    projectId: { $in: projectIds },
  })
    .select(
      "projectId projectName projectActivity category scope location calculationMethodology m1 m2"
    )
    .lean();

  const projectMeta = new Map();
  projects.forEach((p) => projectMeta.set(p.projectId, p));

  const base = computeSummary(entries, projectMeta);

  // ✅ Attach new calculationSummary (extra dashboard analytics)
  base.calculationSummary = await buildReductionCalculationSummary({
    clientId,
    periodType,
    from,
    to,
  });

  return {
    reductionSummary: base,
  };
}

// ===================================================================
//   SAVE INTO EMISSION SUMMARY (PERIOD DOCUMENT)
// ===================================================================
async function saveIntoEmissionSummary(clientId, periodType, periodData, reductionSummary) {
  await EmissionSummary.findOneAndUpdate(
    {
      clientId,
      "period.type": periodType,
      ...(periodType === "daily" && { "period.year": periodData.year, "period.month": periodData.month, "period.day": periodData.day }),
      ...(periodType === "weekly" && { "period.year": periodData.year, "period.week": periodData.week }),
      ...(periodType === "monthly" && { "period.year": periodData.year, "period.month": periodData.month }),
      ...(periodType === "yearly" && { "period.year": periodData.year }),
    },
    {
      $set: {
        reductionSummary,
        "metadata.hasReductionSummary": true,
        "metadata.lastReductionSummaryCalculatedAt": new Date(),
      },
    },
    { upsert: true, new: true }
  );
}

// ===================================================================
//   UPDATE ALL PERIODS (CALL THIS AFTER EVERY ENTRY SAVE)
// ===================================================================
async function recomputeClientNetReductionSummary(clientId, opts = {}) {
  if (!clientId) return null;

  // ✅ Accept timestamps coming from CSV/multi-date uploads
  const incoming = Array.isArray(opts.timestamps) ? opts.timestamps : [];
  const tsList = incoming
    .map(t => new Date(t))
    .filter(d => !isNaN(d.getTime()));

  // fallback to old behavior
  const baseMoments = tsList.length
    ? tsList.map(d => moment.utc(d))
    : [moment.utc()];

  const dailySet = new Set();
  const weeklySet = new Set();
  const monthlySet = new Set();
  const yearlySet = new Set();

  for (const m of baseMoments) {
    const y = m.year();
    const mo = m.month() + 1;
    const d = m.date();
    const w = m.isoWeek();
    const wy = m.isoWeekYear();

    dailySet.add(`${y}-${mo}-${d}`);
    weeklySet.add(`${wy}-${w}`);
    monthlySet.add(`${y}-${mo}`);
    yearlySet.add(`${y}`);
  }

  const periods = [];

  for (const key of dailySet) {
    const [year, month, day] = key.split("-").map(Number);
    periods.push({ type: "daily", year, month, day });
  }

  for (const key of weeklySet) {
    const [year, week] = key.split("-").map(Number);
    periods.push({ type: "weekly", year, week });
  }

  for (const key of monthlySet) {
    const [year, month] = key.split("-").map(Number);
    periods.push({ type: "monthly", year, month });
  }

  for (const key of yearlySet) {
    const [year] = key.split("-").map(Number);
    periods.push({ type: "yearly", year });
  }

  // ✅ Always refresh all-time once
  periods.push({ type: "all-time" });

  // recompute each affected period
  try {
    for (const p of periods) {
      const summary = await calculatePeriodSummary(
        clientId,
        p.type,
        p.year,
        p.month,
        p.week,
        p.day
      );

      await saveIntoEmissionSummary(clientId, p.type, p, summary.reductionSummary);

      emitNRS("net-reduction-summary-updated", {
        clientId,
        periodType: p.type,
        summary: summary.reductionSummary,
      });
    }

    // BUG 14 FIX: Clear retry flag on success so maintenance job won't re-run this client.
    const SummaryNetReduction = require('../models/SummaryNetReduction');
    await SummaryNetReduction.updateOne(
      { clientId },
      { $set: { needsRecalculation: false } }
    ).catch(() => {}); // non-fatal

    return true;
  } catch (err) {
    // BUG 14 FIX: Flag this client for retry by the hourly maintenance job.
    try {
      const SummaryNetReduction = require('../models/SummaryNetReduction');
      await SummaryNetReduction.updateOne(
        { clientId },
        { $set: { needsRecalculation: true } },
        { upsert: false }
      );
    } catch (_) { /* silent — don't mask original error */ }
    throw err;
  }
}

// ===================================================================
//   BACKFILL: Recalculate ALL historical periods for a client
//   Call once after schema change to populate totalBE/PE/LE in byProject
// ===================================================================
async function backfillAllReductionPeriods(clientId) {
  if (!clientId) throw new Error('clientId required');

  // Find every distinct year that has NetReductionEntry data for this client
  const yearDocs = await NetReductionEntry.aggregate([
    { $match: { clientId } },
    { $group: { _id: { $year: '$timestamp' } } },
    { $sort: { _id: 1 } },
  ]);

  if (!yearDocs.length) {
    console.log(`[backfill] No reduction entries found for client ${clientId}`);
    return { recalculated: [] };
  }

  const years = yearDocs.map(d => d._id);
  console.log(`[backfill] client=${clientId} years=${years.join(', ')}`);

  const recalculated = [];

  for (const year of years) {
    // Recalculate yearly period
    const yearlySummary = await calculatePeriodSummary(clientId, 'yearly', year);
    await saveIntoEmissionSummary(clientId, 'yearly', { year }, yearlySummary.reductionSummary);
    recalculated.push(`yearly-${year}`);

    // Recalculate each month within this year that has data
    const monthDocs = await NetReductionEntry.aggregate([
      { $match: { clientId, $expr: { $eq: [{ $year: '$timestamp' }, year] } } },
      { $group: { _id: { $month: '$timestamp' } } },
      { $sort: { _id: 1 } },
    ]);

    for (const md of monthDocs) {
      const month = md._id;
      const monthlySummary = await calculatePeriodSummary(clientId, 'monthly', year, month);
      await saveIntoEmissionSummary(clientId, 'monthly', { year, month }, monthlySummary.reductionSummary);
      recalculated.push(`monthly-${year}-${month}`);
    }
  }

  // Always refresh all-time
  const allTimeSummary = await calculatePeriodSummary(clientId, 'all-time');
  await saveIntoEmissionSummary(clientId, 'all-time', {}, allTimeSummary.reductionSummary);
  recalculated.push('all-time');

  console.log(`[backfill] Done for client=${clientId}. Periods updated: ${recalculated.length}`);
  return { recalculated };
}

// ===================================================================
//   MIGRATE ALL CLIENTS — for HTTP /backfill-all and the CLI script
// ===================================================================
async function recomputeAllClientsReductionSummary() {
  const clientDocs = await NetReductionEntry.aggregate([
    { $group: { _id: '$clientId' } },
    { $sort:  { _id: 1 } },
  ]);

  if (!clientDocs.length) {
    return { succeeded: 0, failed: 0, clients: [] };
  }

  const clients = clientDocs.map(d => d._id);
  const results = { succeeded: 0, failed: 0, clients: [] };

  for (const clientId of clients) {
    try {
      const r = await backfillAllReductionPeriods(clientId);
      results.succeeded++;
      results.clients.push({ clientId, status: 'ok', periodsUpdated: r.recalculated.length });
    } catch (err) {
      results.failed++;
      results.clients.push({ clientId, status: 'error', message: err.message });
      console.error(`[backfill-all] ${clientId}: ${err.message}`);
    }
  }

  return results;
}

// EXPORT
module.exports = {
  recomputeClientNetReductionSummary,
  backfillAllReductionPeriods,
  recomputeAllClientsReductionSummary,
};
