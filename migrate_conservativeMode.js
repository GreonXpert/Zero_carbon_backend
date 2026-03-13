/**
 * Migration: Add conservativeMode field to all scopeDetails
 * 
 * Target collections : flowcharts, processflowcharts
 * Field path         : nodes[].details.scopeDetails[].conservativeMode
 * Default value      : false  (ISO 14064-1 inventory mode — report E ± ΔE range)
 * 
 * Safe to re-run     : YES — only touches documents where the field is absent.
 *
 * Usage:
 *   node migrate_conservativeMode.js            → dry-run (shows what WOULD change)
 *   node migrate_conservativeMode.js --apply    → applies changes to DB
 */

'use strict';

const { MongoClient } = require('mongodb');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const MONGO_URI = 'mongodb+srv://ZeroCarbonTesting:ZeroCarbonTesting@cluster0.bja5b5g.mongodb.net/zeroCarbonTesting';
const DB_NAME   = 'zeroCarbonTesting';

const COLLECTIONS = ['flowcharts', 'processflowcharts'];

const DRY_RUN = !process.argv.includes('--apply');
// ─────────────────────────────────────────────────────────────────────────────

async function migrateCollection(db, collectionName) {
  const col = db.collection(collectionName);

  // Find every document that has at least one scopeDetail missing conservativeMode
  const docs = await col.find({
    'nodes.details.scopeDetails': { $exists: true }
  }).toArray();

  console.log(`\n📂 [${collectionName}] — ${docs.length} document(s) with scopeDetails found`);

  let docsPatched    = 0;
  let scopesPatched  = 0;
  let docsSkipped    = 0;

  for (const doc of docs) {
    let docNeedsUpdate = false;
    let patchCountThisDoc = 0;

    // Walk every node → every scopeDetail
    const updatedNodes = (doc.nodes || []).map(node => {
      const scopeDetails = (node?.details?.scopeDetails || []).map(scope => {
        if (scope.conservativeMode === undefined || scope.conservativeMode === null) {
          patchCountThisDoc++;
          docNeedsUpdate = true;
          return { ...scope, conservativeMode: false };
        }
        return scope;
      });

      return {
        ...node,
        details: {
          ...(node.details || {}),
          scopeDetails
        }
      };
    });

    if (!docNeedsUpdate) {
      docsSkipped++;
      continue;
    }

    scopesPatched += patchCountThisDoc;
    docsPatched++;

    console.log(
      `  ${DRY_RUN ? '[DRY-RUN] Would patch' : 'Patching'} doc _id=${doc._id}` +
      `  clientId=${doc.clientId || 'N/A'}` +
      `  → ${patchCountThisDoc} scopeDetail(s)`
    );

    if (!DRY_RUN) {
      // Replace only the nodes array; leave every other field untouched
      await col.updateOne(
        { _id: doc._id },
        { $set: { nodes: updatedNodes } }
      );
    }
  }

  console.log(
    `\n  ✅ [${collectionName}] Summary:` +
    `\n     Docs already up-to-date : ${docsSkipped}` +
    `\n     Docs ${DRY_RUN ? 'would be patched' : 'patched'}         : ${docsPatched}` +
    `\n     scopeDetails ${DRY_RUN ? 'would be patched' : 'patched'}  : ${scopesPatched}`
  );

  return { docsPatched, scopesPatched };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' conservativeMode Migration — zeroCarbonTesting DB');
  console.log(`  Mode : ${DRY_RUN ? '🔎 DRY-RUN (pass --apply to write)' : '✏️  APPLY'}`);
  console.log('═══════════════════════════════════════════════════════');

  const client = new MongoClient(MONGO_URI);

  try {
    await client.connect();
    console.log('\n🔗 Connected to MongoDB Atlas\n');

    const db = client.db(DB_NAME);

    let totalDocs   = 0;
    let totalScopes = 0;

    for (const col of COLLECTIONS) {
      const { docsPatched, scopesPatched } = await migrateCollection(db, col);
      totalDocs   += docsPatched;
      totalScopes += scopesPatched;
    }

    console.log('\n═══════════════════════════════════════════════════════');
    console.log(` TOTAL — Docs: ${totalDocs}  |  scopeDetails: ${totalScopes}`);
    if (DRY_RUN) {
      console.log('\n  ⚠️  Nothing was written. Re-run with --apply to commit.');
    } else {
      console.log('\n  ✅  Migration complete.');
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