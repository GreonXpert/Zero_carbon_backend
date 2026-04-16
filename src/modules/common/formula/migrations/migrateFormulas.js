'use strict';

/**
 * migrateFormulas.js
 *
 * PURPOSE
 * -------
 * Migrates old formula documents (which use clientIds: [String]) to the new
 * common formula schema (which uses clientId: String | null, moduleKey, scopeType).
 *
 * Run BEFORE deploying the Phase 3 code that changes model registration.
 *
 * USAGE
 *   node migrateFormulas.js              # dry-run (no writes, safe to run anytime)
 *   node migrateFormulas.js --apply      # applies all changes
 *
 * ALGORITHM
 * ---------
 * Pass 1 — Formula documents:
 *   For each doc in reduction_formulas where clientId is not yet set:
 *     a) If clientIds is empty/missing → set clientId: null, moduleKey: 'zero_carbon', scopeType: 'client'
 *     b) First clientId → patch original doc IN-PLACE (preserves _id; existing refs still valid)
 *     c) Extra clientIds → insert new clone documents (with sourceFormulaId pointing to original)
 *
 * Pass 2 — Reduction documents:
 *   For each Reduction where m2.formulaRef.formulaId exists:
 *     If the formula.clientId !== reduction.clientId, find the clone for the correct client
 *     and update the reference. Same for m3 formula refs.
 *
 * SAFETY
 * ------
 * - Idempotent: documents already having clientId are skipped.
 * - Dry-run by default: pass --apply to write.
 * - Prints a full summary report at the end.
 */

const mongoose   = require('mongoose');
const { ObjectId } = mongoose.Types;

// ─── DB Connection ────────────────────────────────────────────────────────────

