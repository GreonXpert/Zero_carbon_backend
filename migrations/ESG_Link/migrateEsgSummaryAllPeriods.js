/**
 * Migration: Compute all 4 period-type summaries for every existing
 *            boundary × period combination in esg_data_entries.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * Before the multi-period summary feature, EsgBoundarySummary only stored
 * one document per (clientId, boundaryDocId, periodYear) — always periodType='year'.
 * After the update, summaries are keyed by (clientId, boundaryDocId, periodType, periodKey)
 * and 4 types are saved for every data event:
 *   1. year          — e.g. 2026
 *   2. month         — e.g. 2026-03
 *   3. day           — e.g. 2026-03-15
 *   4. financial_year — e.g. 2025-04-01_2026-03-31  (April–March)
 *
 * This migration reads every unique (clientId, boundaryDocId, periodLabel) from
 * esg_data_entries, derives the 4 period defs, and computes + saves any that are
 * missing from esgboundarysummaries.
 *
 * SAFE TO RE-RUN
 * --------------
 * YES — computeAndSaveSummary uses findOneAndUpdate with upsert:true.
 * Running it multiple times only refreshes existing docs.
 *
 * USAGE
 * -----
 *   # Dry-run (default) — shows what WOULD be created, touches nothing:
 *   node migrations/ESG_Link/migrateEsgSummaryAllPeriods.js
 *
 *   # Apply changes:
 *   node migrations/ESG_Link/migrateEsgSummaryAllPeriods.js --apply
 */

'use strict';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI ||
  'mongodb+srv://ZeroCarbonTesting:ZeroCarbonTesting@cluster0.bja5b5g.mongodb.net/zeroCarbonTesting';
const DRY_RUN   = !process.argv.includes('--apply');
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require('mongoose');

async function run() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(' ESG Link — Backfill All-Period Summaries (year/month/day/FY)');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(` Mode : ${DRY_RUN ? '🔎  DRY-RUN (pass --apply to write)' : '✏️   APPLY'}`);
  console.log('───────────────────────────────────────────────────────────────────');

  await mongoose.connect(MONGO_URI);
  console.log(' Connected to MongoDB\n');

  // Load models and services AFTER connecting so Mongoose registers them correctly
  const EsgDataEntry        = require('../../src/modules/esg-link/esgLink_core/data-collection/models/EsgDataEntry');
  const EsgBoundarySummary  = require('../../src/modules/esg-link/esgLink_core/summary/models/EsgBoundarySummary');
  const {
    computeAndSaveSummary,
    resolveAllPeriodsFromEntry,
  } = require('../../src/modules/esg-link/esgLink_core/summary/services/summaryService');

  // ── Step 1: Find all unique (clientId, boundaryDocId, periodLabel) ──────────
  const combinations = await EsgDataEntry.aggregate([
    {
      $match: {
        isDeleted:      false,
        workflowStatus: { $nin: ['superseded', 'rejected'] },
        boundaryDocId:  { $exists: true, $ne: null },
      },
    },
    {
      $group: {
        _id: {
          clientId:      '$clientId',
          boundaryDocId: '$boundaryDocId',
          periodLabel:   '$period.periodLabel',
          periodYear:    '$period.year',
        },
      },
    },
    { $sort: { '_id.clientId': 1, '_id.boundaryDocId': 1, '_id.periodLabel': 1 } },
  ]);

  console.log(` Found ${combinations.length} unique (client × boundary × period) combination(s)\n`);

  if (combinations.length === 0) {
    console.log(' ✅ Nothing to migrate.');
    await mongoose.disconnect();
    return;
  }

  // ── Step 2: For each combination, derive 4 period defs and upsert ───────────
  let toCreate  = 0;
  let existing  = 0;
  let applied   = 0;
  let errors    = 0;

  for (const combo of combinations) {
    const { clientId, boundaryDocId, periodLabel, periodYear } = combo._id;
    const period   = { year: periodYear, periodLabel: periodLabel || '' };
    const allDefs  = resolveAllPeriodsFromEntry(period);

    console.log(` ▸ ${clientId} | ${String(boundaryDocId)} | label="${periodLabel || '(none)'}"`);

    for (const periodDef of allDefs) {
      // Check if this exact summary already exists
      const alreadyExists = await EsgBoundarySummary.exists({
        clientId,
        boundaryDocId,
        periodType: periodDef.periodType,
        periodKey:  periodDef.periodKey,
      });

      if (alreadyExists) {
        console.log(`    ✅ already exists — ${periodDef.periodType}:${periodDef.periodKey}`);
        existing++;
        continue;
      }

      console.log(`    ${DRY_RUN ? '🔎 would create' : '➕ creating'}  — ${periodDef.periodType}:${periodDef.periodKey}`);
      toCreate++;

      if (DRY_RUN) continue;

      try {
        await computeAndSaveSummary(clientId, boundaryDocId, periodDef);
        console.log(`    ✓ saved — ${periodDef.periodType}:${periodDef.periodKey}`);
        applied++;
      } catch (err) {
        console.error(`    ✗ ERROR — ${periodDef.periodType}:${periodDef.periodKey} — ${err.message}`);
        errors++;
      }
    }

    console.log('');
  }

  // ── Step 3: Summary ──────────────────────────────────────────────────────────
  console.log('───────────────────────────────────────────────────────────────────');
  if (DRY_RUN) {
    console.log(` 🔎 DRY-RUN complete.`);
    console.log(`    ${toCreate}  summary doc(s) WOULD be created`);
    console.log(`    ${existing} summary doc(s) already exist (skipped)`);
    console.log('');
    console.log('  Run with --apply to write these changes to the database.');
  } else {
    console.log(` ✅ Migration complete.`);
    console.log(`    ${applied}  summary doc(s) created`);
    console.log(`    ${existing} summary doc(s) already existed (skipped)`);
    if (errors > 0) {
      console.log(`    ${errors}  error(s) — check logs above`);
    }
  }
  console.log('═══════════════════════════════════════════════════════════════════\n');

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('\n❌ Migration failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
