/**
 * MIGRATION: Normalize EmissionSummary Document Structure
 * 
 * This migration ensures all EmissionSummary documents have data
 * in the nested structure (under emissionSummary field) that the
 * API endpoints expect.
 * 
 * WHAT IT DOES:
 * - Checks if data is at root level
 * - Moves it under emissionSummary field
 * - Preserves all existing data
 * - Does not affect processEmissionSummary or reductionSummary
 * 
 * SAFE:
 * - Only updates documents that need it
 * - Creates backup before updating
 * - Can be rolled back
 * 
 * USAGE:
 * node migrate-normalize-emission-summary.js
 * node migrate-normalize-emission-summary.js --execute
 */

const mongoose = require('mongoose');
const moment = require('moment');

// Configuration
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://zerocarbon:zerocarbon@zerocarbon.ujopg7s.mongodb.net/zeroCarbon';
const CLIENT_ID = "Greon017"; // Optional: migrate specific client only

// Schema
const EmissionSummarySchema = new mongoose.Schema({}, {
  collection: 'emissionsummaries',
  strict: false
});

const EmissionSummary = mongoose.model('EmissionSummary', EmissionSummarySchema);

// ============================================
// MIGRATION LOGIC
// ============================================

/**
 * Check if document needs migration
 */
function needsMigration(doc) {
  // If emissionSummary already exists and has data, it's fine
  if (doc.emissionSummary && doc.emissionSummary.totalEmissions) {
    return false;
  }

  // If data is at root level, needs migration
  if (doc.totalEmissions || doc.byScope || doc.byCategory) {
    return true;
  }

  return false;
}

/**
 * Migrate a single document
 */
function migrateDocument(doc) {
  const migrated = { ...doc };

  // Create emissionSummary if it doesn't exist
  if (!migrated.emissionSummary) {
    migrated.emissionSummary = {};
  }

  // Move root-level fields to emissionSummary
  const fieldsToMove = [
    'totalEmissions',
    'byScope',
    'byCategory',
    'byActivity',
    'byNode',
    'byDepartment',
    'byLocation',
    'byEmissionFactor',
    'byInputType',
    'trends'
  ];

  let moved = false;

  for (const field of fieldsToMove) {
    if (doc[field] && !migrated.emissionSummary[field]) {
      migrated.emissionSummary[field] = doc[field];
      delete migrated[field];
      moved = true;
    }
  }

  if (moved) {
    // Update metadata
    if (!migrated.metadata) {
      migrated.metadata = {};
    }
    migrated.metadata.migratedAt = new Date();
    migrated.metadata.migrationReason = 'Normalized structure to nested emissionSummary';
  }

  return moved ? migrated : null;
}

// ============================================
// MAIN MIGRATION FUNCTION
// ============================================

async function migrate() {
  let connection = null;

  try {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║     EmissionSummary Structure Normalization Migration     ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    console.log('Connecting to MongoDB...');
    connection = await mongoose.connect(MONGO_URI);
    console.log('✓ Connected\n');

    // Build query
    const query = {};
    if (CLIENT_ID) {
      query.clientId = CLIENT_ID;
      console.log(`Filtering by clientId: ${CLIENT_ID}\n`);
    }

    // Count total documents
    const totalDocs = await EmissionSummary.countDocuments(query);
    console.log(`📊 Total documents to check: ${totalDocs}\n`);

    if (totalDocs === 0) {
      console.log('No documents found. Exiting.');
      return;
    }

    // Check if --execute flag is present
    const shouldExecute = process.argv.includes('--execute');
    const shouldBackup = process.argv.includes('--backup');

    if (!shouldExecute) {
      console.log('⚠️  DRY RUN MODE');
      console.log('   Add --execute flag to actually update documents');
      console.log('   Add --backup flag to create backup collection first\n');
    }

    // Create backup if requested
    if (shouldBackup && shouldExecute) {
      console.log('📦 Creating backup...');
      const backupName = `emissionsummaries_backup_${Date.now()}`;
      await EmissionSummary.collection.aggregate([
        { $match: query },
        { $out: backupName }
      ]).toArray();
      console.log(`✓ Backup created: ${backupName}\n`);
    }

    // Process documents in batches
    const BATCH_SIZE = 100;
    let processed = 0;
    let needsUpdate = 0;
    let updated = 0;
    let errors = 0;

    console.log('🔄 Processing documents...\n');

    while (processed < totalDocs) {
      const docs = await EmissionSummary.find(query)
        .skip(processed)
        .limit(BATCH_SIZE)
        .lean();

      for (const doc of docs) {
        processed++;

        try {
          // Check if migration needed
          if (!needsMigration(doc)) {
            if (processed % 100 === 0) {
              console.log(`   Checked: ${processed}/${totalDocs} (${needsUpdate} need update)`);
            }
            continue;
          }

          needsUpdate++;

          // Show what would be migrated
          console.log(`\n📄 Document ${doc._id}:`);
          console.log(`   Client: ${doc.clientId}`);
          console.log(`   Period: ${doc.period?.type} (${moment(doc.period?.from).format('YYYY-MM-DD')})`);
          console.log(`   Has root totalEmissions: ${!!doc.totalEmissions}`);
          console.log(`   Has root byScope: ${!!doc.byScope}`);
          console.log(`   Has root byCategory: ${!!doc.byCategory}`);
          console.log(`   CO2e at root: ${doc.totalEmissions?.CO2e || 0}`);

          // Perform migration
          const migrated = migrateDocument(doc);

          if (migrated && shouldExecute) {
            // Update document
            await EmissionSummary.updateOne(
              { _id: doc._id },
              { $set: migrated }
            );
            updated++;
            console.log('   ✓ Updated');
          } else if (migrated) {
            console.log('   ℹ️  Would be updated (dry run)');
          }

        } catch (err) {
          console.error(`   ❌ Error: ${err.message}`);
          errors++;
        }
      }
    }

    // Final summary
    console.log('\n' + '═'.repeat(60));
    console.log('MIGRATION SUMMARY');
    console.log('═'.repeat(60));
    console.log(`\nTotal documents checked: ${processed}`);
    console.log(`Documents needing update: ${needsUpdate}`);
    
    if (shouldExecute) {
      console.log(`Documents updated: ${updated}`);
      console.log(`Errors: ${errors}`);
    } else {
      console.log(`Would update: ${needsUpdate} documents`);
    }

    if (!shouldExecute && needsUpdate > 0) {
      console.log('\n💡 To execute migration, run:');
      console.log('   node migrate-normalize-emission-summary.js --execute');
      console.log('\n💡 To create backup first:');
      console.log('   node migrate-normalize-emission-summary.js --execute --backup');
    }

    if (shouldExecute && updated > 0) {
      console.log('\n✅ Migration complete!');
      console.log('   Your endpoints should now return non-zero values.');
      console.log('   Test with: GET /api/summaries/:clientId/top-low-stats');
    }

  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    throw error;
  } finally {
    if (connection) {
      await mongoose.connection.close();
      console.log('\n✓ Connection closed');
    }
  }
}

