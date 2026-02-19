// utils/ProcessEmission/createProcessEmissionDataEntry.js
// ─────────────────────────────────────────────────────────────────────────────
// After a DataEntry is saved and its emission calculation completes, call
// `createProcessEmissionDataEntry(dataEntry)`.
//
// The function will:
//  1. Look up every ProcessFlowchart node that shares the same
//     (clientId, scopeIdentifier).
//  2. For each such node, read the allocationPct from the scope detail.
//  3. Apply the allocation percentage to `calculatedEmissions.incoming` and
//     `calculatedEmissions.cumulative` from the DataEntry.
//  4. Upsert one ProcessEmissionDataEntry document per node.
//
// It also updates the ProcessEmissionSummary inside the client's EmissionSummary
// document (all-time bucket) to keep aggregated numbers current.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const ProcessFlowchart       = require('../../models/Organization/ProcessFlowchart');
const ProcessEmissionDataEntry = require('../../models/Organization/ProcessEmissionDataEntry');
const EmissionSummary        = require('../../models/CalculationEmission/EmissionSummary');

// ─── Tiny helpers ─────────────────────────────────────────────────────────────

/**
 * Convert a Mongoose Map (or plain Object) to a plain JS object.
 */
function mapToObject(mapOrObj) {
  if (!mapOrObj) return {};
  if (mapOrObj instanceof Map) {
    const out = {};
    for (const [k, v] of mapOrObj) out[k] = v;
    return out;
  }
  return mapOrObj;
}

/**
 * Multiply every numeric leaf in a gas-values object by `factor`.
 * Returns a new plain object with the same shape.
 */
function scaleGasValues(gasValues, factor) {
  if (!gasValues || typeof gasValues !== 'object') return {};
  const out = {};
  const fields = ['CO2', 'CH4', 'N2O', 'CO2e', 'emission',
                  'combinedUncertainty', 'CO2eWithUncertainty', 'emissionWithUncertainty'];
  for (const f of fields) {
    if (typeof gasValues[f] === 'number') {
      out[f] = gasValues[f] * factor;
    }
  }
  return out;
}

/**
 * Given a raw "bucket" (Map<key, gasValues>) from DataEntry.calculatedEmissions
 * and an allocationPct, return the structured AllocatedBucket object expected
 * by ProcessEmissionDataEntry.calculatedEmissions.incoming / .cumulative.
 */
function buildAllocatedBucket(rawBucket, allocationPct) {
  const factor    = allocationPct / 100;
  const bucketObj = mapToObject(rawBucket);

  const original  = {};
  const allocated = {};

  for (const [key, gasValues] of Object.entries(bucketObj)) {
    if (!gasValues || typeof gasValues !== 'object') continue;
    original[key]  = gasValues;
    allocated[key] = scaleGasValues(gasValues, factor);
  }

  return { allocationPct, original, allocated };
}

// ─── Main exported function ────────────────────────────────────────────────────

/**
 * Create / update ProcessEmissionDataEntry records after a DataEntry emission
 * calculation completes.
 *
 * @param {mongoose.Document} dataEntry  - A fully saved DataEntry document
 *                                          (must have calculatedEmissions populated).
 * @returns {Promise<void>}
 */
