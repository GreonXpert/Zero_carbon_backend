'use strict';

// Lazy-load models to avoid circular dependency issues at startup
function getModels() {
  return {
    Client:          require('../../client-management/client/Client'),
    EmissionSummary: require('../../zero-carbon/calculation/EmissionSummary')
  };
}

// ─── Client / Org resolvers ────────────────────────────────────────────────────
// IMPORTANT: orgId is a custom string (e.g. "Greon008"), NOT a MongoDB ObjectId.
// Always use Client.findOne({ clientId: orgId }), NEVER Client.findById(orgId).

async function resolveOrgName(orgId) {
  const { Client } = getModels();
  const client = await Client.findOne({ clientId: orgId })
    .select('leadInfo.companyName projectProfile.companyName').lean();
  return client?.leadInfo?.companyName || client?.projectProfile?.companyName || null;
}

async function resolveOrgIndustry(orgId) {
  const { Client } = getModels();
  const client = await Client.findOne({ clientId: orgId })
    .select('categoryDetails').lean();
  return client?.categoryDetails?.industry || client?.categoryDetails || null;
}

async function resolveOrgCountry(orgId) {
  const { Client } = getModels();
  const client = await Client.findOne({ clientId: orgId })
    .select('leadInfo.country projectProfile.country').lean();
  return client?.leadInfo?.country || client?.projectProfile?.country || null;
}

async function resolveOrgBaselineYear(orgId) {
  const { Client } = getModels();
  const client = await Client.findOne({ clientId: orgId })
    .select('projectProfile.baselineYear').lean();
  return client?.projectProfile?.baselineYear || null;
}

// ─── Emission summary fetcher ─────────────────────────────────────────────────
// IMPORTANT: DO NOT query DataEntry directly for emission totals.
// DataEntry.calculatedEmissions is encrypted at rest + stored as a Map type —
// MongoDB aggregation ($sum) on encrypted bytes always returns 0.
// EmissionSummary is the pre-aggregated, plain-number source of truth.
//
// This function is called ONCE per resolveAllBindings call and the result
// is passed to all emission resolver functions to avoid redundant DB queries.

async function fetchEmissionSummary(orgId, reportingYear) {
  const { EmissionSummary } = getModels();

  // Show all available docs upfront so we can spot year mismatches in logs
  const allDocs = await EmissionSummary.find(
    { clientId: orgId },
    { 'period.type': 1, 'period.year': 1, 'emissionSummary.totalEmissions.CO2e': 1 }
  ).lean();

  console.log(`\n[dataResolver] fetchEmissionSummary: ${allDocs.length} EmissionSummary docs for "${orgId}":`);
  for (const d of allDocs) {
    const co2e = d.emissionSummary?.totalEmissions?.CO2e ?? 'n/a';
    console.log(`[dataResolver]   period.type="${d.period?.type}" period.year=${d.period?.year} → totalCO2e=${co2e}`);
  }

  if (allDocs.length === 0) {
    console.error(`[dataResolver] fetchEmissionSummary: ❌ NO EmissionSummary docs for "${orgId}" — all emission values will be 0`);
    return null;
  }

  // Step 1: Try exact year match (yearly period)
  // Cast to Number — req.body can send a string; this prevents "2025" (string)
  // vs 2025 (number) type mismatch in MongoDB.
  if (reportingYear !== undefined && reportingYear !== null) {
    const yearNum = Number(reportingYear);
    const yearly = await EmissionSummary.findOne({
      clientId:      orgId,
      'period.type': 'yearly',
      'period.year': yearNum
    }).lean();

    if (yearly) {
      console.log(`[dataResolver] fetchEmissionSummary: ✅ using yearly doc for year=${yearNum}`);
      console.log(`[dataResolver]   totalEmissions.CO2e = ${yearly.emissionSummary?.totalEmissions?.CO2e}`);
      console.log(`[dataResolver]   byScope keys: ${Object.keys(yearly.emissionSummary?.byScope || {}).join(', ')}`);
      return yearly;
    }

    console.warn(`[dataResolver] fetchEmissionSummary: ⚠️ no yearly doc for year=${yearNum}`);

    // Step 2: Fall back to most-recent yearly doc (e.g. user recalculated; 2025 was replaced by 2026)
    const mostRecent = await EmissionSummary.findOne({
      clientId:      orgId,
      'period.type': 'yearly'
    }).sort({ 'period.year': -1 }).lean();

    if (mostRecent) {
      console.warn(`[dataResolver] fetchEmissionSummary: ⚠️ falling back to most-recent yearly (year=${mostRecent.period?.year})`);
      console.log(`[dataResolver]   totalEmissions.CO2e = ${mostRecent.emissionSummary?.totalEmissions?.CO2e}`);
      console.log(`[dataResolver]   byScope keys: ${Object.keys(mostRecent.emissionSummary?.byScope || {}).join(', ')}`);
      return mostRecent;
    }
  }

  // Step 3: Fall back to all-time summary
  const allTime = await EmissionSummary.findOne({
    clientId:      orgId,
    'period.type': 'all-time'
  }).lean();

  if (allTime) {
    console.warn(`[dataResolver] fetchEmissionSummary: ⚠️ using all-time doc (no yearly found)`);
    console.log(`[dataResolver]   totalEmissions.CO2e = ${allTime.emissionSummary?.totalEmissions?.CO2e}`);
    console.log(`[dataResolver]   byScope keys: ${Object.keys(allTime.emissionSummary?.byScope || {}).join(', ')}`);
  } else {
    console.error(`[dataResolver] fetchEmissionSummary: ❌ no all-time doc either — emission values will be 0`);
  }

  return allTime || null;
}

