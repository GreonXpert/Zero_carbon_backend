'use strict';

/**
 * backfillFormulaModuleKey.js
 *
 * PURPOSE
 * -------
 * Backfills moduleKey on old formula documents that were created before this
 * field was added to the schema.
 *
 * Default applied:
 *   moduleKey → 'zero_carbon'
 *
 * USAGE
 *   node migrations/Formula/backfillFormulaModuleKey.js              # dry-run (safe)
 *   node migrations/Formula/backfillFormulaModuleKey.js --apply      # writes to DB
 *
 * SAFETY
 * ------
 * - Idempotent: documents that already have moduleKey set are skipped.
 * - Dry-run by default: pass --apply to write.
 * - Prints a full summary report at the end.
 */

const mongoose = require('mongoose');

// ─── DB Connection ─────────────────────────────────────────────────────────────

async function connectDb() {
  const MONGO_URI =
    process.env.MONGO_URI ||
    process.env.DATABASE_URL ||
    process.env.MONGODB_URI ||
    'mongodb+srv://zerocarbon:zerocarbon@zerocarbon.ujopg7s.mongodb.net/zeroCarbon';

  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB:', mongoose.connection.host);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const dryRun = !process.argv.includes('--apply');

  if (dryRun) {
    console.log('\n[DRY RUN] No changes will be written. Pass --apply to apply.\n');
  } else {
    console.log('\n[APPLY MODE] Changes will be written to the database.\n');
  }

  await connectDb();

  const formulaCol = mongoose.connection.db.collection('reduction_formulas');

  // Filter: docs where moduleKey is missing, null, or empty string
  const missingFilter = {
    $or: [
      { moduleKey: { $exists: false } },
      { moduleKey: null },
      { moduleKey: '' },
    ]
  };

  const total      = await formulaCol.countDocuments({});
  const needsUpdate = await formulaCol.countDocuments(missingFilter);
  const alreadySet  = total - needsUpdate;

  console.log(`Total formula documents:     ${total}`);
  console.log(`Already have moduleKey:      ${alreadySet}`);
  console.log(`Missing moduleKey (to fix):  ${needsUpdate}`);

  if (needsUpdate === 0) {
    console.log('\nNothing to do — all documents already have moduleKey set.\n');
    await mongoose.disconnect();
    return;
  }

  // Show a sample of what will change
  const sample = await formulaCol.find(missingFilter).limit(5).toArray();
  console.log('\nSample documents to update:');
  for (const doc of sample) {
    console.log(`  _id: ${doc._id}  name: "${doc.name}"  moduleKey: ${JSON.stringify(doc.moduleKey ?? null)}`);
  }
  if (needsUpdate > 5) {
    console.log(`  ... and ${needsUpdate - 5} more`);
  }

  let modifiedCount = 0;

  if (!dryRun) {
    const result = await formulaCol.updateMany(
      missingFilter,
      { $set: { moduleKey: 'zero_carbon' } }
    );
    modifiedCount = result.modifiedCount;
  }

  // ── Summary ─────────────────────────────────────────────────────────────────

  console.log('\n══════════════════════════════════════════════');
  console.log('MIGRATION SUMMARY' + (dryRun ? ' (DRY RUN — no writes)' : ' (APPLIED)'));
  console.log('══════════════════════════════════════════════');
  console.log(`  Total documents:            ${total}`);
  console.log(`  Already had moduleKey:      ${alreadySet}`);
  console.log(`  Missing moduleKey:          ${needsUpdate}`);
  if (!dryRun) {
    console.log(`  Updated to 'zero_carbon':   ${modifiedCount}`);
  }
  console.log('══════════════════════════════════════════════\n');

  if (dryRun) {
    console.log('Re-run with --apply to apply these changes.\n');
  } else {
    console.log('Migration complete.\n');
  }

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Migration failed:', err);
  mongoose.disconnect().finally(() => process.exit(1));
});
