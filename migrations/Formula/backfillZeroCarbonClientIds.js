'use strict';

/**
 * backfillZeroCarbonClientIds.js
 *
 * PURPOSE
 * -------
 * Converts zero_carbon formula documents from the old single-string clientId
 * field to the new clientIds array field.
 *
 *   clientId: "Greon198"            →  clientIds: ["Greon198"],  clientId: null
 *   clientId: null  (no client)     →  clientIds: [],            clientId: null
 *   clientIds already set           →  skipped (idempotent)
 *
 * esg_link formulas are NOT touched — they keep clientId (string).
 *
 * USAGE
 *   node migrations/Formula/backfillZeroCarbonClientIds.js          # dry-run
 *   node migrations/Formula/backfillZeroCarbonClientIds.js --apply  # write
 */

const mongoose = require('mongoose');

async function connectDb() {
  const MONGO_URI =
    process.env.MONGO_URI ||
    process.env.DATABASE_URL ||
    process.env.MONGODB_URI ||
    'mongodb+srv://zerocarbon:zerocarbon@zerocarbon.ujopg7s.mongodb.net/zeroCarbon';

  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB:', mongoose.connection.host);
}

async function run() {
  const dryRun = !process.argv.includes('--apply');

  console.log(dryRun
    ? '\n[DRY RUN] No changes will be written. Pass --apply to apply.\n'
    : '\n[APPLY MODE] Changes will be written to the database.\n'
  );

  await connectDb();
  const col = mongoose.connection.db.collection('reduction_formulas');

  // Only zero_carbon docs that have NOT yet been converted
  // (clientIds is missing, empty but clientId still has a value, etc.)
  const needsConversion = {
    moduleKey: 'zero_carbon',
    $or: [
      { clientIds: { $exists: false } },
      { clientIds: { $size: 0 }, clientId: { $nin: [null, ''] } }
    ]
  };

  const total    = await col.countDocuments({ moduleKey: 'zero_carbon' });
  const toConvert = await col.countDocuments(needsConversion);
  const skipped  = total - toConvert;

  console.log(`zero_carbon formulas total:      ${total}`);
  console.log(`Already converted (skipped):     ${skipped}`);
  console.log(`Needs conversion:                ${toConvert}`);

  if (toConvert === 0) {
    console.log('\nNothing to do.\n');
    await mongoose.disconnect();
    return;
  }

  // Preview sample
  const sample = await col.find(needsConversion).limit(5).toArray();
  console.log('\nSample documents to convert:');
  for (const doc of sample) {
    console.log(
      `  _id: ${doc._id}  name: "${doc.name}"` +
      `  clientId: ${JSON.stringify(doc.clientId ?? null)}` +
      `  clientIds: ${JSON.stringify(doc.clientIds ?? 'missing')}`
    );
  }
  if (toConvert > 5) console.log(`  ... and ${toConvert - 5} more`);

  let converted = 0;

  if (!dryRun) {
    const cursor = col.find(needsConversion);
    while (await cursor.hasNext()) {
      const doc = await cursor.next();

      // Build the new clientIds array from whatever clientId was set
      const newClientIds = (doc.clientId && doc.clientId !== '')
        ? [doc.clientId]
        : (Array.isArray(doc.clientIds) && doc.clientIds.length > 0 ? doc.clientIds : []);

      await col.updateOne(
        { _id: doc._id },
        { $set: { clientIds: newClientIds, clientId: null } }
      );
      converted++;
    }
  }

  console.log('\n══════════════════════════════════════════════');
  console.log('MIGRATION SUMMARY' + (dryRun ? ' (DRY RUN — no writes)' : ' (APPLIED)'));
  console.log('══════════════════════════════════════════════');
  console.log(`  zero_carbon total:           ${total}`);
  console.log(`  Already converted (skipped): ${skipped}`);
  console.log(`  Needed conversion:           ${toConvert}`);
  if (!dryRun) console.log(`  Converted:                   ${converted}`);
  console.log('══════════════════════════════════════════════\n');

  if (dryRun) console.log('Re-run with --apply to apply these changes.\n');
  else        console.log('Migration complete.\n');

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Migration failed:', err);
  mongoose.disconnect().finally(() => process.exit(1));
});
