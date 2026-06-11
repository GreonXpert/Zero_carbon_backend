#!/usr/bin/env node
/**
 * scripts/dedup_emission_summary.js
 * ---------------------------------------------------------------------------
 * PRE-DEPLOYMENT MIGRATION — run ONCE before applying the unique compound
 * index  `unique_client_period`  on EmissionSummary.
 *
 * Background: BUG 6 — saveEmissionSummary used findOneAndUpdate({ upsert:true })
 * without a unique index. Concurrent IoT/API saves could create duplicate summary
 * documents for the same (clientId + period.type + period.year + …) combination.
 * This script removes the extras, keeping the MOST RECENTLY UPDATED document.
 *
 * Usage:
 *   NODE_ENV=production node scripts/dedup_emission_summary.js
 *
 * It connects using the same MONGO_URI env var as the main app.
 */

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('❌  MONGO_URI env var is not set.');
  process.exit(1);
}

async function main() {
  console.log('🔌  Connecting to MongoDB...');
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  console.log('✅  Connected.\n');

  const db = mongoose.connection.db;
  const col = db.collection('emissionsummaries');

  // --- 1. Find all groups that have more than one document ----------------
  const dupGroups = await col.aggregate([
    {
      $group: {
        _id: {
          clientId:    '$clientId',
          periodType:  '$period.type',
          periodYear:  '$period.year',
          periodMonth: '$period.month',
          periodWeek:  '$period.week',
          periodDay:   '$period.day',
        },
        ids:        { $push: '$_id' },
        updatedAts: { $push: '$updatedAt' },
        count:      { $sum: 1 },
      }
    },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();

  console.log(`Found ${dupGroups.length} duplicate group(s).\n`);

  if (dupGroups.length === 0) {
    console.log('✅  No duplicates found — safe to apply unique index.');
    await mongoose.disconnect();
    return;
  }

  // --- 2. For each group, keep the most-recently-updated doc ---------------
  let totalRemoved = 0;

  for (const group of dupGroups) {
    // Sort by updatedAt descending — keep first (newest), remove the rest
    const paired = group.ids.map((id, i) => ({
      id,
      updatedAt: group.updatedAts[i] || new Date(0),
    }));
    paired.sort((a, b) => b.updatedAt - a.updatedAt);

    const [keep, ...remove] = paired;
    const removeIds = remove.map(x => x.id);

    console.log(
      `Group ${JSON.stringify(group._id)}: keeping ${keep.id}, removing ${removeIds.length} duplicate(s)`
    );

    const result = await col.deleteMany({ _id: { $in: removeIds } });
    totalRemoved += result.deletedCount;
  }

  console.log(`\n✅  Done — removed ${totalRemoved} duplicate EmissionSummary document(s).`);
  console.log('   You can now safely create the unique_client_period index.');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('❌  Migration failed:', err);
  mongoose.disconnect().finally(() => process.exit(1));
});
