/**
 * Migration: Backfill assignedClients on consultant_admin users for GreOn IQ access
 *
 * Target collection : users (consultant_admin role)
 * Field patched     : assignedClients  [String]  — array of clientId strings
 *
 * WHY THIS IS NEEDED
 * ------------------
 * GreOn IQ's clientScopeResolver checks user.assignedClients to determine
 * whether a consultant_admin may query a given client's data.
 *
 * consultant_admin users created BEFORE this field was consistently maintained
 * may have an empty or incomplete assignedClients array even though they are
 * correctly linked to clients via Client.leadInfo.consultantAdminId or
 * Client.leadInfo.createdBy.
 *
 * This migration reads every Client document and, for each consultant_admin
 * referenced in that client's leadInfo, ensures their assignedClients array
 * contains that client's clientId string.
 *
 * WHAT IT CHECKS (per client)
 * ---------------------------
 *   Client.leadInfo.consultantAdminId  — the consultant_admin who owns this client
 *   Client.leadInfo.createdBy          — the user who created this client record
 *
 * Both are added to the respective user's assignedClients if not already present.
 * Consultants (consultant role, not consultant_admin) are intentionally excluded —
 * they use a separate assignment flow and their own assignedClients management.
 *
 * SAFE TO RE-RUN
 * --------------
 * YES — uses $addToSet so duplicate clientIds are never inserted.
 * Only modifies users whose assignedClients is actually missing entries.
 * Uses native MongoDB driver (NOT Mongoose) to avoid triggering encryption plugins.
 *
 * USAGE
 * -----
 *   # Dry-run (default) — shows what WOULD change, touches nothing:
 *   node migrations/Greon_IQ/backfill_consultantAdmin_assignedClients.js
 *
 *   # Apply changes:
 *   node migrations/Greon_IQ/backfill_consultantAdmin_assignedClients.js --apply
 *
 * ROLLBACK
 * --------
 * There is no automated rollback because $addToSet is additive and the
 * assignedClients entries added here reflect real business data.
 * To manually remove specific additions run in MongoDB shell:
 *   db.users.updateOne({ _id: <userId> }, { $pull: { assignedClients: "<clientId>" } })
 */

'use strict';

const { MongoClient, ObjectId } = require('mongodb');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI ||
  'mongodb+srv://ZeroCarbonTesting:ZeroCarbonTesting@cluster0.bja5b5g.mongodb.net/zeroCarbonTesting';
const DB_NAME   = process.env.DB_NAME || 'zeroCarbonTesting';
const DRY_RUN   = !process.argv.includes('--apply');
// ─────────────────────────────────────────────────────────────────────────────

async function run() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' GreOn IQ — Backfill consultant_admin assignedClients');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(` Mode    : ${DRY_RUN ? '🔎  DRY-RUN (pass --apply to write)' : '✏️   APPLY'}`);
  console.log(` DB      : ${DB_NAME}`);
  console.log('───────────────────────────────────────────────────────────────');

  const mongo = new MongoClient(MONGO_URI);
  await mongo.connect();
  const db = mongo.db(DB_NAME);

  try {
    await migrate(db);
  } finally {
    await mongo.close();
  }
}

