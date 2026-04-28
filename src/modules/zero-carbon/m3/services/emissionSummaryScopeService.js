'use strict';

const EmissionSummary = require('../../calculation/EmissionSummary');

// Maps scope_boundary enum values to their corresponding byScope keys in EmissionSummary.
const SCOPE_BOUNDARY_MAP = {
  S1:     ['Scope 1'],
  S1S2:   ['Scope 1', 'Scope 2'],
  S3:     ['Scope 3'],
  S1S2S3: ['Scope 1', 'Scope 2', 'Scope 3'],
};

/**
 * Returns the list of EmissionSummary byScope keys for a given scope_boundary value.
 * Throws a 422 error for unrecognised boundaries so callers get a clear failure.
 */
function getScopesForBoundary(scopeBoundary) {
  const scopes = SCOPE_BOUNDARY_MAP[scopeBoundary];
  if (!scopes) {
    const e = new Error(`Unknown scope_boundary '${scopeBoundary}'. Valid values: ${Object.keys(SCOPE_BOUNDARY_MAP).join(', ')}`);
    e.status = 422;
    throw e;
  }
  return scopes;
}

/**
 * Extracts the CO2e total for the given scope_boundary from an EmissionSummary document.
 * Applies scope3CoveragePct (0–100) to Scope 3 emissions when the boundary includes Scope 3.
 *
 * Returns an object:
 *   { CO2e, scopeBreakdown: { scope1, scope2, scope3Raw, scope3Adjusted }, usedFallback }
 */
function extractCO2eForScopeBoundary(doc, scopeBoundary, scope3CoveragePct = 100) {
  const scopeKeys = getScopesForBoundary(scopeBoundary);
  const byScope   = doc.emissionSummary?.byScope;

  const byScopeHasData = byScope && Object.keys(byScope).length > 0;

  const s1      = byScope?.['Scope 1']?.CO2e ?? 0;
  const s2      = byScope?.['Scope 2']?.CO2e ?? 0;
  const s3Raw   = byScope?.['Scope 3']?.CO2e ?? 0;
  const s3Factor = Math.min(Math.max(scope3CoveragePct ?? 100, 0), 100) / 100;
  const s3Adjusted = s3Raw * s3Factor;

  let CO2e;
  let usedFallback = false;

  if (!byScopeHasData) {
    CO2e = doc.emissionSummary?.totalEmissions?.CO2e ?? 0;
    usedFallback = true;
    console.warn(
      `[emissionSummaryScopeService] byScope missing on EmissionSummary doc ${doc._id}. ` +
      `Falling back to totalEmissions.CO2e (${CO2e}) for boundary ${scopeBoundary}.`
    );
  } else {
    CO2e = scopeKeys.reduce((sum, key) => {
      if (key === 'Scope 3') return sum + s3Adjusted;
      return sum + (byScope[key]?.CO2e ?? 0);
    }, 0);
  }

  return {
    CO2e,
    scopeBreakdown: { scope1: s1, scope2: s2, scope3Raw: s3Raw, scope3Adjusted: s3Adjusted, scope3CoveragePct: scope3CoveragePct ?? 100 },
    usedFallback,
  };
}

/**
 * Queries the latest yearly EmissionSummary for a client/year and extracts CO2e
 * using the specified scope boundary.
 *
 * Returns null if no yearly EmissionSummary document exists for the given year.
 *
 * Return shape:
 * {
 *   CO2e,
 *   scopeBoundary,
 *   scopeBreakdown: { scope1, scope2, scope3 },
 *   sourceTotalCO2e,
 *   ingestionTimestamp,
 *   summaryId,
 * }
 */
