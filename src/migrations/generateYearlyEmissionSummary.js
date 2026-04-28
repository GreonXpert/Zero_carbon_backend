'use strict';

/**
 * Migration: Aggregate monthly EmissionSummary documents into yearly summaries.
 *
 * The M3 trajectory feature requires `period.type: "yearly"` EmissionSummary
 * documents to compute actual emissions per year. This script reads existing
 * monthly docs, sums all emission fields per year, and upserts a yearly doc.
 *
 * Usage:
 *   node src/migrations/generateYearlyEmissionSummary.js --clientId Greon008
 *   node src/migrations/generateYearlyEmissionSummary.js --clientId Greon008 --year 2023
 *   node src/migrations/generateYearlyEmissionSummary.js --clientId Greon008 --from 2023 --to 2025
 *   node src/migrations/generateYearlyEmissionSummary.js --clientId Greon008 --apply
 *
 * Flags:
 *   --clientId <id>    Required. The client to process.
 *   --year <year>      Optional. Process only this single year.
 *   --from <year>      Optional. Start year (inclusive). Default: 2020.
 *   --to   <year>      Optional. End year (inclusive). Default: current year.
 *   --apply            Write to MongoDB. Without this flag the script is a dry run.
 *
 * Notes:
 *   - Monthly documents are preferred. Daily documents are used only if no
 *     monthly doc exists for that year.
 *   - Existing yearly documents are updated in place (upsert by clientId + year).
 *   - The EmissionSummary model is imported with the encryption plugin, so all
 *     reads and writes are transparently encrypted/decrypted.
 */

const path   = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const mongoose = require('mongoose');

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf('--' + name);
  return idx !== -1 ? args[idx + 1] : null;
}

const CLIENT_ID  = getArg('clientId');
const YEAR_ONLY  = getArg('year')  ? Number(getArg('year'))  : null;
const FROM_YEAR  = getArg('from')  ? Number(getArg('from'))  : 2020;
const TO_YEAR    = getArg('to')    ? Number(getArg('to'))    : new Date().getFullYear();
const DRY_RUN    = !args.includes('--apply');

if (!CLIENT_ID) {
  console.error('ERROR: --clientId is required');
  console.error('Usage: node src/migrations/generateYearlyEmissionSummary.js --clientId Greon008 [--year 2023] [--apply]');
  process.exit(1);
}

const START_YEAR = YEAR_ONLY ?? FROM_YEAR;
const END_YEAR   = YEAR_ONLY ?? TO_YEAR;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Add all numeric values from `src` into the corresponding keys of `acc`.
 * Recurses into nested plain objects.
 * Skips string/boolean/array fields.
 */
function deepSumInto(acc, src) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return;
  for (const key of Object.keys(src)) {
    const v = src[key];
    if (typeof v === 'number') {
      acc[key] = (acc[key] || 0) + v;
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!acc[key] || typeof acc[key] !== 'object') acc[key] = {};
      deepSumInto(acc[key], v);
    } else if (typeof v === 'string' && acc[key] === undefined) {
      // Preserve string fields from first document (e.g. scopeType, categoryName)
      acc[key] = v;
    }
  }
}

/**
 * Merge-sum a Map-like field (either a real Map or a plain object keyed by name).
 * acc is always a plain object. src may be a Map or a plain object.
 */
function mergeSumMap(acc, src) {
  if (!src) return;
  const entries = src instanceof Map ? src.entries() : Object.entries(src);
  for (const [key, val] of entries) {
    if (!val || typeof val !== 'object') continue;
    if (!acc[key]) acc[key] = {};
    deepSumInto(acc[key], val);

    // Handle nested activities map inside byCategory
    if (val.activities) {
      if (!acc[key].activities) acc[key].activities = {};
      mergeSumMap(acc[key].activities, val.activities);
    }

    // Handle nested byScope inside byNode
    if (val.byScope) {
      if (!acc[key].byScope) acc[key].byScope = {};
      deepSumInto(acc[key].byScope, val.byScope);
    }

    // Handle nested scopeTypes inside byEmissionFactor
    if (val.scopeTypes) {
      if (!acc[key].scopeTypes) acc[key].scopeTypes = {};
      deepSumInto(acc[key].scopeTypes, val.scopeTypes);
    }
  }
}

/**
 * Aggregate an array of monthly/daily emissionSummary objects into one plain object.
 */
