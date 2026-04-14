// services/verification/thresholdVerificationService.js
const ThresholdConfig = require("../ThresholdConfig");
const { normalizeToDailyValue } = require("./normalizationService");
const {
  getDataEntryHistoricalAverage,
  getNetReductionHistoricalAverage
} = require("./historicalAverageService");

/**
 * Compute the sum of all numeric values in a Map or plain object.
 * Used as the "comparable value" for DataEntry (matches incomingTotalValue pattern).
 *
 * @param {Map|object} numericMap
 * @returns {number}
 */
function sumNumericMap(numericMap) {
  let total = 0;
  if (!numericMap) return total;

  if (numericMap instanceof Map) {
    for (const v of numericMap.values()) {
      const n = Number(v);
      if (isFinite(n)) total += n;
    }
  } else if (typeof numericMap === "object") {
    for (const v of Object.values(numericMap)) {
      const n = Number(v);
      if (isFinite(n)) total += n;
    }
  }
  return total;
}

/**
 * Fetches the most specific ThresholdConfig for the given stream.
 * Priority: nodeId-specific config > null-nodeId (all-node) config.
 *
 * @param {string} clientId
 * @param {string} scopeIdentifier
 * @param {string} flowType
 * @param {string|null} nodeId
 * @returns {Promise<ThresholdConfig|null>}
 */
async function resolveThresholdConfig(clientId, scopeIdentifier, flowType, nodeId) {
  // Try node-specific first
  if (nodeId) {
    const specific = await ThresholdConfig.findOne({
      clientId,
      scopeIdentifier,
      flowType,
      nodeId,
      isActive: true
    }).lean();
    if (specific) return specific;
  }

  // Fall back to all-node config (nodeId: null)
  return ThresholdConfig.findOne({
    clientId,
    scopeIdentifier,
    flowType,
    nodeId: null,
    isActive: true
  }).lean();
}

/**
 * Decision result returned by all check functions.
 *
 * When shouldRequireApproval=false: normal save proceeds.
 * When shouldRequireApproval=true:  entry must be held in PendingApproval.
 *
 * @typedef {object} VerificationResult
 * @property {boolean} shouldRequireApproval
 * @property {object}  [meta]  - only present when shouldRequireApproval=true
 * @property {number}  meta.normalizedIncomingValue
 * @property {number}  meta.historicalAverageDailyValue
 * @property {number}  meta.deviationPercentage
 * @property {number}  meta.thresholdPercentage
 * @property {number}  meta.sampleCount
 * @property {string}  meta.frequency
 * @property {string}  meta.anomalyReason
 */

/**
 * Checks whether a new DataEntry payload should require approval.
 *
 * @param {object} params
 * @param {string}      params.clientId
 * @param {string}      params.nodeId
 * @param {string}      params.scopeIdentifier
 * @param {Map|object}  params.numericMap        - toNumericMap() output
 * @param {string}      params.inputType         - 'manual' | 'API' | 'IOT' | 'OCR'
 * @returns {Promise<VerificationResult>}
 */
async function checkDataEntry({ clientId, nodeId, scopeIdentifier, numericMap, inputType }) {
  const PASS = { shouldRequireApproval: false };

  // 1. Load threshold config
  const config = await resolveThresholdConfig(clientId, scopeIdentifier, "dataEntry", nodeId);
  if (!config) return PASS;

  // 2. Check if this inputType is covered
  if (
    config.appliesToInputTypes &&
    config.appliesToInputTypes.length > 0 &&
    !config.appliesToInputTypes.includes(inputType)
  ) {
    return PASS;
  }

  // 3. Compute raw incoming value
  const rawIncoming = sumNumericMap(numericMap);
  if (!isFinite(rawIncoming) || rawIncoming < 0) return PASS;

  // 4. Fetch historical average (includes frequency resolution)
  const history = await getDataEntryHistoricalAverage({
    clientId,
    nodeId,
    scopeIdentifier,
    sampleSize: config.baselineSampleSize,
    minSamples: 3
  });

  if (!history) return PASS; // Not enough history — save normally

  const { average, sampleCount, frequency } = history;

  // 5. Normalize incoming value to daily baseline using the same frequency
  const normalizedIncoming = normalizeToDailyValue(rawIncoming, frequency);

  // 6. Compute deviation
  const deviation = Math.abs(normalizedIncoming - average);
  const deviationPct = (deviation / average) * 100;

  // 7. Compare against threshold
  if (deviationPct > config.thresholdPercentage) {
    return {
      shouldRequireApproval: true,
      meta: {
        normalizedIncomingValue: normalizedIncoming,
        historicalAverageDailyValue: average,
        deviationPercentage: parseFloat(deviationPct.toFixed(4)),
        thresholdPercentage: config.thresholdPercentage,
        sampleCount,
        frequency,
        anomalyReason:
          `Incoming daily value (${normalizedIncoming.toFixed(4)}) deviates ` +
          `${deviationPct.toFixed(2)}% from historical average (${average.toFixed(4)}), ` +
          `exceeding threshold of ${config.thresholdPercentage}%`
      }
    };
  }

  return PASS;
}

/**
 * Checks whether a new NetReduction value should require approval.
 * scopeIdentifier for NR is the projectId (used as the lookup key in ThresholdConfig).
 *
 * @param {object} params
 * @param {string} params.clientId
 * @param {string} params.projectId
 * @param {string} params.calculationMethodology
 * @param {number} params.netReductionValue       - Final computed net reduction
 * @param {string} params.inputType
 * @returns {Promise<VerificationResult>}
 */
async function checkNetReduction({
  clientId,
  projectId,
  calculationMethodology,
  netReductionValue,
  inputType
}) {
  const PASS = { shouldRequireApproval: false };

  if (!isFinite(netReductionValue) || netReductionValue < 0) return PASS;

  // For NR, scopeIdentifier in ThresholdConfig stores the projectId
  const config = await resolveThresholdConfig(clientId, projectId, "netReduction", null);
  if (!config) return PASS;

  if (
    config.appliesToInputTypes &&
    config.appliesToInputTypes.length > 0 &&
    !config.appliesToInputTypes.includes(inputType)
  ) {
    return PASS;
  }

  const history = await getNetReductionHistoricalAverage({
    clientId,
    projectId,
    calculationMethodology,
    sampleSize: config.baselineSampleSize,
    minSamples: 3
  });

  if (!history) return PASS;

  const { average, sampleCount, frequency } = history;

  const normalizedIncoming = normalizeToDailyValue(netReductionValue, frequency);
  const deviation = Math.abs(normalizedIncoming - average);
  const deviationPct = (deviation / average) * 100;

  if (deviationPct > config.thresholdPercentage) {
    return {
      shouldRequireApproval: true,
      meta: {
        normalizedIncomingValue: normalizedIncoming,
        historicalAverageDailyValue: average,
        deviationPercentage: parseFloat(deviationPct.toFixed(4)),
        thresholdPercentage: config.thresholdPercentage,
        sampleCount,
        frequency,
        anomalyReason:
          `Incoming daily NR value (${normalizedIncoming.toFixed(4)}) deviates ` +
          `${deviationPct.toFixed(2)}% from historical average (${average.toFixed(4)}), ` +
          `exceeding threshold of ${config.thresholdPercentage}%`
      }
    };
  }

  return PASS;
}

module.exports = { checkDataEntry, checkNetReduction };