async function pullYearlyEmissionSummaryByBoundary(clientId, year, scopeBoundary, scope3CoveragePct = 100) {
  const doc = await EmissionSummary.findOne({
    clientId,
    'period.type': 'yearly',
    'period.year': year,
  }).sort({ 'metadata.lastCalculated': -1 }).lean();

  if (!doc) return null;

  const { CO2e, scopeBreakdown, usedFallback } = extractCO2eForScopeBoundary(doc, scopeBoundary, scope3CoveragePct);

  if (usedFallback) {
    console.warn(
      `[pullYearlyEmissionSummaryByBoundary] clientId=${clientId} year=${year} boundary=${scopeBoundary}: ` +
      `used totalEmissions fallback. Verify M1 calculation populates byScope.`
    );
  }

  return {
    CO2e,
    scopeBoundary,
    scope3CoveragePct,
    scopeBreakdown,
    sourceTotalCO2e:    doc.emissionSummary?.totalEmissions?.CO2e ?? 0,
    ingestionTimestamp: doc.metadata?.lastCalculated || new Date(),
    summaryId:          doc._id,
  };
}

/**
 * Extracts CO2e from doc.processEmissionSummary using the given scope boundary.
 * Used when the client's assessmentLevel is 'process' only.
 *
 * For S1S2S3 uses processEmissionSummary.totalEmissions.CO2e directly.
 * For all other boundaries sums the relevant byScope keys.
 * Falls back to totalEmissions.CO2e if byScope is absent.
 *
 * Returns { CO2e, usedFallback, found }
 */
function extractCO2eFromProcessSummary(doc, scopeBoundary) {
  const ps = doc.processEmissionSummary;
  if (!ps) return { CO2e: null, usedFallback: false, found: false };

  if (scopeBoundary === 'S1S2S3') {
    const CO2e = ps.totalEmissions?.CO2e ?? null;
    return { CO2e, usedFallback: false, found: CO2e !== null };
  }

  const scopes  = getScopesForBoundary(scopeBoundary);
  const byScope = ps.byScope;
  const byScopeHasData = byScope && Object.keys(byScope).length > 0;

  if (!byScopeHasData) {
    const CO2e = ps.totalEmissions?.CO2e ?? null;
    console.warn(
      `[emissionSummaryScopeService] processEmissionSummary.byScope missing on doc ${doc._id}. ` +
      `Falling back to processEmissionSummary.totalEmissions.CO2e (${CO2e}) for boundary ${scopeBoundary}.`
    );
    return { CO2e, usedFallback: true, found: CO2e !== null };
  }

  const CO2e = scopes.reduce((sum, key) => sum + (byScope[key]?.CO2e ?? 0), 0);
  return { CO2e, usedFallback: false, found: true };
}

/**
 * Fetches the latest yearly EmissionSummary for clientId + baseYear and extracts
 * CO2e using the correct sub-document (emissionSummary vs processEmissionSummary)
 * based on the client's assessmentLevel array.
 *
 * Assessment level priority:
 *   - includes 'organization' (or both org+process) → emissionSummary
 *   - only 'process'                                → processEmissionSummary
 *   - empty / unknown                               → emissionSummary (default)
 *
 * Returns:
 *   { CO2e, found, source: 'organization'|'process', summaryId }
 *   found=false when no yearly EmissionSummary document exists for that year.
 */
async function pullBaseYearEmissionsByAssessmentLevel(clientId, baseYear, scopeBoundary, assessmentLevels, scope3CoveragePct = 100) {
  const doc = await EmissionSummary.findOne({
    clientId,
    'period.type': 'yearly',
    'period.year': baseYear,
  }).sort({ 'metadata.lastCalculated': -1 }).lean();

  if (!doc) return { CO2e: null, found: false, source: null, summaryId: null };

  const levels     = Array.isArray(assessmentLevels) ? assessmentLevels : [];
  const useProcess = levels.includes('process') && !levels.includes('organization');

  if (useProcess) {
    const result = extractCO2eFromProcessSummary(doc, scopeBoundary);
    return { CO2e: result.CO2e, found: result.found, source: 'process', summaryId: doc._id };
  }

  // Organization (or default) path — always use extractCO2eForScopeBoundary so scope3CoveragePct is applied
  const result = extractCO2eForScopeBoundary(doc, scopeBoundary, scope3CoveragePct);
  return { CO2e: result.CO2e, found: result.CO2e !== null, source: 'organization', summaryId: doc._id };
}

module.exports = {
  getScopesForBoundary,
  extractCO2eForScopeBoundary,
  extractCO2eFromProcessSummary,
  pullYearlyEmissionSummaryByBoundary,
  pullBaseYearEmissionsByAssessmentLevel,
};
