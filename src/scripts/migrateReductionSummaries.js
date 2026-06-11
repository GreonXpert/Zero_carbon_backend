/**
 * scripts/migrateReductionSummaries.js
 *
 * One-time migration: rebuilds all EmissionSummary reductionSummary documents
 * for every client that has NetReductionEntry data, populating the new
 * m1Summary and m2Summary fields alongside the existing m3Summary.
 *
 * Run once after deploying the updated netReductionSummaryController.js:
 *   node src/scripts/migrateReductionSummaries.js
 *
 * Or trigger via HTTP (super_admin / consultant_admin only):
 *   POST /api/reductions/backfill-all
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const mongoose = require('mongoose');
const { recomputeAllClientsReductionSummary } = require('../modules/zero-carbon/reduction/controllers/netReductionSummaryController');

async function run() {
  await mongoose.connect(process.env.MONGO_URI || process.env.DB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  console.log('[migrate] Connected to MongoDB');

  const results = await recomputeAllClientsReductionSummary();

  if (!results.clients.length) {
    console.log('[migrate] No NetReductionEntry documents found — nothing to migrate.');
  } else {
    for (const c of results.clients) {
      if (c.status === 'ok') {
        console.log(`[migrate] ✓ ${c.clientId}: ${c.periodsUpdated} period(s) updated`);
      } else {
        console.error(`[migrate] ✗ ${c.clientId}: ${c.message}`);
      }
    }
    console.log(`\n[migrate] Done — succeeded: ${results.succeeded}, failed: ${results.failed}`);
  }

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('[migrate] Fatal error:', err);
  process.exit(1);
});
