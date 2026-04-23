'use strict';

const crypto = require('crypto');

/**
 * Computes a deterministic SHA256 recompute_hash for a PathwayAnnual row.
 * Used to detect whether pathway rows need re-derivation after parameter changes.
 */
function computePathwayHash(targetId, targetYear, frameworkName, methodName, keyParams = {}) {
  const str = `${targetId}|${targetYear}|${frameworkName}|${methodName}|${JSON.stringify(keyParams)}`;
  return crypto.createHash('sha256').update(str).digest('hex');
}

module.exports = { computePathwayHash };