async function migrate(db) {
  const usersCol   = db.collection('users');
  const clientsCol = db.collection('clients');

  // ── Step 1: Load all non-deleted clients that have a consultantAdminId or createdBy ──
  const clients = await clientsCol.find(
    {
      isDeleted: { $ne: true },
      $or: [
        { 'leadInfo.consultantAdminId': { $exists: true, $ne: null } },
        { 'leadInfo.createdBy':         { $exists: true, $ne: null } },
      ],
    },
    {
      projection: {
        clientId:                       1,
        'leadInfo.consultantAdminId':   1,
        'leadInfo.createdBy':           1,
      },
    }
  ).toArray();

  console.log(`\n📋 Found ${clients.length} client(s) with consultant_admin linkage.`);

  if (clients.length === 0) {
    console.log('  ✅ Nothing to migrate.');
    return;
  }

  // ── Step 2: Build a map of userId → Set<clientId> to add ─────────────────
  //    We collect every (userId, clientId) pair that needs to exist in assignedClients.
  const addMap = new Map(); // userId string → Set of clientId strings

  for (const client of clients) {
    const clientIdStr = client.clientId;

    if (!clientIdStr) {
      console.log(`  ⚠️  Skipping client _id=${client._id} — no clientId string field.`);
      continue;
    }

    const userIds = new Set();

    if (client.leadInfo?.consultantAdminId) {
      userIds.add(String(client.leadInfo.consultantAdminId));
    }
    if (client.leadInfo?.createdBy) {
      userIds.add(String(client.leadInfo.createdBy));
    }

    for (const uid of userIds) {
      if (!addMap.has(uid)) addMap.set(uid, new Set());
      addMap.get(uid).add(clientIdStr);
    }
  }

  console.log(`\n👥 ${addMap.size} unique user(s) to process.`);

  // ── Step 3: Filter to only consultant_admin users ─────────────────────────
  const userObjectIds = [...addMap.keys()].map((id) => {
    try { return new ObjectId(id); } catch { return null; }
  }).filter(Boolean);

  const consultantAdmins = await usersCol.find(
    {
      _id:      { $in: userObjectIds },
      userType: 'consultant_admin',
      isDeleted:{ $ne: true },
    },
    { projection: { _id: 1, name: 1, email: 1, assignedClients: 1 } }
  ).toArray();

  console.log(`   → ${consultantAdmins.length} of those are consultant_admin users.`);

  if (consultantAdmins.length === 0) {
    console.log('\n  ✅ No consultant_admin users found to update.');
    return;
  }

  // ── Step 4: For each consultant_admin, compute missing clientIds ──────────
  let totalPatched  = 0;
  let totalSkipped  = 0;

  for (const adminUser of consultantAdmins) {
    const uid            = String(adminUser._id);
    const clientsToAdd   = [...(addMap.get(uid) || [])];
    const existing       = Array.isArray(adminUser.assignedClients) ? adminUser.assignedClients : [];
    const missing        = clientsToAdd.filter((cid) => !existing.includes(cid));

    const label = adminUser.name || adminUser.email || uid;

    if (missing.length === 0) {
      console.log(`\n  ✅ [${label}] — already has all required clients. No change.`);
      totalSkipped++;
      continue;
    }

    console.log(`\n  👤 [${label}]`);
    console.log(`     Current assignedClients : [${existing.join(', ') || '(empty)'}]`);
    console.log(`     Will add                : [${missing.join(', ')}]`);

    if (DRY_RUN) {
      console.log(`     🔎 DRY-RUN — no changes written.`);
      totalPatched++;
      continue;
    }

    // Apply: $addToSet with $each ensures idempotency
    const result = await usersCol.updateOne(
      { _id: adminUser._id },
      { $addToSet: { assignedClients: { $each: missing } } }
    );

    if (result.modifiedCount > 0) {
      console.log(`     ✏️  Updated — added ${missing.length} client(s).`);
      totalPatched++;
    } else {
      console.log(`     ⚠️  Update matched but did not modify (already up-to-date?).`);
      totalSkipped++;
    }
  }

  // ── Step 5: Summary ───────────────────────────────────────────────────────
  console.log('');
  console.log('───────────────────────────────────────────────────────────────');
  if (DRY_RUN) {
    console.log(`  🔎 DRY-RUN complete.`);
    console.log(`     ${totalPatched} user(s) WOULD be updated.`);
    console.log(`     ${totalSkipped} user(s) already up-to-date.`);
    console.log('');
    console.log('  Run with --apply to write these changes to the database.');
  } else {
    console.log(`  ✅ Migration complete.`);
    console.log(`     ${totalPatched} user(s) patched.`);
    console.log(`     ${totalSkipped} user(s) already up-to-date.`);
  }
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
}

run().catch((err) => {
  console.error('\n❌ Migration failed:', err.message);
  process.exit(1);
});
