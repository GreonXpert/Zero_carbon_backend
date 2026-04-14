// utils/migrations/fixZeroCarbonExpiry.js
//
// One-time migration: resets ZeroCarbon subscriptionStatus back to "active"
// for clients that were incorrectly expired by the cron job when
// subscriptionEndDate was null (MongoDB null < any date → cron matched them).
//
// Background:
//   Existing clients only have the zero_carbon module.
//   Before subscription dates were properly tracked, some clients had
//   subscriptionEndDate: null.  The nightly zeroCarbonExpiryChecker cron used
//   { $lte: new Date() } without a $ne:null guard, so those clients were
//   transitioned: active → grace_period → expired.
//   Their subscriptionEndDate has since been set to a valid future date
//   (e.g. 2027-02-11), but subscriptionStatus was never reset.
//
// What this script fixes:
//   • Clients where subscriptionStatus is "grace_period" or "expired"
//     BUT subscriptionEndDate is in the future (incorrectly expired).
//   • Re-activates users who were deactivated as part of the expiry transition.
//
// Usage:
//   node utils/migrations/fixZeroCarbonExpiry.js           ← dry run (safe, no writes)
//   node utils/migrations/fixZeroCarbonExpiry.js --apply   ← actually apply changes
//
// Requires MONGO_URI in .env (same as the main app).

'use strict';

const path    = require('path');
const dotenv  = require('dotenv');
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const mongoose = require('mongoose');

const DRY_RUN = !process.argv.includes('--apply');

// ── Minimal inline models (avoid importing full app models with pre/post hooks) ─

const clientSchema = new mongoose.Schema({}, { strict: false });
const Client = mongoose.model('Client', clientSchema, 'clients');

const userSchema = new mongoose.Schema({}, { strict: false });
const User = mongoose.model('User', userSchema, 'users');

// ─────────────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n=== ZeroCarbon Expiry Migration ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes will be made)' : 'APPLY (writing to DB)'}\n`);

  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB\n');

  const now = new Date();

  // ── 1. Find incorrectly expired clients ──────────────────────────────────
  //
  // Criteria:
  //   a) subscriptionStatus is "grace_period" or "expired"
  //   b) subscriptionEndDate is in the future → expiry was wrong
  //   c) OR subscriptionEndDate is null → was never set, cron matched null
  //
  const affected = await Client.find({
    'accountDetails.subscriptionStatus': { $in: ['grace_period', 'expired'] },
    $or: [
      { 'accountDetails.subscriptionEndDate': { $gt: now } },  // valid future date → wrongly expired
      { 'accountDetails.subscriptionEndDate': null },           // null → cron bug victim
    ],
  }).lean();

  console.log(`Found ${affected.length} client(s) with incorrect subscriptionStatus:\n`);

  if (affected.length === 0) {
    console.log('Nothing to fix. Exiting.\n');
    await mongoose.disconnect();
    return;
  }

  for (const client of affected) {
    const acct = client.accountDetails || {};
    console.log(`  clientId: ${client.clientId}`);
    console.log(`    subscriptionStatus  : ${acct.subscriptionStatus}`);
    console.log(`    subscriptionEndDate : ${acct.subscriptionEndDate || 'null'}`);
    console.log(`    isActive            : ${acct.isActive}`);
    console.log('');
  }

  if (DRY_RUN) {
    console.log('--- DRY RUN: no changes written ---');
    console.log('Run with --apply to fix these clients.\n');
    await mongoose.disconnect();
    return;
  }

  // ── 2. Reset subscriptionStatus + isActive on Client ─────────────────────
  const clientIds = affected.map(c => c.clientId);

  const clientResult = await Client.updateMany(
    {
      clientId: { $in: clientIds },
    },
    {
      $set: {
        'accountDetails.subscriptionStatus': 'active',
        'accountDetails.isActive': true,
      },
    }
  );

  console.log(`\nClient update result: ${clientResult.modifiedCount} client(s) updated.`);

  // ── 3. Re-activate users deactivated by the expiry checker ───────────────
  //
  // The expiry checker deactivates only zero_carbon-only users:
  //   accessibleModules: { $size: 1, $all: ['zero_carbon'] }
  // Re-activate those for the affected clients.
  //
  const userResult = await User.updateMany(
    {
      clientId: { $in: clientIds },
      isActive: false,
    },
    {
      $set: { isActive: true },
    }
  );

  console.log(`User update result   : ${userResult.modifiedCount} user(s) re-activated.\n`);

  // ── 4. Summary ────────────────────────────────────────────────────────────
  console.log('=== Migration complete ===');
  console.log(`Fixed clients : ${clientResult.modifiedCount}`);
  console.log(`Fixed users   : ${userResult.modifiedCount}`);
  console.log('\nRestart your server to ensure in-memory caches are cleared.\n');

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