async function connectDb() {
  const MONGO_URI =
    process.env.MONGO_URI || "mongodb+srv://ZeroCarbonTesting:ZeroCarbonTesting@cluster0.bja5b5g.mongodb.net/zeroCarbonTesting"
    process.env.DATABASE_URL ||
    process.env.MONGODB_URI;

  if (!MONGO_URI) {
    throw new Error(
      'No MongoDB URI found. Set MONGO_URI (or DATABASE_URL / MONGODB_URI) in environment.'
    );
  }
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB:', mongoose.connection.host);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const dryRun = !process.argv.includes('--apply');

  if (dryRun) {
    console.log('\n[DRY RUN] No changes will be written. Pass --apply to apply.\n');
  } else {
    console.log('\n[APPLY MODE] Changes will be written to the database.\n');
  }

  await connectDb();

  const db           = mongoose.connection.db;
  const formulaCol   = db.collection('reduction_formulas');
  const reductionCol = db.collection('reductions');

  // ── Stats ──────────────────────────────────────────────────────────────────
  let skipped            = 0;  // already migrated
  let patchedInPlace     = 0;  // original doc patched (clientIds[0] → clientId)
  let clonesCreated      = 0;  // extra client clones inserted
  let noClient           = 0;  // docs with empty clientIds
  let reductionRefsFixed = 0;

  // Map: originalId (string) → { clientId → newCloneId } — for Pass 2
  const cloneMap = new Map();

  // ══════════════════════════════════════════════════════════════════════════
  // PASS 1 — Formula Documents
  // ══════════════════════════════════════════════════════════════════════════

  console.log('─── Pass 1: Formula Documents ───');

  const cursor = formulaCol.find({});
  while (await cursor.hasNext()) {
    const doc = await cursor.next();

    // Already migrated → skip
    if (doc.clientId !== undefined && doc.clientId !== null) {
      skipped++;
      continue;
    }
    if (typeof doc.clientId === 'string') {
      skipped++;
      continue;
    }

    const clientIds = Array.isArray(doc.clientIds) ? doc.clientIds.filter(Boolean) : [];

    // Case A: no clientIds at all
    if (clientIds.length === 0) {
      console.log(`  [no-client] ${doc._id} "${doc.name}" — clientIds empty → clientId: null`);
      noClient++;
      if (!dryRun) {
        await formulaCol.updateOne(
          { _id: doc._id },
          { $set: { clientId: null, moduleKey: 'zero_carbon', scopeType: 'client' } }
        );
      }
      continue;
    }

    const [primaryId, ...extraIds] = clientIds;

    // Case B: patch original doc in-place with the first client
    console.log(`  [patch]  ${doc._id} "${doc.name}" → clientId: ${primaryId}`);
    patchedInPlace++;
    if (!dryRun) {
      await formulaCol.updateOne(
        { _id: doc._id },
        { $set: { clientId: primaryId, moduleKey: 'zero_carbon', scopeType: 'client' } }
      );
    }

    // Case C: create clones for extra clients
    for (const extraId of extraIds) {
      const newId = new ObjectId();
      console.log(`  [clone]  ${newId} (from ${doc._id}) → clientId: ${extraId}`);
      clonesCreated++;

      // Track clone mapping for Pass 2
      const originalKey = String(doc._id);
      if (!cloneMap.has(originalKey)) cloneMap.set(originalKey, {});
      cloneMap.get(originalKey)[extraId] = newId;

      if (!dryRun) {
        const clone = {
          ...doc,
          _id:             newId,
          clientId:        extraId,
          moduleKey:       'zero_carbon',
          scopeType:       'client',
          sourceFormulaId: doc._id,
          createdAt:       doc.createdAt || new Date(),
          updatedAt:       new Date()
        };
        delete clone.clientIds;
        await formulaCol.insertOne(clone);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PASS 2 — Reduction Reference Fix
  // ══════════════════════════════════════════════════════════════════════════

  console.log('\n─── Pass 2: Reduction Reference Fix ───');

  if (cloneMap.size === 0) {
    console.log('  No multi-client formulas found — no Reduction refs to fix.');
  } else {
    const redCursor = reductionCol.find({
      isDeleted: false,
      'm2.formulaRef.formulaId': { $exists: true, $ne: null }
    });

    while (await redCursor.hasNext()) {
      const red = await redCursor.next();

      // ── M2 ref ──────────────────────────────────────────────────────────
      const m2FormulaId = red.m2?.formulaRef?.formulaId;
      if (m2FormulaId) {
        const formulaDoc = await formulaCol.findOne({
          _id: new ObjectId(String(m2FormulaId))
        });
        if (formulaDoc && formulaDoc.clientId !== red.clientId) {
          const clones  = cloneMap.get(String(m2FormulaId)) || {};
          const cloneId = clones[red.clientId];
          if (cloneId) {
            console.log(
              `  [fix-m2]  Reduction ${red._id} (client: ${red.clientId}) ` +
              `m2.formulaRef: ${m2FormulaId} → ${cloneId}`
            );
            reductionRefsFixed++;
            if (!dryRun) {
              await reductionCol.updateOne(
                { _id: red._id },
                { $set: { 'm2.formulaRef.formulaId': cloneId } }
              );
            }
          } else {
            console.warn(
              `  [WARN] Reduction ${red._id} (client: ${red.clientId}) references ` +
              `formula ${m2FormulaId} (clientId: ${formulaDoc.clientId}). ` +
              `No clone found for client ${red.clientId}. Manual review needed.`
            );
          }
        }
      }

      // ── M3 refs ──────────────────────────────────────────────────────────
      const m3Sections = ['baselineEmissions', 'projectEmissions', 'leakageEmissions'];
      for (const section of m3Sections) {
        const items = red.m3?.[section];
        if (!Array.isArray(items)) continue;

        for (let i = 0; i < items.length; i++) {
          const itemFormulaId = items[i]?.formulaId;
          if (!itemFormulaId) continue;

          const formulaDoc = await formulaCol.findOne({
            _id: new ObjectId(String(itemFormulaId))
          });
          if (formulaDoc && formulaDoc.clientId !== red.clientId) {
            const clones  = cloneMap.get(String(itemFormulaId)) || {};
            const cloneId = clones[red.clientId];
            if (cloneId) {
              const fieldPath = `m3.${section}.${i}.formulaId`;
              console.log(
                `  [fix-m3]  Reduction ${red._id} ${fieldPath}: ${itemFormulaId} → ${cloneId}`
              );
              reductionRefsFixed++;
              if (!dryRun) {
                await reductionCol.updateOne(
                  { _id: red._id },
                  { $set: { [fieldPath]: cloneId } }
                );
              }
            }
          }
        }
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log('\n══════════════════════════════════════════════');
  console.log('MIGRATION SUMMARY' + (dryRun ? ' (DRY RUN — no writes)' : ' (APPLIED)'));
  console.log('══════════════════════════════════════════════');
  console.log(`  Skipped (already migrated):  ${skipped}`);
  console.log(`  No clientId (set to null):   ${noClient}`);
  console.log(`  Patched in-place:            ${patchedInPlace}`);
  console.log(`  Clones created:              ${clonesCreated}`);
  console.log(`  Reduction refs fixed:        ${reductionRefsFixed}`);
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
