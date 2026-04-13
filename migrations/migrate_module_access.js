/**
 * Migration: Backfill accessibleModules on existing User and Client documents
 *
 * Target collections : users, clients
 * Field              : accessibleModules
 * Default value      : ['zero_carbon']
 *
 * Why                : The accessibleModules field was added as part of the ESGLink
 *                      module expansion. Existing documents predate this field and
 *                      need to be backfilled so that auth middleware and module-access
 *                      checks work correctly for all existing users and clients.
 *
 * Safe to re-run     : YES — only patches documents where the field is absent.
 *                      Uses $exists: false filter + updateMany (not Mongoose .save()).
 *
 * IMPORTANT          : Uses the native MongoDB driver directly (NOT Mongoose)
 *                      to avoid triggering the encryption plugin on unmodified fields.
 *
 * Usage:
 *   node migrations/migrate_module_access.js            → dry-run (shows what WOULD change)
 *   node migrations/migrate_module_access.js --apply    → applies changes to DB
 *
 * Rollback:
 *   Connect to MongoDB and run:
 *     db.users.updateMany({}, { $unset: { accessibleModules: 1 } })
 *     db.clients.updateMany({}, { $unset: { accessibleModules: 1 } })
 */

'use strict';

const { MongoClient } = require('mongodb');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Use env var if available, otherwise fall back to the same URI used in other migrations
const MONGO_URI = process.env.MONGO_URI ||
  'mongodb+srv://ZeroCarbonTesting:ZeroCarbonTesting@cluster0.bja5b5g.mongodb.net/zeroCarbonTesting';
const DB_NAME = process.env.DB_NAME || 'zeroCarbonTesting';

const DRY_RUN = !process.argv.includes('--apply');
// ─────────────────────────────────────────────────────────────────────────────

async function migrateUsers(db) {
  const col = db.collection('users');

  const filter = { accessibleModules: { $exists: false } };
  const count = await col.countDocuments(filter);

  console.log(`\n📂 [users] — ${count} document(s) missing accessibleModules`);

  if (count === 0) {
    console.log('  ✅ [users] Already up-to-date. Nothing to patch.');
    return 0;
  }

  if (DRY_RUN) {
    console.log(`  🔎 [DRY-RUN] Would set accessibleModules: ['zero_carbon'] on ${count} user(s).`);
    return count;
  }

  const result = await col.updateMany(
    filter,
    { $set: { accessibleModules: ['zero_carbon'] } }
  );

  console.log(`  ✅ [users] Patched ${result.modifiedCount} document(s).`);
  return result.modifiedCount;
}

async function migrateClients(db) {
  const col = db.collection('clients');

  const filter = { accessibleModules: { $exists: false } };
  const count = await col.countDocuments(filter);

  console.log(`\n📂 [clients] — ${count} document(s) missing accessibleModules`);

  if (count === 0) {
    console.log('  ✅ [clients] Already up-to-date. Nothing to patch.');
    return 0;
  }

  if (DRY_RUN) {
    console.log(`  🔎 [DRY-RUN] Would set accessibleModules: ['zero_carbon'] on ${count} client(s).`);
    return count;
  }

  const result = await col.updateMany(
    filter,
    { $set: { accessibleModules: ['zero_carbon'] } }
  );

  console.log(`  ✅ [clients] Patched ${result.modifiedCount} document(s).`);
  return result.modifiedCount;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' accessibleModules Migration — ZeroCarbon / ESGLink');
  console.log(`  Mode : ${DRY_RUN ? '🔎 DRY-RUN (pass --apply to write)' : '✏️  APPLY'}`);
  console.log(`  DB   : ${DB_NAME}`);
  console.log('═══════════════════════════════════════════════════════');

  const client = new MongoClient(MONGO_URI);

  try {
    await client.connect();
    console.log('\n🔗 Connected to MongoDB\n');

    const db = client.db(DB_NAME);

    const userCount = await migrateUsers(db);
    const clientCount = await migrateClients(db);

    console.log('\n═══════════════════════════════════════════════════════');
    if (DRY_RUN) {
      console.log(` 🔎 DRY-RUN COMPLETE`);
      console.log(`    Would patch ${userCount} user(s) and ${clientCount} client(s).`);
      console.log(`    Run with --apply to write changes.`);
    } else {
      console.log(` ✅ MIGRATION COMPLETE`);
      console.log(`    Patched ${userCount} user(s) and ${clientCount} client(s).`);
    }
    console.log('═══════════════════════════════════════════════════════\n');

  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
