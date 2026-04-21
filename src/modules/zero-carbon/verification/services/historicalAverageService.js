// services/verification/historicalAverageService.js
const DataEntry = require("../../organization/models/DataEntry");
const NetReductionEntry = require("../../reduction/models/NetReductionEntry");
const DataCollectionConfig = require("../../organization/models/DataCollectionConfig");
const { normalizeToDailyValue } = require("./normalizationService");
const { decrypt } = require("../../../../common/utils/encryptionUtil");

/**
 * Resolves the collection frequency for a DataEntry stream.
 * Queries DataCollectionConfig; falls back to 'monthly'.
 *
 * @param {string} clientId
 * @param {string} nodeId
 * @param {string} scopeIdentifier
 * @returns {Promise<string>}
 */
async function getDataEntryFrequency(clientId, nodeId, scopeIdentifier) {
  try {
    const config = await DataCollectionConfig.findOne({
      clientId,
      nodeId,
      scopeIdentifier
    })
      .select("collectionFrequency")
      .lean();

    return config?.collectionFrequency || "monthly";
  } catch {
    return "monthly";
  }
}

/**
 * Computes the raw value for a DataEntry record.
 * Uses the sum of all values in the dataValues Map (matches the
 * dataEntryCumulative.incomingTotalValue pattern used in the project).
 *
 * @param {object} entry - Lean DataEntry document
 * @returns {number}
 */
function resolveDataEntryRawValue(entry) {
  if (!entry.dataValues) return 0;

  let total = 0;
  const values = entry.dataValues;

  // 🔐 CRITICAL: Detect if dataValues is still encrypted (should have been decrypted)
  if (typeof values === "string" && values.startsWith("v1:")) {
    console.error(`❌ [resolveDataEntryRawValue] Entry ${entry._id} still has encrypted dataValues! Decryption must have failed.`);
    return 0;
  }

  // dataValues is a Mongoose Map – when .lean() is used it becomes a plain object
  if (values instanceof Map) {
    for (const v of values.values()) {
      const n = Number(v);
      if (isFinite(n)) total += n;
    }
  } else if (typeof values === "object") {
    for (const v of Object.values(values)) {
      const n = Number(v);
      if (isFinite(n)) total += n;
    }
  }

  // Debug: log if total is 0 (might indicate encrypted or unparsed data)
  if (total === 0 && entry.dataValues && typeof entry.dataValues === "object") {
    console.warn(`⚠️ [resolveDataEntryRawValue] Entry ${entry._id} has dataValues but resolved to 0. Type: ${typeof entry.dataValues}, Keys: ${Object.keys(entry.dataValues).slice(0, 3).join(',')}`);
  }

  return total;
}

/**
 * Fetches approved historical DataEntry records for the given stream and
 * computes the daily-normalized average.
 *
 * Returns null when there is insufficient data (< minSamples) or when the
 * computed average is 0 (would cause division-by-zero in caller).
 *
 * @param {object} params
 * @param {string} params.clientId
 * @param {string} params.nodeId
 * @param {string} params.scopeIdentifier
 * @param {number} params.sampleSize   - How many recent records to fetch
 * @param {number} [params.minSamples] - Minimum required (default 3)
 * @returns {Promise<{average: number, sampleCount: number, frequency: string} | null>}
 */
async function getDataEntryHistoricalAverage({
  clientId,
  nodeId,
  scopeIdentifier,
  sampleSize = 10,
  minSamples = 3
}) {
  const frequency = await getDataEntryFrequency(clientId, nodeId, scopeIdentifier);

  const entries = await DataEntry.find({
    clientId,
    nodeId,
    scopeIdentifier,
    approvalStatus: { $in: ["auto_approved", "approved"] },
    isSummary: false
  })
    .sort({ timestamp: -1 })
    .limit(sampleSize)
    .select("dataValues _id")
    .lean();

  if (!entries || entries.length < minSamples) {
    console.log(`  [historicalAverageService] Found ${entries?.length || 0} entries, need ${minSamples}+ → returning null`);
    return null;
  }

  // 🔐 CRITICAL FIX: Explicitly decrypt dataValues since .lean() may skip post('find') hook
  const decryptedEntries = entries.map(e => {
    if (e.dataValues && typeof e.dataValues === 'string') {
      try {
        return { ...e, dataValues: decrypt(e.dataValues) };
      } catch (err) {
        console.error(`❌ [historicalAverageService] Decryption failed for entry ${e._id}:`, err.message);
        return { ...e, dataValues: null };
      }
    }
    return e;
  });

  const dailyValues = decryptedEntries.map(e => {
    const raw = resolveDataEntryRawValue(e);
    return normalizeToDailyValue(raw, frequency);
  });

  const sum = dailyValues.reduce((acc, v) => acc + v, 0);
  const average = sum / dailyValues.length;

  if (average === 0) {
    console.log(`  [historicalAverageService] Calculated average is 0 → returning null`);
    return null;
  }

  console.log(`  [historicalAverageService] Calculated baseline: ${entries.length} entries, daily values: [${dailyValues.slice(0, 3).map(v => v.toFixed(2)).join(', ')}...], avg=${average.toFixed(4)}`);

  return { average, sampleCount: entries.length, frequency };
}

/**
 * Fetches recent NetReductionEntry records for the given stream and
 * computes the daily-normalized average.
 * NetReduction does not have a frequency config — defaults to 'monthly'.
 *
 * @param {object} params
 * @param {string} params.clientId
 * @param {string} params.projectId
 * @param {string} params.calculationMethodology
 * @param {number} params.sampleSize
 * @param {number} [params.minSamples]
 * @returns {Promise<{average: number, sampleCount: number, frequency: string} | null>}
 */
async function getNetReductionHistoricalAverage({
  clientId,
  projectId,
  calculationMethodology,
  sampleSize = 10,
  minSamples = 3
}) {
  const frequency = "monthly"; // NR has no explicit collection frequency config

  const entries = await NetReductionEntry.find({
    clientId,
    projectId,
    calculationMethodology
  })
    .sort({ timestamp: -1 })
    .limit(sampleSize)
    .select("netReduction")
    .lean();

  if (!entries || entries.length < minSamples) return null;

  const dailyValues = entries.map(e =>
    normalizeToDailyValue(e.netReduction || 0, frequency)
  );

  const sum = dailyValues.reduce((acc, v) => acc + v, 0);
  const average = sum / dailyValues.length;

  if (average === 0) return null;

  return { average, sampleCount: entries.length, frequency };
}

module.exports = {
  getDataEntryHistoricalAverage,
  getNetReductionHistoricalAverage,
  getDataEntryFrequency,
  resolveDataEntryRawValue
};