function aggregateEmissionSummaries(summaries) {
  const agg = {
    totalEmissions:  { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0 },
    byScope: {
      'Scope 1': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
      'Scope 2': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
      'Scope 3': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
    },
    byCategory:      {},
    byActivity:      {},
    byNode:          {},
    byDepartment:    {},
    byLocation:      {},
    byEmissionFactor: {},
    byInputType: {
      manual: { CO2e: 0, dataPointCount: 0 },
      API:    { CO2e: 0, dataPointCount: 0 },
      IOT:    { CO2e: 0, dataPointCount: 0 },
    },
    metadata: {
      totalDataPoints: 0,
    },
  };

  for (const es of summaries) {
    if (!es || typeof es !== 'object') continue;

    // totalEmissions
    deepSumInto(agg.totalEmissions, es.totalEmissions);

    // byScope
    if (es.byScope && typeof es.byScope === 'object') {
      for (const scope of ['Scope 1', 'Scope 2', 'Scope 3']) {
        if (es.byScope[scope]) deepSumInto(agg.byScope[scope], es.byScope[scope]);
      }
    }

    // Map-type fields
    mergeSumMap(agg.byCategory,       es.byCategory);
    mergeSumMap(agg.byActivity,       es.byActivity);
    mergeSumMap(agg.byNode,           es.byNode);
    mergeSumMap(agg.byDepartment,     es.byDepartment);
    mergeSumMap(agg.byLocation,       es.byLocation);
    mergeSumMap(agg.byEmissionFactor, es.byEmissionFactor);

    // byInputType
    if (es.byInputType && typeof es.byInputType === 'object') {
      deepSumInto(agg.byInputType, es.byInputType);
    }

    // metadata.totalDataPoints
    if (es.metadata && typeof es.metadata.totalDataPoints === 'number') {
      agg.metadata.totalDataPoints += es.metadata.totalDataPoints;
    }
  }

  return agg;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('MongoDB connected');

  // Import the full model AFTER connecting so the encryption plugin is set up
  const EmissionSummary = require('../modules/zero-carbon/calculation/EmissionSummary');

  console.log(`\nClient    : ${CLIENT_ID}`);
  console.log(`Year range: ${START_YEAR} – ${END_YEAR}`);
  console.log(`Mode      : ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY (will write to MongoDB)'}`);
  console.log('─'.repeat(60));

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (let year = START_YEAR; year <= END_YEAR; year++) {
    // ── 1. Try monthly docs first ─────────────────────────────────────────────
    let docs = await EmissionSummary.find({
      clientId: CLIENT_ID,
      'period.type': 'monthly',
      'period.year': year,
    }).sort({ 'period.month': 1 }).lean();

    let sourceType = 'monthly';

    // ── 2. Fall back to daily if no monthly docs ──────────────────────────────
    if (!docs.length) {
      docs = await EmissionSummary.find({
        clientId: CLIENT_ID,
        'period.type': 'daily',
        'period.year': year,
      }).sort({ 'period.month': 1, 'period.day': 1 }).lean();
      sourceType = 'daily';
    }

    if (!docs.length) {
      console.log(`  ${year}  SKIP  No monthly or daily data found`);
      skipped++;
      continue;
    }

    // ── 3. Aggregate ──────────────────────────────────────────────────────────
    const emissionSummaries = docs.map(d => d.emissionSummary).filter(Boolean);

    if (!emissionSummaries.length) {
      console.log(`  ${year}  SKIP  ${docs.length} ${sourceType} docs found but emissionSummary field is empty on all`);
      skipped++;
      continue;
    }

    const aggregated = aggregateEmissionSummaries(emissionSummaries);

    const yearFrom = new Date(year, 0, 1, 0, 0, 0);
    const yearTo   = new Date(year, 11, 31, 23, 59, 59);

    const totalCO2e    = aggregated.totalEmissions.CO2e.toFixed(4);
    const scope1CO2e   = aggregated.byScope['Scope 1'].CO2e.toFixed(4);
    const scope2CO2e   = aggregated.byScope['Scope 2'].CO2e.toFixed(4);
    const scope3CO2e   = aggregated.byScope['Scope 3'].CO2e.toFixed(4);
    const srcCount     = docs.length;
    const catCount     = Object.keys(aggregated.byCategory).length;
    const actCount     = Object.keys(aggregated.byActivity).length;

    console.log(
      `  ${year}  ${sourceType.padEnd(7)}  ` +
      `src=${srcCount}  total=${totalCO2e} tCO2e  ` +
      `S1=${scope1CO2e}  S2=${scope2CO2e}  S3=${scope3CO2e}  ` +
      `cats=${catCount}  acts=${actCount}`
    );

    if (DRY_RUN) continue;

    // ── 4. Upsert yearly doc ─────────────────────────────────────────────────
    const existing = await EmissionSummary.findOne({
      clientId: CLIENT_ID,
      'period.type': 'yearly',
      'period.year': year,
    });

    const payload = {
      clientId:        CLIENT_ID,
      period: {
        type:  'yearly',
        year:  year,
        from:  yearFrom,
        to:    yearTo,
      },
      emissionSummary: aggregated,
      metadata: {
        totalDataPoints:   aggregated.metadata.totalDataPoints,
        lastCalculated:    new Date(),
        version:           1,
        isComplete:        true,
        hasErrors:         false,
      },
    };

    if (existing) {
      existing.set(payload);
      await existing.save();
      console.log(`       → Updated  existing yearly doc _id=${existing._id}`);
      updated++;
    } else {
      const doc = new EmissionSummary(payload);
      await doc.save();
      console.log(`       → Created  new yearly doc _id=${doc._id}`);
      created++;
    }
  }

  console.log('─'.repeat(60));
  if (DRY_RUN) {
    console.log(`Dry run complete. ${END_YEAR - START_YEAR + 1 - skipped} year(s) would be written, ${skipped} skipped.`);
    console.log('Re-run with --apply to write to MongoDB.');
  } else {
    console.log(`Done. Created: ${created}  Updated: ${updated}  Skipped: ${skipped}`);
  }

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Migration failed:', err);
  mongoose.disconnect();
  process.exit(1);
});
