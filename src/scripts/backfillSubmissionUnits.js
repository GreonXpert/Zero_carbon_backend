'use strict';

/**
 * scripts/backfillSubmissionUnits.js
 *
 * One-time migration: for every EsgDataEntry whose unitOfMeasurement is blank,
 * fetch the metric's primaryUnit from EsgMetric and write it back.
 *
 * Run:
 *   node src/scripts/backfillSubmissionUnits.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const mongoose = require('mongoose');

async function run() {
  const uri = process.env.MONGO_URI || process.env.DB_URI;
  if (!uri) { console.error('No MONGO_URI / DB_URI in environment'); process.exit(1); }

  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  // Dynamic model loading — avoids circular-require issues with the full app
  const EsgDataEntry = require('../modules/esg-link/esgLink_core/data-collection/models/EsgDataEntry');
  const EsgMetric    = require('../modules/esg-link/esgLink_core/metric/models/EsgMetric');

  // Find all submissions with empty unit that have a metricId reference
  const cursor = EsgDataEntry.find({
    metricId: { $exists: true, $ne: null },
    $or: [
      { unitOfMeasurement: { $exists: false } },
      { unitOfMeasurement: '' },
      { unitOfMeasurement: null },
    ],
  }).select('_id metricId unitOfMeasurement').lean().cursor();

  // Build a cache so we don't hit the DB for every document
  const unitCache = {};

  let updated = 0;
  let skipped = 0;
  let errors  = 0;

  for await (const doc of cursor) {
    const metricId = String(doc.metricId);

    if (!(metricId in unitCache)) {
      const metric = await EsgMetric.findById(metricId).select('primaryUnit').lean();
      unitCache[metricId] = metric?.primaryUnit || null;
    }

    const unit = unitCache[metricId];
    if (!unit) { skipped++; continue; }

    try {
      await EsgDataEntry.updateOne({ _id: doc._id }, { $set: { unitOfMeasurement: unit } });
      updated++;
      if (updated % 100 === 0) console.log(`  Updated ${updated} records…`);
    } catch (err) {
      console.error(`  Failed to update ${doc._id}:`, err.message);
      errors++;
    }
  }

  console.log(`\nDone. Updated: ${updated} | Skipped (no metric unit): ${skipped} | Errors: ${errors}`);
  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
