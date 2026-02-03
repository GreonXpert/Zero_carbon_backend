/**
 * migration/migrate_processEmissionSummary_byScopeIdentifier.js
 *
 * Backfill:
 *   EmissionSummary.processEmissionSummary.byScopeIdentifier
 *
 * Uses:
 *   ProcessFlowchart.nodes[].details.scopeDetails[].allocationPct
 *   DataEntry scopeIdentifier + calculated emissions
 *
 * Run examples:
 *   node migration/migrate_processEmissionSummary_byScopeIdentifier.js --clientId Greon017 --onlyMissing=true --dryRun=true --debug=true
 *   node migration/migrate_processEmissionSummary_byScopeIdentifier.js --clientId Greon017 --onlyMissing=true --dryRun=false
 */

require("dotenv").config();
const mongoose = require("mongoose");

// ✅ adjust these paths if your repo differs
const EmissionSummary = require("../models/CalculationEmission/EmissionSummary");
const ProcessFlowchart = require("../models/Organization/ProcessFlowchart");
const DataEntry = require("../models/Organization/DataEntry");

// ---------------------------
// CLI args (no deps)
// ---------------------------
function readArg(name, defaultValue = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return defaultValue;
  const next = process.argv[idx + 1];
  if (!next || next.startsWith("--")) return true; // flags
  return next;
}

const CLIENT_ID = readArg("clientId", null);
const ONLY_MISSING = String(readArg("onlyMissing", "true")).toLowerCase() === "true";
const DRY_RUN = String(readArg("dryRun", "true")).toLowerCase() === "true";
const LIMIT = Number(readArg("limit", 0)) || 0;
const DEBUG = String(readArg("debug", "false")).toLowerCase() === "true";

// Optional: if you want to strictly require processed entries
const REQUIRE_PROCESSED = String(readArg("requireProcessed", "false")).toLowerCase() === "true";
const PROCESSING_STATUS = String(readArg("processingStatus", "processed"));