// ─── Emission value extractors ────────────────────────────────────────────────
// These receive a pre-fetched summary doc (or null) — no DB calls here.

function extractTotalEmissions(summary) {
  if (!summary) return 0;
  return summary.emissionSummary?.totalEmissions?.CO2e
      || summary.totalEmissions?.CO2e
      || 0;
}

function extractScopeTotal(summary, scopeType) {
  if (!summary) return 0;
  const byScope = summary.emissionSummary?.byScope || summary.byScope || {};
  return byScope[scopeType]?.CO2e || 0;
}

function extractScopeByCategory(summary, scopeType) {
  if (!summary) return [];

  const byCategory = summary.emissionSummary?.byCategory || summary.byCategory;
  if (!byCategory) return [];

  // byCategory is a Mongoose Map — after .lean() it becomes a plain object.
  // Guard against the (rare) case where it is still a Map instance.
  const entries = byCategory instanceof Map
    ? [...byCategory.entries()]
    : Object.entries(byCategory);

  return entries
    .filter(([, data]) => !scopeType || data?.scopeType === scopeType)
    .map(([category, data]) => ({
      category,
      value: data?.CO2e || 0
    }));
}

// ─── Binding registry ─────────────────────────────────────────────────────────
// Resolvers that need emission data receive a pre-fetched `summary` as the
// 3rd parameter to avoid N DB queries per binding.

const BINDING_RESOLVERS = {
  'org.name':                       (orgId)              => resolveOrgName(orgId),
  'org.industry':                   (orgId)              => resolveOrgIndustry(orgId),
  'org.reportingYear':              (orgId, year)        => year || null,
  'org.country':                    (orgId)              => resolveOrgCountry(orgId),
  'org.baselineYear':               (orgId)              => resolveOrgBaselineYear(orgId),
  'emissions.total':                (orgId, year, summ)  => extractTotalEmissions(summ),
  'emissions.scope1.total':         (orgId, year, summ)  => extractScopeTotal(summ, 'Scope 1'),
  'emissions.scope2.locationBased': (orgId, year, summ)  => extractScopeTotal(summ, 'Scope 2'),
  'emissions.scope2.marketBased':   (orgId, year, summ)  => extractScopeTotal(summ, 'Scope 2'),
  'emissions.scope2.total':         (orgId, year, summ)  => extractScopeTotal(summ, 'Scope 2'),
  'emissions.scope3.total':         (orgId, year, summ)  => extractScopeTotal(summ, 'Scope 3'),
  'emissions.scope1.byCategory':    (orgId, year, summ)  => extractScopeByCategory(summ, 'Scope 1'),
  'emissions.scope2.byCategory':    (orgId, year, summ)  => extractScopeByCategory(summ, 'Scope 2'),
  'emissions.scope3.byCategory':    (orgId, year, summ)  => extractScopeByCategory(summ, 'Scope 3'),
  'emissions.allCategories':        (orgId, year, summ)  => extractScopeByCategory(summ, null)
};

