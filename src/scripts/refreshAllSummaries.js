'use strict';

/**
 * scripts/refreshAllSummaries.js
 *
 * Recomputes EsgBoundarySummary for every active boundary across all clients.
 * Run this after backfillSubmissionUnits.js so the primaryUnit field gets
 * written into the cached summary documents.
 *
 * Run:
 *   node src/scripts/refreshAllSummaries.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const mongoose = require('mongoose');

async function run() {
  const uri = process.env.MONGO_URI || process.env.DB_URI;
  if (!uri) { console.error('No MONGO_URI / DB_URI in environment'); process.exit(1); }

  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  const EsgLinkBoundary         = require('../modules/esg-link/esgLink_core/boundary/models/EsgLinkBoundary');
  const { refreshAllBoundaryPeriods } = require('../modules/esg-link/esgLink_core/summary/services/summaryService');

  const boundaries = await EsgLinkBoundary.find({ isActive: true, isDeleted: false })
    .select('_id clientId').lean();

  console.log(`Found ${boundaries.length} active boundary/boundaries to refresh\n`);

  let done = 0; let failed = 0;
  for (const b of boundaries) {
    try {
      await refreshAllBoundaryPeriods(b.clientId, b._id);
      done++;
      console.log(`  ✓ ${b.clientId} / boundary ${b._id}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${b.clientId} / boundary ${b._id}:`, err.message);
    }
  }

  console.log(`\nDone. Refreshed: ${done} | Failed: ${failed}`);
  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
