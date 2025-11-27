/**
 * Fixed Migration Script: Adds apiStatus / iotStatus to Reduction.reductionDataEntry
 * Works with MongoDB Atlas AND Local MongoDB.
 */

const mongoose = require("mongoose");
require("dotenv").config({ path: "../.env" }); // adjust path if needed

// ------------------------------
// 1. LOAD MONGO URI SAFELY
// ------------------------------
const MONGO_URI =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  "mongodb://127.0.0.1:27017/zero_carbon"; // fallback ONLY if nothing else exists

console.log("🔗 Using DB URL:", MONGO_URI);

// ------------------------------
// 2. Minimal schema for migration
// ------------------------------
const ReductionSchema = new mongoose.Schema(
  {
    reductionDataEntry: {
      inputType: String,
      originalInputType: String,
      apiEndpoint: String,
      iotDeviceId: String,
      apiStatus: Boolean,
      iotStatus: Boolean
    }
  },
  { collection: "reductions" }
);

const Reduction = mongoose.model("Reduction", ReductionSchema);

// ------------------------------
// 3. Migration logic
// ------------------------------
async function runMigration() {
  console.log("🚀 Starting migration…");

  try {
    // Remove deprecated options (NO useNewUrlParser, NO useUnifiedTopology)
    await mongoose.connect(MONGO_URI);
    console.log("📡 Connected to MongoDB.");
  } catch (err) {
    console.error("❌ MongoDB Connection FAILED");
    console.error("Reason:", err.message);
    console.log("➡ Possible fixes:");
    console.log("1) Ensure MongoDB server is running");
    console.log("2) Ensure your .env file path is correct");
    console.log("3) Ensure your MONGO_URI is correct");
    return;
  }

  const docs = await Reduction.find({});
  console.log(`📄 Found ${docs.length} Reduction documents`);

  let updated = 0;

  for (let doc of docs) {
    let r = doc.reductionDataEntry || {};
    let modified = false;

    if (r.inputType === "API") {
      if (typeof r.apiStatus !== "boolean") {
        r.apiStatus = true;
        modified = true;
      }
      if (typeof r.iotStatus !== "boolean") {
        r.iotStatus = false;
        modified = true;
      }
    } else if (r.inputType === "IOT") {
      if (typeof r.iotStatus !== "boolean") {
        r.iotStatus = true;
        modified = true;
      }
      if (typeof r.apiStatus !== "boolean") {
        r.apiStatus = false;
        modified = true;
      }
    } else {
      // Manual input
      if (typeof r.apiStatus !== "boolean") {
        r.apiStatus = false;
        modified = true;
      }
      if (typeof r.iotStatus !== "boolean") {
        r.iotStatus = false;
        modified = true;
      }
    }

    if (modified) {
      doc.reductionDataEntry = r;
      await doc.save();
      updated++;
    }
  }

  console.log(`✅ Migration complete. Updated: ${updated} documents.`);

  await mongoose.disconnect();
  console.log("🔌 Disconnected.");
}

runMigration();