// ─── Main public API ──────────────────────────────────────────────────────────

async function resolveAllBindings(dataMappings, orgId, reportingYear) {
  const bindings = dataMappings?.bindings || {};
  const result   = {};
  const warnings = [];

  const aliases = Object.keys(bindings);

  console.log(`\n[dataResolver] Resolving ${aliases.length} bindings for org="${orgId}" year=${reportingYear}`);
  console.log(`[dataResolver] Bindings requested: ${aliases.join(', ')}`);

  // Fetch emission summary ONCE — reused by all emission-related bindings
  const needsEmission = aliases.some(a => a.startsWith('emissions.'));
  const summary = needsEmission
    ? await fetchEmissionSummary(orgId, reportingYear)
    : null;

  // Log what we found
  if (needsEmission) {
    if (summary) {
      const total = extractTotalEmissions(summary);
      const s1    = extractScopeTotal(summary, 'Scope 1');
      const s2    = extractScopeTotal(summary, 'Scope 2');
      const s3    = extractScopeTotal(summary, 'Scope 3');
      console.log(`[dataResolver] Emission summary loaded: total=${total} Scope1=${s1} Scope2=${s2} Scope3=${s3}`);
    } else {
      console.error(`[dataResolver] ❌ No emission summary loaded — all emission bindings will be 0`);
    }
  }

  await Promise.all(
    aliases.map(async (alias) => {
      try {
        const resolver = BINDING_RESOLVERS[alias];
        let value;
        if (resolver) {
          // Pass summary as 3rd arg; synchronous extractors just use it, async resolvers ignore it
          value = await Promise.resolve(resolver(orgId, reportingYear, summary));
        } else {
          warnings.push(`Unknown binding alias '${alias}'`);
          console.warn(`[dataResolver]   ⚠️  ${alias.padEnd(36)} = UNKNOWN BINDING`);
          result[alias] = null;
          return;
        }

        if (value === null || value === undefined) {
          warnings.push(`Binding '${alias}' returned no data`);
          console.warn(`[dataResolver]   ⚠️  ${alias.padEnd(36)} = NULL/UNDEFINED — check DB has data`);
        } else if (Array.isArray(value)) {
          console.log(`[dataResolver]   ✅ ${alias.padEnd(36)} = [Array, ${value.length} items]`);
        } else {
          console.log(`[dataResolver]   ✅ ${alias.padEnd(36)} = ${JSON.stringify(value)}`);
        }
        result[alias] = value;
      } catch (err) {
        warnings.push(`Binding '${alias}' failed: ${err.message}`);
        console.error(`[dataResolver]   ❌ ${alias.padEnd(36)} = ERROR: ${err.message}`);
        result[alias] = null;
      }
    })
  );

  console.log(`[dataResolver] Done. ${warnings.length} warnings.\n`);
  return { data: result, warnings };
}

async function resolveBinding(alias, orgId, bindings, reportingYear) {
  const resolver = BINDING_RESOLVERS[alias];
  if (!resolver) return null;

  // For emission bindings we need to fetch the summary
  let summary = null;
  if (alias.startsWith('emissions.')) {
    summary = await fetchEmissionSummary(orgId, reportingYear);
  }
  return resolver(orgId, reportingYear, summary);
}

// ── Debug helper: dump raw EmissionSummary docs ───────────────────────────────
async function debugEmissionSummary(orgId) {
  const { EmissionSummary } = getModels();
  const docs = await EmissionSummary.find({ clientId: orgId })
    .select('period emissionSummary').lean();
  console.log(`[dataResolver DEBUG] EmissionSummary docs for "${orgId}":`, JSON.stringify(docs, null, 2));
  return docs;
}

module.exports = { resolveAllBindings, resolveBinding, BINDING_RESOLVERS, debugEmissionSummary };
