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
const EmissionSummary = require("../../models/CalculationEmission/EmissionSummary");
const NetReductionEntry = require("../../models/Reduction/NetReductionEntry");
const Reduction = require("../../models/Reduction/Reduction");
const Client = require("../../models/Client");

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
//  CORE REDUCTION SUMMARIZER — SAME LOGIC AS YOUR CURRENT ALL-TIME
// ===================================================================
function computeSummary(entries, projectMeta) {
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

    // for grouping:
    const projectId = e.projectId;
    const projectName = meta.projectName || e.projectId;
    const projectActivity = meta.projectActivity || "Unknown";
    const category = meta.category || "Unknown";
    const scope = meta.scope || "Unknown";
    const location =
      meta.location?.place ||
      meta.location?.address ||
      (meta.location?.latitude && meta.location?.longitude
        ? `${meta.location.latitude},${meta.location.longitude}`
        : "Unknown");

    const methodology = meta.calculationMethodology || "unknown";

    // --- byProject ---
    if (!projectMap.has(projectId)) {
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
      summary.byProjectActivity[projectActivity] = {
        totalNetReduction: 0,
        entriesCount: 0,
      };
    summary.byProjectActivity[projectActivity].totalNetReduction += net;
    summary.byProjectActivity[projectActivity].entriesCount++;

    // --- METHODOLOGY ---
    if (!summary.byMethodology[methodology])
      summary.byMethodology[methodology] = {
        totalNetReduction: 0,
        entriesCount: 0,
      };
    summary.byMethodology[methodology].totalNetReduction += net;
    summary.byMethodology[methodology].entriesCount++;
  }

  summary.byProject = [...projectMap.values()];
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
    return {
      reductionSummary: {
        totalNetReduction: 0,
        entriesCount: 0,
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
      "projectId projectName projectActivity category scope location calculationMethodology"
    )
    .lean();

  const projectMeta = new Map();
  projects.forEach((p) => projectMeta.set(p.projectId, p));

  return {
    reductionSummary: computeSummary(entries, projectMeta),
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
async function recomputeClientNetReductionSummary(clientId) {
  if (!clientId) return null;

  const now = moment.utc();
  const y = now.year();
  const m = now.month() + 1;
  const d = now.date();
  const w = now.isoWeek();

  const periods = [
    { type: "daily", year: y, month: m, day: d },
    { type: "weekly", year: y, week: w },
    { type: "monthly", year: y, month: m },
    { type: "yearly", year: y },
    { type: "all-time" },
  ];

  for (const p of periods) {
    const { type } = p;
    const summary = await calculatePeriodSummary(
      clientId,
      type,
      p.year,
      p.month,
      p.week,
      p.day
    );

    await saveIntoEmissionSummary(clientId, type, p, summary.reductionSummary);

    emitNRS("net-reduction-summary-updated", {
      clientId,
      periodType: type,
      summary: summary.reductionSummary,
    });
  }

  return true;
}

// EXPORT
module.exports = {
  recomputeClientNetReductionSummary,
};