async function createProcessEmissionDataEntry(dataEntry) {
  try {
    // Guard: we need calculated emissions to proceed
    if (!dataEntry || !dataEntry.calculatedEmissions) return;

    const { clientId, nodeId: sourceNodeId, scopeIdentifier, calculatedEmissions } = dataEntry;

    // ── 1. Find the active ProcessFlowchart for this client ─────────────────
    const processChart = await ProcessFlowchart.findOne({
      clientId,
      isDeleted: false,
      isActive:  true
    }).lean();

    if (!processChart) return; // no process flowchart configured – skip silently

    // ── 2. Find every node whose scopeDetails contains this scopeIdentifier ──
    const matchingNodes = [];

    for (const node of (processChart.nodes || [])) {
      const scopeDetails = node?.details?.scopeDetails || [];
      for (const sd of scopeDetails) {
        if (
          sd.scopeIdentifier &&
          sd.scopeIdentifier.toLowerCase() === scopeIdentifier.toLowerCase()
        ) {
          matchingNodes.push({
            nodeId:      node.id,
            nodeLabel:   node.label,
            department:  node?.details?.department || 'Unknown',
            location:    node?.details?.location   || 'Unknown',
            allocationPct: typeof sd.allocationPct === 'number' ? sd.allocationPct : 100,
            scopeType:   sd.scopeType,
            inputType:   sd.inputType || dataEntry.inputType
          });
          break; // a node can only appear once per scope identifier
        }
      }
    }

    if (matchingNodes.length === 0) return; // this scopeIdentifier is not in any process node

    // ── 3. For each matching node, upsert a ProcessEmissionDataEntry ─────────
    const incomingRaw   = calculatedEmissions.incoming;
    const cumulativeRaw = calculatedEmissions.cumulative;

    const upsertPromises = matchingNodes.map(async (nodeInfo) => {
      const { allocationPct } = nodeInfo;

      const incomingBucket   = buildAllocatedBucket(incomingRaw,   allocationPct);
      const cumulativeBucket = buildAllocatedBucket(cumulativeRaw, allocationPct);

      // Use upsert so re-calculation of the same DataEntry doesn't create duplicates
      await ProcessEmissionDataEntry.findOneAndUpdate(
        {
          clientId,
          nodeId:            nodeInfo.nodeId,
          sourceDataEntryId: dataEntry._id
        },
        {
          $set: {
            clientId,
            nodeId:            nodeInfo.nodeId,
            sourceDataEntryId: dataEntry._id,
            scopeIdentifier,
            scopeType:         nodeInfo.scopeType  || dataEntry.scopeType,
            inputType:         nodeInfo.inputType  || dataEntry.inputType,
            date:              dataEntry.date,
            time:              dataEntry.time,
            timestamp:         dataEntry.timestamp,

            // Copy raw data for reference / auditing
            dataValues:         mapToObject(dataEntry.dataValues),
            dataEntryCumulative:dataEntry.dataEntryCumulative || {},
            cumulativeValues:   mapToObject(dataEntry.cumulativeValues),
            highData:           mapToObject(dataEntry.highData),
            lowData:            mapToObject(dataEntry.lowData),
            lastEnteredData:    mapToObject(dataEntry.lastEnteredData),

            emissionFactor:             dataEntry.emissionFactor,
            nodeType:                   dataEntry.nodeType,
            sourceDetails:              dataEntry.sourceDetails || {},
            emissionCalculationStatus:  'completed',

            // ── The allocated emissions ──────────────────────────────────────
            calculatedEmissions: {
              incoming:   incomingBucket,
              cumulative: cumulativeBucket,
              metadata:   calculatedEmissions.metadata || {}
            }
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    });

    await Promise.allSettled(upsertPromises);

    // ── 4. Update ProcessEmissionSummary inside EmissionSummary ─────────────
    await updateProcessEmissionSummary(clientId, scopeIdentifier, matchingNodes, calculatedEmissions);

  } catch (err) {
    // Never throw – this is a background enrichment step and should never
    // prevent the main DataEntry save from returning a response.
    console.error('[ProcessEmissionDataEntry] Error:', err.message);
  }
}

// ─── ProcessEmissionSummary updater ───────────────────────────────────────────

/**
 * Upsert the `processEmissionSummary` sub-document on the "all-time"
 * EmissionSummary record for this client.
 *
 * The processEmissionSummary stores per-node, per-scope allocated totals.
 *
 * @param {string}   clientId
 * @param {string}   scopeIdentifier
 * @param {Array}    matchingNodes  – nodes with { nodeId, allocationPct, … }
 * @param {object}   calculatedEmissions – from the DataEntry
 */
async function updateProcessEmissionSummary(clientId, scopeIdentifier, matchingNodes, calculatedEmissions) {
  try {
    // Fetch (or create) the all-time EmissionSummary for this client
    let summary = await EmissionSummary.findOne({
      clientId,
      'period.type': 'all-time'
    });

    if (!summary) {
      summary = new EmissionSummary({
        clientId,
        period: { type: 'all-time' }
      });
    }

    // Ensure processEmissionSummary exists
    if (!summary.processEmissionSummary) {
      summary.processEmissionSummary = {
        byNode:            {},
        byScopeIdentifier: {},
        metadata: {
          lastCalculated:   new Date(),
          allocationApplied:true
        }
      };
    }

    const pes = summary.processEmissionSummary;

    // ── Update byScopeIdentifier ─────────────────────────────────────────────
    if (!pes.byScopeIdentifier) pes.byScopeIdentifier = {};

    // Build total allocated CO2e for this scopeIdentifier across all nodes
    let totalAllocatedCO2e = 0;

    for (const nodeInfo of matchingNodes) {
      const { nodeId, nodeLabel, allocationPct } = nodeInfo;
      const factor = allocationPct / 100;

      // Sum CO2e from the incoming bucket
      let originalCO2e = 0;
      const incomingBucketObj = mapToObject(calculatedEmissions.incoming);
      for (const gasValues of Object.values(incomingBucketObj)) {
        if (gasValues && typeof gasValues === 'object') {
          originalCO2e += Number(
            gasValues.CO2e ?? gasValues.emission ?? gasValues.CO2eWithUncertainty ?? 0
          );
        }
      }
      const allocatedCO2e = originalCO2e * factor;
      totalAllocatedCO2e += allocatedCO2e;

      // ── Update byNode ──────────────────────────────────────────────────────
      if (!pes.byNode) pes.byNode = {};
      if (!pes.byNode[nodeId]) {
        pes.byNode[nodeId] = {
          nodeLabel,
          department:    nodeInfo.department,
          location:      nodeInfo.location,
          allocationPct,
          CO2e:          0,
          originalCO2e:  0,
          dataPointCount:0
        };
      }
      pes.byNode[nodeId].CO2e          = (pes.byNode[nodeId].CO2e          || 0) + allocatedCO2e;
      pes.byNode[nodeId].originalCO2e  = (pes.byNode[nodeId].originalCO2e  || 0) + originalCO2e;
      pes.byNode[nodeId].dataPointCount= (pes.byNode[nodeId].dataPointCount || 0) + 1;
      pes.byNode[nodeId].allocationPct = allocationPct; // always keep current
      pes.byNode[nodeId].lastUpdatedAt = new Date();

      // ── byScopeIdentifier → nodes ─────────────────────────────────────────
      if (!pes.byScopeIdentifier[scopeIdentifier]) {
        pes.byScopeIdentifier[scopeIdentifier] = {
          scopeType:     nodeInfo.scopeType,
          CO2e:          0,
          dataPointCount:0,
          nodes:         {}
        };
      }
      const siEntry = pes.byScopeIdentifier[scopeIdentifier];
      if (!siEntry.nodes) siEntry.nodes = {};
      if (!siEntry.nodes[nodeId]) {
        siEntry.nodes[nodeId] = { nodeLabel, allocationPct, CO2e: 0 };
      }
      siEntry.nodes[nodeId].CO2e         = (siEntry.nodes[nodeId].CO2e || 0) + allocatedCO2e;
      siEntry.nodes[nodeId].allocationPct = allocationPct;
    }

    // Accumulate scope-level totals
    if (pes.byScopeIdentifier[scopeIdentifier]) {
      pes.byScopeIdentifier[scopeIdentifier].CO2e =
        (pes.byScopeIdentifier[scopeIdentifier].CO2e || 0) + totalAllocatedCO2e;
      pes.byScopeIdentifier[scopeIdentifier].dataPointCount =
        (pes.byScopeIdentifier[scopeIdentifier].dataPointCount || 0) + 1;
    }

    // ── Update metadata ──────────────────────────────────────────────────────
    if (!pes.metadata) pes.metadata = {};
    pes.metadata.lastCalculated    = new Date();
    pes.metadata.allocationApplied = true;

    // Mark the path as modified so Mongoose saves nested objects
    summary.markModified('processEmissionSummary');

    await summary.save();
  } catch (err) {
    console.error('[ProcessEmissionSummary] Update error:', err.message);
  }
}

module.exports = { createProcessEmissionDataEntry };