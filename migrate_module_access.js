/**
 * Migration: Backfill accessibleModules for existing Users and Clients
 *
 * Target collections : users, clients
 * Field              : accessibleModules
 * Default value      : ['zero_carbon']  — all existing data belongs to ZeroCarbon module
 *
 * Safe to re-run     : YES — only touches documents where the field is absent.
 * IMPORTANT          : Uses raw MongoDB updateMany (NOT Mongoose .save()) to avoid
 *                      triggering the encryption plugin on unrelated fields.
 *
 * Usage:
 *   node migrate_module_access.js            → dry-run (shows what WOULD change)
 *   node migrate_module_access.js --apply    → applies changes to DB
 */

'use strict';

require('dotenv').config();

const { MongoClient } = require('mongodb');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌  MONGO_URI is not set in .env');
  process.exit(1);
}

const DRY_RUN = !process.argv.includes('--apply');
// ─────────────────────────────────────────────────────────────────────────────

async function run() {
  const client = new MongoClient(MONGO_URI);

  try {
    await client.connect();
    console.log('✅  Connected to MongoDB');

    const dbName = new URL(MONGO_URI).pathname.replace('/', '');
    const db = client.db(dbName);

    console.log(`\n🏦  Database: ${dbName}`);
    console.log(DRY_RUN ? '🔍  DRY RUN — no changes will be written\n' : '⚡  APPLY MODE — writing changes\n');

    // ── 1. Users ─────────────────────────────────────────────────────────────
    const usersCol = db.collection('users');

    const usersToUpdate = await usersCol.countDocuments({
      accessibleModules: { $exists: false },
    });

    console.log(`👤  Users missing accessibleModules: ${usersToUpdate}`);

    if (!DRY_RUN && usersToUpdate > 0) {
      const userResult = await usersCol.updateMany(
        { accessibleModules: { $exists: false } },
        { $set: { accessibleModules: ['zero_carbon'] } }
      );
      console.log(`   ✅  Users patched: ${userResult.modifiedCount}`);
    } else if (DRY_RUN && usersToUpdate > 0) {
      console.log(`   → Would set accessibleModules: ['zero_carbon'] on ${usersToUpdate} user(s)`);
    } else {
      console.log('   ℹ️   All users already have accessibleModules — skipped');
    }

    // ── 2. Clients ───────────────────────────────────────────────────────────
    const clientsCol = db.collection('clients');

    const clientsToUpdate = await clientsCol.countDocuments({
      accessibleModules: { $exists: false },
    });

    console.log(`\n🏢  Clients missing accessibleModules: ${clientsToUpdate}`);

    if (!DRY_RUN && clientsToUpdate > 0) {
      const clientResult = await clientsCol.updateMany(
        { accessibleModules: { $exists: false } },
        { $set: { accessibleModules: ['zero_carbon'] } }
      );
      console.log(`   ✅  Clients patched: ${clientResult.modifiedCount}`);
    } else if (DRY_RUN && clientsToUpdate > 0) {
      console.log(`   → Would set accessibleModules: ['zero_carbon'] on ${clientsToUpdate} client(s)`);
    } else {
      console.log('   ℹ️   All clients already have accessibleModules — skipped');
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log('\n─────────────────────────────────────────────────');
    if (DRY_RUN) {
      console.log('✅  Dry run complete. Run with --apply to write changes.');
    } else {
      console.log('✅  Migration complete.');
    }

  } catch (err) {
    console.error('❌  Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}

run();
