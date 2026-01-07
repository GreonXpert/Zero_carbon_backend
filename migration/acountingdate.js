/**
 * Migration: move submissionData.companyInfo.accountingPeriod
 *        -> submissionData.organizationalOverview.accountingPeriod
 *
 * Run: node scripts/migrations/moveAccountingPeriod.js
 */

require("dotenv").config();
const mongoose = require("mongoose");

// ✅ Update path if your Client model export path is different
const Client = require("../models/CMS/Client");

async function run() {
  const uri = 'mongodb+srv://zerocarbon:zerocarbon@zerocarbon.ujopg7s.mongodb.net/zeroCarbon'
  if (!uri) throw new Error("Missing MONGO_URI / MONGODB_URI in .env");

  await mongoose.connect(uri);
  console.log("✅ Connected");

  // Find docs that have old field but missing new field
  const cursor = Client.find(
    {
      "submissionData.companyInfo.accountingPeriod": { $exists: true },
      $or: [
        { "submissionData.organizationalOverview.accountingPeriod": { $exists: false } },
        { "submissionData.organizationalOverview.accountingPeriod": null },
      ],
    },
    {
      clientId: 1,
      "submissionData.companyInfo.accountingPeriod": 1,
      "submissionData.organizationalOverview": 1,
    }
  ).lean().cursor();

  const ops = [];
  let scanned = 0;
  let changed = 0;

  for await (const doc of cursor) {
    scanned++;

    const oldAP = doc?.submissionData?.companyInfo?.accountingPeriod;
    if (!oldAP) continue;

    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: {
          $set: {
            "submissionData.organizationalOverview.accountingPeriod": oldAP,
          },
          // Optional cleanup (uncomment if you want to remove old field)
          // $unset: { "submissionData.companyInfo.accountingPeriod": "" },
        },
      },
    });

    if (ops.length >= 500) {
      const res = await Client.bulkWrite(ops, { ordered: false });
      changed += res.modifiedCount || 0;
      ops.length = 0;
      console.log(`...processed ${scanned}, updated ${changed}`);
    }
  }

  if (ops.length) {
    const res = await Client.bulkWrite(ops, { ordered: false });
    changed += res.modifiedCount || 0;
  }

  console.log(`✅ Done. scanned=${scanned}, updated=${changed}`);
  await mongoose.disconnect();
}

run().catch((e) => {
  console.error("❌ Migration failed:", e);
  process.exit(1);
});
