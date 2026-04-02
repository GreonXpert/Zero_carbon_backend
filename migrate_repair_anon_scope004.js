/**
 * Migration: Repair anonymous code redemption & cycle stats for GREON001-EC-ANON-UNC-004
 *
 * Problem:
 *   3 survey responses were submitted against OLD anonymous code docs (scope GREON001-EC-ANON-UNC-001)
 *   because resolveAnonymousCode had no sort and returned stale docs with duplicate anonymousCodeId labels.
 *   The NEW scope-004 anonymous code docs were never marked as redeemed, so cycle stats stayed at 0.
 *
 * What this script does:
 *   1. Finds the 3 mislinked survey responses (old anonymousCodeDocId values, scope 001)
 *   2. For each, finds the matching new scope-004 AnonymousCode doc by anonymousCodeId label
 *   3. Marks those docs as redeemed (isRedeemed, redeemedAt, responseId)
 *   4. Recalculates and updates SurveyCycle stats for scope 004
 *
 * Safe to re-run: YES — skips already-redeemed docs.
 *
 * Usage:
 *   node migrate_repair_anon_scope004.js            → dry-run (shows what WOULD change)
 *   node migrate_repair_anon_scope004.js --apply    → applies changes to DB
 */

'use strict';

const { MongoClient, ObjectId } = require('mongodb');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const MONGO_URI = 'mongodb+srv://ZeroCarbonTesting:ZeroCarbonTesting@cluster0.bja5b5g.mongodb.net/zeroCarbonTesting';
const DB_NAME   = 'zeroCarbonTesting';

const DRY_RUN = !process.argv.includes('--apply');

// Known constants from the bug report
const OLD_SCOPE    = 'GREON001-EC-ANON-UNC-001';
const NEW_SCOPE    = 'GREON001-EC-ANON-UNC-004';
const CLIENT_ID    = 'Greon001';
const CYCLE_INDEX  = 0;

// The anonymousCodeDocId values stored in the mislinked responses (old code docs)
const OLD_CODE_DOC_IDS = [
  '69ca62b350d460ddd4435c91',
  '69ca62b350d460ddd4435cc3',
  '69ca62b450d460ddd4435d25',
].map(id => new ObjectId(id));
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN (pass --apply to commit)' : 'APPLY'}\n`);

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);

  try {
    // ── Step 1: Find the 3 mislinked responses ────────────────────────────────
    const responses = await db.collection('surveyresponses').find({
      scopeIdentifier: OLD_SCOPE,
      responseMode: 'anonymous',
      anonymousCodeDocId: { $in: OLD_CODE_DOC_IDS },
    }).toArray();

    console.log(`Found ${responses.length} mislinked response(s) in scope ${OLD_SCOPE}`);

    if (responses.length === 0) {
      console.log('Nothing to repair. Exiting.');
      return;
    }

    // ── Steps 2 + 3: Link each response to the correct scope-004 code doc ────
    for (const resp of responses) {
      console.log(`\nResponse: ${resp._id}  anonymousCodeId=${resp.anonymousCodeId}`);

      const newCodeDoc = await db.collection('anonymouscodes').findOne({
        anonymousCodeId: resp.anonymousCodeId,
        scopeIdentifier: NEW_SCOPE,
      });

      if (!newCodeDoc) {
        console.warn(`  WARNING: No scope-004 code doc found for label "${resp.anonymousCodeId}" — skipping`);
        continue;
      }

      if (newCodeDoc.isRedeemed) {
        console.log(`  SKIP: Code doc ${newCodeDoc._id} already redeemed (responseId=${newCodeDoc.responseId})`);
        continue;
      }

      console.log(`  → Will mark code doc ${newCodeDoc._id} as redeemed (responseId=${resp._id}, redeemedAt=${resp.responseTimestamp})`);

      if (!DRY_RUN) {
        await db.collection('anonymouscodes').updateOne(
          { _id: newCodeDoc._id },
          {
            $set: {
              isRedeemed: true,
              redeemedAt: resp.responseTimestamp,
              responseId:  resp._id,
              updatedAt:   new Date(),
            },
          }
        );
        console.log(`  ✓ Updated`);
      }
    }

    // ── Step 4: Recalculate SurveyCycle stats for scope 004 ──────────────────
    console.log(`\nRecalculating cycle stats for ${NEW_SCOPE} cycleIndex=${CYCLE_INDEX}...`);

    // After applying, count redeemed docs (in dry-run, add the number we would redeem)
    const alreadyRedeemed = await db.collection('anonymouscodes').countDocuments({
      clientId: CLIENT_ID, scopeIdentifier: NEW_SCOPE, cycleIndex: CYCLE_INDEX, isRedeemed: true,
    });
    const totalCodes = await db.collection('anonymouscodes').countDocuments({
      clientId: CLIENT_ID, scopeIdentifier: NEW_SCOPE, cycleIndex: CYCLE_INDEX,
    });

    const cycle = await db.collection('surveycycles').findOne({
      clientId: CLIENT_ID, scopeIdentifier: NEW_SCOPE, cycleIndex: CYCLE_INDEX,
    });

    if (!cycle) {
      console.warn(`WARNING: No SurveyCycle found for ${NEW_SCOPE} — stats not updated`);
      return;
    }

    // In dry-run, project what the count WOULD be after redemptions
    const projectedRedeemed = DRY_RUN ? Math.min(alreadyRedeemed + responses.length, totalCodes) : alreadyRedeemed;
    const totalLinks = cycle.totalLinks || totalCodes || 1;
    const completionPct = Math.round((projectedRedeemed / totalLinks) * 100);

    console.log(`  Current:   submitted=${cycle.statistics?.submitted}, pending=${cycle.statistics?.pending}, completionPct=${cycle.statistics?.completionPct}%`);
    console.log(`  Projected: submitted=${projectedRedeemed}, pending=${totalCodes - projectedRedeemed}, completionPct=${completionPct}%`);

    if (!DRY_RUN) {
      await db.collection('surveycycles').updateOne(
        { clientId: CLIENT_ID, scopeIdentifier: NEW_SCOPE, cycleIndex: CYCLE_INDEX },
        {
          $set: {
            'statistics.submitted':     projectedRedeemed,
            'statistics.pending':       totalCodes - projectedRedeemed,
            'statistics.completionPct': completionPct,
            updatedAt: new Date(),
          },
        }
      );
      console.log(`  ✓ Cycle stats updated`);
    }

  } finally {
    await client.close();
    console.log(`\n${DRY_RUN ? 'DRY-RUN complete. Re-run with --apply to commit changes.' : 'Migration complete.'}`);
  }
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