// ---------------------------
// Helpers
// ---------------------------
function normalizeStr(v) {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Mongo keys cannot contain '.' or '$' (and keys starting with '$' are risky).
 * We sanitize ONLY for object keys we store in byScopeIdentifier.
 * DB values (DataEntry.scopeIdentifier) can keep '.' safely.
 */
function sanitizeMapKey(key) {
  if (typeof key !== "string" || !key.trim()) return "invalid_key";
  return key.trim().replace(/[.$]/g, "_");
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function ensureEmissionShape(obj) {
  if (!obj || typeof obj !== "object") obj = {};
  obj.CO2e = toNum(obj.CO2e);
  obj.CO2 = toNum(obj.CO2);
  obj.CH4 = toNum(obj.CH4);
  obj.N2O = toNum(obj.N2O);
  obj.uncertainty = toNum(obj.uncertainty);
  return obj;
}

function addEmissionValues(target, source) {
  ensureEmissionShape(target);
  ensureEmissionShape(source);
  target.CO2e += source.CO2e;
  target.CO2 += source.CO2;
  target.CH4 += source.CH4;
  target.N2O += source.N2O;
  target.uncertainty += source.uncertainty;
}

function getEffectiveAllocationPct(scopeDetail) {
  if (scopeDetail && scopeDetail.allocationPct !== undefined && scopeDetail.allocationPct !== null) {
    const n = Number(scopeDetail.allocationPct);
    if (!Number.isFinite(n)) return 100;
    return Math.max(0, Math.min(100, n));
  }
  return 100;
}

function applyAllocation(emissionValues, allocationPct) {
  const pct = Number.isFinite(Number(allocationPct)) ? Number(allocationPct) : 100;
  const factor = pct / 100;
  return {
    CO2e: toNum(emissionValues.CO2e) * factor,
    CO2: toNum(emissionValues.CO2) * factor,
    CH4: toNum(emissionValues.CH4) * factor,
    N2O: toNum(emissionValues.N2O) * factor,
    uncertainty: toNum(emissionValues.uncertainty) * factor,
  };
}

/**
 * Robust extractor (handles multiple shapes)
 * Priority:
 *  1) calculatedEmissions.totalGHGEmission
 *  2) calculatedEmissions.incoming (Map/object)  ✅ most common in your codebase
 *  3) calculatedEmissions.cumulative (fallback)
 */
function extractEmissionValuesFromEntry(entry) {
  const ce = entry?.calculatedEmissions || {};

  // 1) totalGHGEmission shape
  if (ce?.totalGHGEmission && typeof ce.totalGHGEmission === "object") {
    const t = ce.totalGHGEmission;
    const vals = {
      CO2e: toNum(t.CO2e),
      CO2: toNum(t.CO2),
      CH4: toNum(t.CH4),
      N2O: toNum(t.N2O),
      uncertainty: toNum(t.uncertainty),
    };
    if (vals.CO2e || vals.CO2 || vals.CH4 || vals.N2O) return vals;
  }

  // helper to sum a bucket map/object (incoming/cumulative)
  const sumBucket = (bucket) => {
    const totals = { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0 };
    if (!bucket || typeof bucket !== "object") return totals;

    const keys = bucket instanceof Map ? Array.from(bucket.keys()) : Object.keys(bucket);
    for (const k of keys) {
      const item = bucket instanceof Map ? bucket.get(k) : bucket[k];
      if (!item || typeof item !== "object") continue;

      // your older code used these fallbacks
      const co2e =
        toNum(
          item.CO2e ??
            item.emission ??
            item.CO2eWithUncertainty ??
            item.emissionWithUncertainty
        );

      totals.CO2e += co2e;
      totals.CO2 += toNum(item.CO2);
      totals.CH4 += toNum(item.CH4);
      totals.N2O += toNum(item.N2O);

      // uncertainty may exist at item-level or not
      totals.uncertainty += toNum(item.uncertainty);
    }
    return totals;
  };

  // 2) incoming
  const incomingTotals = sumBucket(ce.incoming);
  if (incomingTotals.CO2e || incomingTotals.CO2 || incomingTotals.CH4 || incomingTotals.N2O) {
    return incomingTotals;
  }

  // 3) cumulative fallback (only if incoming is missing)
  const cumulativeTotals = sumBucket(ce.cumulative);
  return cumulativeTotals;
}

/**
 * Build scope index from ProcessFlowchart.
 * Supports variations: node.details OR node.data.details OR node.data
 */
function buildScopeBundle(processFlowchartDoc) {
  const indexByOriginal = new Map();   // sidOriginal -> matches[]
  const indexBySanitized = new Map();  // sanitize(sidOriginal) -> matches[]
  const allCandidates = new Set();     // union of originals + sanitized (for DB query)

  const nodes = Array.isArray(processFlowchartDoc?.nodes) ? processFlowchartDoc.nodes : [];

  let totalScopes = 0;

  for (const node of nodes) {
    const processNodeId = node?.id || null;

    const details =
      node?.details ||
      node?.data?.details ||
      node?.data ||
      {};

    const nodeMeta = {
      nodeLabel: node?.label || details?.nodeType || "Unknown Node",
      department: details?.department || "Unknown",
      location: details?.location || "Unknown",
    };

    const scopeDetails =
      (Array.isArray(details?.scopeDetails) && details.scopeDetails) ||
      (Array.isArray(node?.scopeDetails) && node.scopeDetails) ||
      [];

    for (const s of scopeDetails) {
      if (s?.isDeleted === true) continue;

      const sidOriginal = normalizeStr(s?.scopeIdentifier);
      if (!sidOriginal) continue;

      totalScopes++;

      const sidSan = sanitizeMapKey(sidOriginal);
      const allocationPct = getEffectiveAllocationPct(s);

      const match = {
        sidOriginal,
        sidSanitized: sidSan,
        processNodeId,
        allocationPct,
        nodeMeta,
        scopeMeta: {
          scopeIdentifier: sidOriginal,
          scopeType: s?.scopeType,
          categoryName: s?.categoryName,
          activity: s?.activity,
          fromOtherChart: !!s?.fromOtherChart,
        },
      };

      if (!indexByOriginal.has(sidOriginal)) indexByOriginal.set(sidOriginal, []);
      indexByOriginal.get(sidOriginal).push(match);

      if (!indexBySanitized.has(sidSan)) indexBySanitized.set(sidSan, []);
      indexBySanitized.get(sidSan).push(match);

      allCandidates.add(sidOriginal);
      allCandidates.add(sidSan);
    }
  }

  return {
    indexByOriginal,
    indexBySanitized,
    allCandidates: Array.from(allCandidates),
    stats: {
      nodeCount: nodes.length,
      scopeDetailCount: totalScopes,
      uniqueScopeIdentifiers: indexByOriginal.size,
    },
  };
}

/**
 * Finalize allocation breakdown + warnings
 */
function finalizeAllocationBreakdown(byScopeIdentifierObj, allocationWarnings = []) {
  for (const sidKey of Object.keys(byScopeIdentifierObj)) {
    const bucket = byScopeIdentifierObj[sidKey];

    let totalAllocatedPct = 0;
    const allocationsArray = [];

    const nodesObj = bucket.nodes || {};
    for (const nodeId of Object.keys(nodesObj)) {
      const nodeData = nodesObj[nodeId];
      totalAllocatedPct += toNum(nodeData.allocationPct);
      allocationsArray.push({
        nodeId,
        nodeLabel: nodeData.nodeLabel,
        department: nodeData.department,
        location: nodeData.location,
        allocationPct: toNum(nodeData.allocationPct),
        allocatedEmissions: { ...(nodeData.allocatedEmissions || {}) },
        dataPointCount: toNum(nodeData.dataPointCount),
      });
    }

    const unallocatedPct = Math.max(0, 100 - totalAllocatedPct);
    const unallocatedEmissions = applyAllocation(bucket.rawEmissions || {}, unallocatedPct);

    bucket.totalAllocatedPct = Math.round(totalAllocatedPct * 100) / 100;

    bucket.allocationBreakdown = {
      rawEmissions: { ...(bucket.rawEmissions || {}) },
      allocatedEmissions: {
        totalAllocatedPct: bucket.totalAllocatedPct,
        allocations: allocationsArray,
      },
      unallocatedEmissions: {
        unallocatedPct: Math.round(unallocatedPct * 100) / 100,
        emissions: unallocatedEmissions,
        hasUnallocated: unallocatedPct > 0.01,
      },
    };

    if (unallocatedPct > 0.01) {
      const warn = `ScopeIdentifier "${bucket.scopeIdentifier || sidKey}" has ${unallocatedPct.toFixed(
        2
      )}% unallocated emissions (CO2e=${toNum(unallocatedEmissions.CO2e).toFixed(4)})`;
      if (!allocationWarnings.includes(warn)) allocationWarnings.push(warn);
    }
  }

  return allocationWarnings;
}

/**
 * Compute processEmissionSummary.byScopeIdentifier for a given period
 */
async function computeByScopeIdentifierForPeriod({ clientId, from, to, scopeBundle }) {
  const { indexByOriginal, indexBySanitized, allCandidates } = scopeBundle;

  if (!allCandidates || allCandidates.length === 0) {
    return { byScopeIdentifier: {}, sharedScopeIdentifiers: 0, allocationWarnings: [] };
  }

  const byScopeIdentifier = {};
  const sharedScopeSet = new Set();
  const allocationWarnings = [];

  const query = {
    clientId,
    timestamp: { $gte: from, $lte: to },
    scopeIdentifier: { $in: allCandidates },
  };

  if (REQUIRE_PROCESSED) {
    query.processingStatus = PROCESSING_STATUS;
  } else {
    // Keep more inclusive by default (won't block most real data)
    query.processingStatus = { $ne: "failed" };
  }

  const entries = await DataEntry.find(query)
    .select("scopeIdentifier scopeType calculatedEmissions nodeId inputType processingStatus timestamp")
    .lean();

  if (DEBUG) {
    // Small debug (not too noisy)
    if (entries.length === 0) {
      console.log(
        `   [debug] No DataEntry matched client=${clientId} range=${from.toISOString()}..${to.toISOString()} candidates=${allCandidates.length}`
      );
    }
  }

  for (const entry of entries) {
    const sidRaw = normalizeStr(entry.scopeIdentifier);
    if (!sidRaw) continue;

    const sidSan = sanitizeMapKey(sidRaw);

    // match against flowchart (original or sanitized)
    const matches = indexByOriginal.get(sidRaw) || indexBySanitized.get(sidSan);
    if (!matches || matches.length === 0) continue;

    const rawEmissionValues = extractEmissionValuesFromEntry(entry);
    // if completely zero, skip
    if (
      !rawEmissionValues.CO2e &&
      !rawEmissionValues.CO2 &&
      !rawEmissionValues.CH4 &&
      !rawEmissionValues.N2O
    ) {
      continue;
    }

    const canonicalSidOriginal = matches[0].sidOriginal;
    const sidKeyForStorage = sanitizeMapKey(canonicalSidOriginal);

    const isShared = matches.length > 1;
    if (isShared) sharedScopeSet.add(sidKeyForStorage);

    if (!byScopeIdentifier[sidKeyForStorage]) {
      const first = matches[0];
      byScopeIdentifier[sidKeyForStorage] = {
        scopeIdentifier: canonicalSidOriginal,
        scopeType: first.scopeMeta.scopeType || entry.scopeType || "Unknown",
        categoryName: first.scopeMeta.categoryName || "Unknown Category",
        activity: first.scopeMeta.activity || canonicalSidOriginal,
        isShared,

        // allocated totals (considered emissions)
        CO2e: 0,
        CO2: 0,
        CH4: 0,
        N2O: 0,
        uncertainty: 0,

        dataPointCount: 0,

        // raw totals (100%)
        rawEmissions: { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0 },

        totalAllocatedPct: 0,
        nodes: {},
        allocationBreakdown: null,
      };
    }

    const bucket = byScopeIdentifier[sidKeyForStorage];

    // accumulate raw (100%)
    addEmissionValues(bucket.rawEmissions, rawEmissionValues);
    bucket.dataPointCount += 1;

    // apply allocation per process node match
    for (const match of matches) {
      const nodeId = match.processNodeId || `unknown-process-node::${sidKeyForStorage}`;
      const allocationPct = match.allocationPct;

      const allocated = applyAllocation(rawEmissionValues, allocationPct);
      if (
        !allocated.CO2e &&
        !allocated.CO2 &&
        !allocated.CH4 &&
        !allocated.N2O
      ) {
        continue;
      }

      // allocated (considered)
      addEmissionValues(bucket, allocated);

      if (!bucket.nodes[nodeId]) {
        bucket.nodes[nodeId] = {
          nodeLabel: match.nodeMeta.nodeLabel,
          department: match.nodeMeta.department,
          location: match.nodeMeta.location,
          allocationPct,
          allocatedEmissions: { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0 },
          dataPointCount: 0,
        };
      }

      addEmissionValues(bucket.nodes[nodeId].allocatedEmissions, allocated);
      bucket.nodes[nodeId].dataPointCount += 1;
    }
  }

  finalizeAllocationBreakdown(byScopeIdentifier, allocationWarnings);

  return {
    byScopeIdentifier,
    sharedScopeIdentifiers: sharedScopeSet.size,
    allocationWarnings,
  };
}

// ---------------------------
// Main
// ---------------------------
async function main() {
  if (!process.env.MONGO_URI) {
    throw new Error("Missing MONGO_URI in environment. Set it in .env before running.");
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ Connected to MongoDB");

  const query = {};
  if (CLIENT_ID) query.clientId = CLIENT_ID;
  if (ONLY_MISSING) query["processEmissionSummary.byScopeIdentifier"] = { $exists: false };

  console.log("Migration params:", {
    CLIENT_ID,
    ONLY_MISSING,
    DRY_RUN,
    LIMIT,
    DEBUG,
    REQUIRE_PROCESSED,
    PROCESSING_STATUS,
  });
  console.log("Query:", JSON.stringify(query));

  // Cache per clientId: { processFlow, scopeBundle }
  const clientCache = new Map();

  let processed = 0;
  let updated = 0;
  let skipped = 0;

  const cursor = EmissionSummary.find(query).sort({ _id: 1 }).lean().cursor();

  for await (const summary of cursor) {
    if (LIMIT && processed >= LIMIT) break;
    processed++;

    const clientId = summary.clientId;

    // from/to
    const from = summary?.period?.from ? new Date(summary.period.from) : null;
    const to = summary?.period?.to ? new Date(summary.period.to) : null;

    if (!from || !to || isNaN(from.valueOf()) || isNaN(to.valueOf())) {
      if (DEBUG) console.log(`⚠️  Skipping ${summary._id}: invalid from/to in period`);
      skipped++;
      continue;
    }

    // Load + cache ProcessFlowchart + scope bundle
    if (!clientCache.has(clientId)) {
      const pf = await ProcessFlowchart.findOne({ clientId, isDeleted: false })
        .sort({ version: -1, updatedAt: -1 })
        .lean();

      if (!pf) {
        clientCache.set(clientId, { processFlow: null, scopeBundle: null });
      } else {
        const scopeBundle = buildScopeBundle(pf);

        if (DEBUG) {
          const sample = scopeBundle.allCandidates.slice(0, 8);
          console.log(
            `[debug] client=${clientId} processFlow nodes=${scopeBundle.stats.nodeCount} ` +
              `scopeDetails=${scopeBundle.stats.scopeDetailCount} uniqueScopeIds=${scopeBundle.stats.uniqueScopeIdentifiers} ` +
              `candidates=${scopeBundle.allCandidates.length} sample=${JSON.stringify(sample)}`
          );
        }

        clientCache.set(clientId, { processFlow: pf, scopeBundle });
      }
    }

    const cached = clientCache.get(clientId);
    if (!cached?.processFlow || !cached?.scopeBundle) {
      if (DEBUG) console.log(`⚠️  Skipping ${summary._id}: no ProcessFlowchart/scopeBundle for ${clientId}`);
      skipped++;
      continue;
    }

    // Compute
    const result = await computeByScopeIdentifierForPeriod({
      clientId,
      from,
      to,
      scopeBundle: cached.scopeBundle,
    });

    const updateDoc = {
      "processEmissionSummary.byScopeIdentifier": result.byScopeIdentifier,
      "processEmissionSummary.metadata.allocationApplied": true,
      "processEmissionSummary.metadata.sharedScopeIdentifiers": result.sharedScopeIdentifiers,
      "processEmissionSummary.metadata.allocationWarnings": result.allocationWarnings,
      "processEmissionSummary.metadata.lastCalculated": new Date(),
    };

    const scopeCount = Object.keys(result.byScopeIdentifier || {}).length;

    if (DRY_RUN) {
      console.log(
        `🧪 DRY_RUN: would update ${summary._id} (${clientId} | ${summary.period?.type || "?"}) ` +
          `scopes=${scopeCount} shared=${result.sharedScopeIdentifiers}`
      );
      continue;
    }

   try {
  const pipelineUpdate = [
    {
      $set: {
        processEmissionSummary: { $ifNull: ["$processEmissionSummary", {}] },
      },
    },
    {
      $set: {
        "processEmissionSummary.metadata": { $ifNull: ["$processEmissionSummary.metadata", {}] },
      },
    },
    {
      $set: {
        "processEmissionSummary.byScopeIdentifier": result.byScopeIdentifier,
        "processEmissionSummary.metadata.allocationApplied": true,
        "processEmissionSummary.metadata.sharedScopeIdentifiers": result.sharedScopeIdentifiers,
        "processEmissionSummary.metadata.allocationWarnings": result.allocationWarnings,
        "processEmissionSummary.metadata.lastCalculated": new Date(),
      },
    },
  ];

  // ✅ Use native driver collection update (pipeline updates are always supported)
  await EmissionSummary.collection.updateOne({ _id: summary._id }, pipelineUpdate);

  updated++;
  if (updated % 25 === 0) console.log(`✅ Updated ${updated} documents...`);
} catch (err) {
  console.log(`❌ Failed updating _id=${summary._id} client=${clientId}: ${err.message}`);
  skipped++;
  continue;
}


    if (updated % 25 === 0) {
      console.log(`✅ Updated ${updated} documents...`);
    }
  }

  console.log("--------------------------------------------------");
  console.log(`DONE. processed=${processed} updated=${updated} skipped=${skipped}`);
  console.log("--------------------------------------------------");

  await mongoose.disconnect();
  console.log("✅ Disconnected");
}

main().catch(async (err) => {
  console.error("❌ Migration failed:", err);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
