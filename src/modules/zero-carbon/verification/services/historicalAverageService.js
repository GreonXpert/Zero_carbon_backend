// services/verification/historicalAverageService.js
const DataEntry = require("../../organization/models/DataEntry");
const NetReductionEntry = require("../../reduction/models/NetReductionEntry");
const DataCollectionConfig = require("../../organization/models/DataCollectionConfig");
const { normalizeToDailyValue } = require("./normalizationService");

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
    .select("dataValues")
    .lean();

  if (!entries || entries.length < minSamples) return null;

  const dailyValues = entries.map(e => {
    const raw = resolveDataEntryRawValue(e);
    return normalizeToDailyValue(raw, frequency);
  });

  const sum = dailyValues.reduce((acc, v) => acc + v, 0);
  const average = sum / dailyValues.length;

  if (average === 0) return null;

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