// ============================================
// ROLLBACK FUNCTION
// ============================================

async function rollback(backupCollection) {
  try {
    console.log(`Rolling back from ${backupCollection}...`);
    
    await mongoose.connect(MONGO_URI);
    
    const db = mongoose.connection.db;
    const backup = db.collection(backupCollection);
    const count = await backup.countDocuments();
    
    if (count === 0) {
      console.log('Backup collection is empty!');
      return;
    }

    // Restore from backup
    const docs = await backup.find().toArray();
    
    for (const doc of docs) {
      await EmissionSummary.updateOne(
        { _id: doc._id },
        { $set: doc },
        { upsert: true }
      );
    }

    console.log(`✓ Rolled back ${count} documents`);
    
    await mongoose.connection.close();
  } catch (error) {
    console.error('Rollback failed:', error);
  }
}

// ============================================
// VERIFICATION FUNCTION
// ============================================

async function verify() {
  try {
    console.log('Verifying migration...\n');
    
    await mongoose.connect(MONGO_URI);

    const query = {};
    if (CLIENT_ID) query.clientId = CLIENT_ID;

    // Check all documents
    const total = await EmissionSummary.countDocuments(query);
    const withNested = await EmissionSummary.countDocuments({
      ...query,
      'emissionSummary.totalEmissions': { $exists: true }
    });
    const withRoot = await EmissionSummary.countDocuments({
      ...query,
      'totalEmissions': { $exists: true },
      'emissionSummary.totalEmissions': { $exists: false }
    });

    console.log('📊 Verification Results:');
    console.log(`   Total documents: ${total}`);
    console.log(`   With nested structure: ${withNested} ✓`);
    console.log(`   Still at root level: ${withRoot} ${withRoot > 0 ? '⚠️' : '✓'}`);

    // Sample a document
    const sample = await EmissionSummary.findOne(query).lean();
    if (sample) {
      console.log('\n📄 Sample document structure:');
      console.log(`   Has emissionSummary: ${!!sample.emissionSummary}`);
      console.log(`   Has emissionSummary.totalEmissions: ${!!sample.emissionSummary?.totalEmissions}`);
      console.log(`   CO2e: ${sample.emissionSummary?.totalEmissions?.CO2e || 0}`);
    }

    if (withRoot === 0) {
      console.log('\n✅ All documents have correct structure!');
    } else {
      console.log('\n⚠️  Some documents still need migration');
    }

    await mongoose.connection.close();
  } catch (error) {
    console.error('Verification failed:', error);
  }
}

// ============================================
// CLI HANDLING
// ============================================

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--rollback')) {
    const backupName = args[args.indexOf('--rollback') + 1];
    if (!backupName) {
      console.error('Please provide backup collection name');
      console.error('Usage: node migrate.js --rollback <backup_collection_name>');
      process.exit(1);
    }
    rollback(backupName);
  } else if (args.includes('--verify')) {
    verify();
  } else {
    migrate().then(() => {
      process.exit(0);
    }).catch(err => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
  }
}

module.exports = { migrate, rollback, verify };