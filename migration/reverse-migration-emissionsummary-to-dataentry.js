/**
 * REVERSE MIGRATION: EmissionSummary → DataEntry
 * 
 * This script extracts individual DataEntry records from pre-aggregated EmissionSummary documents.
 * 
 * PURPOSE:
 * - Your compare endpoint expects DataEntry collection to exist
 * - Currently only EmissionSummary exists (pre-aggregated data)
 * - This script reconstructs DataEntry records from summaries
 * 
 * LIMITATIONS:
 * - Cannot perfectly recreate original entries (aggregation lost details)
 * - Creates "representative" entries based on dataPointCount
 * - Distributes emissions evenly across data points
 * 
 * USAGE:
 * node reverse-migration-emissionsummary-to-dataentry.js
 */

const mongoose = require('mongoose');
const moment = require('moment');

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://zerocarbon:zerocarbon@zerocarbon.ujopg7s.mongodb.net/zeroCarbon';

// ============================================
// SCHEMAS
// ============================================

const EmissionSummarySchema = new mongoose.Schema({
  period: {
    type: { type: String, required: true },
    year: Number,
    month: Number,
    week: Number,
    day: Number,
    from: Date,
    to: Date,
  },
  clientId: { type: String, required: true, index: true },
  emissionSummary: {
    totalEmissions: {
      CO2e: Number,
      CO2: Number,
      CH4: Number,
      N2O: Number,
      uncertainty: Number,
    },
    byScope: mongoose.Schema.Types.Mixed,
    byCategory: mongoose.Schema.Types.Mixed,
    byActivity: mongoose.Schema.Types.Mixed,
    byNode: mongoose.Schema.Types.Mixed,
    byDepartment: mongoose.Schema.Types.Mixed,
    byLocation: mongoose.Schema.Types.Mixed,
    byInputType: mongoose.Schema.Types.Mixed,
    byEmissionFactor: mongoose.Schema.Types.Mixed,
    trends: mongoose.Schema.Types.Mixed,
  },
  createdAt: { type: Date, default: Date.now },
}, { collection: 'emissionsummaries' });

const DataEntrySchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  nodeId: { type: String, index: true },
  scopeType: { type: String, index: true },
  scopeIdentifier: { type: String, index: true },
  categoryName: String,
  activity: String,
  location: String,
  department: String,
  timestamp: { type: Date, required: true, index: true },
  processingStatus: { type: String, default: 'processed', index: true },
  calculatedEmissions: {
    CO2e: { type: Number, default: 0 },
    CO2: { type: Number, default: 0 },
    CH4: { type: Number, default: 0 },
    N2O: { type: Number, default: 0 },
    uncertainty: { type: Number, default: 0 },
  },
  inputType: { type: String, default: 'manual' },
  sourceType: { type: String, default: 'reverse-migration' },
  metadata: {
    originalSummaryId: mongoose.Schema.Types.ObjectId,
    reconstructed: { type: Boolean, default: true },
  },
  createdAt: { type: Date, default: Date.now },
}, { collection: 'dataentries' });

const EmissionSummary = mongoose.model('EmissionSummary', EmissionSummarySchema);
const DataEntry = mongoose.model('DataEntry', DataEntrySchema);

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Generate timestamps evenly distributed across the period
 */
function generateTimestamps(fromDate, toDate, count) {
  if (count <= 0) return [];
  if (count === 1) return [moment(fromDate).toDate()];

  const timestamps = [];
  const start = moment(fromDate);
  const end = moment(toDate);
  const totalMs = end.diff(start);
  const intervalMs = totalMs / (count - 1);

  for (let i = 0; i < count; i++) {
    const ts = moment(start).add(intervalMs * i, 'milliseconds');
    timestamps.push(ts.toDate());
  }

  return timestamps;
}

/**
 * Distribute emissions evenly across data points
 */
function distributeEmissions(totalEmissions, count) {
  if (count <= 0) return [];

  const perEntry = {
    CO2e: (totalEmissions.CO2e || 0) / count,
    CO2: (totalEmissions.CO2 || 0) / count,
    CH4: (totalEmissions.CH4 || 0) / count,
    N2O: (totalEmissions.N2O || 0) / count,
    uncertainty: (totalEmissions.uncertainty || 0) / count,
  };

  return Array(count).fill(perEntry);
}

/**
 * Extract node ID from node label (if embedded) or generate placeholder
 */
function extractNodeId(nodeLabel, index) {
  // Try to extract ID from label like "nodeName-123" or "node_abc"
  const match = nodeLabel.match(/[-_]([a-zA-Z0-9]+)$/);
  if (match) return match[1];
  
  // Generate placeholder based on label
  const sanitized = nodeLabel.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  return `${sanitized}-${index}`;
}

/**
 * Generate scopeIdentifier (combination of scope + category + activity)
 */
function generateScopeIdentifier(scopeType, categoryName, activity, index) {
  const scope = (scopeType || 'unknown').replace(/[^a-zA-Z0-9]/g, '');
  const category = (categoryName || 'unknown').replace(/[^a-zA-Z0-9]/g, '');
  const act = (activity || 'unknown').replace(/[^a-zA-Z0-9]/g, '');
  return `${scope}-${category}-${act}-${index}`.toLowerCase();
}

// ============================================
// MAIN MIGRATION LOGIC
// ============================================

async function reverseMigrate() {
  let connection = null;

  try {
    console.log('Connecting to MongoDB...');
    connection = await mongoose.connect(MONGO_URI);
    console.log('✓ Connected to MongoDB\n');

    // Get counts
    const summaryCount = await EmissionSummary.countDocuments();
    const existingEntryCount = await DataEntry.countDocuments();

    console.log(`📊 Current State:`);
    console.log(`   EmissionSummary documents: ${summaryCount}`);
    console.log(`   Existing DataEntry documents: ${existingEntryCount}\n`);

    if (summaryCount === 0) {
      console.log('❌ No EmissionSummary documents found. Nothing to migrate.');
      return;
    }

    // Ask for confirmation in production
    const shouldProceed = process.argv.includes('--execute');
    if (!shouldProceed) {
      console.log('⚠️  DRY RUN MODE');
      console.log('   Add --execute flag to actually create DataEntry records\n');
    }

    // Process in batches
    const BATCH_SIZE = 100;
    let processedCount = 0;
    let createdEntries = 0;
    let skippedCount = 0;

    console.log(`🔄 Processing summaries in batches of ${BATCH_SIZE}...\n`);

    while (processedCount < summaryCount) {
      const summaries = await EmissionSummary.find()
        .skip(processedCount)
        .limit(BATCH_SIZE)
        .lean();

      for (const summary of summaries) {
        try {
          const entries = await extractEntriesFromSummary(summary);
          
          if (shouldProceed) {
            if (entries.length > 0) {
              await DataEntry.insertMany(entries, { ordered: false });
              createdEntries += entries.length;
            }
          } else {
            createdEntries += entries.length; // Dry run count
          }

          processedCount++;

          if (processedCount % 10 === 0) {
            console.log(`   Processed: ${processedCount}/${summaryCount} summaries, Generated: ${createdEntries} entries`);
          }

        } catch (err) {
          console.error(`   ⚠️  Error processing summary ${summary._id}:`, err.message);
          skippedCount++;
        }
      }
    }

    console.log(`\n✅ Migration Complete!`);
    console.log(`   Processed summaries: ${processedCount}`);
    console.log(`   ${shouldProceed ? 'Created' : 'Would create'} DataEntry records: ${createdEntries}`);
    console.log(`   Skipped (errors): ${skippedCount}`);

    if (!shouldProceed) {
      console.log(`\n💡 To execute migration, run:`);
      console.log(`   node reverse-migration-emissionsummary-to-dataentry.js --execute`);
    }

  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    if (connection) {
      await mongoose.connection.close();
      console.log('\n✓ Database connection closed');
    }
  }
}

/**
 * Extract individual DataEntry records from a single EmissionSummary
 */
async function extractEntriesFromSummary(summary) {
  const entries = [];
  const { period, clientId, emissionSummary } = summary;

  if (!emissionSummary || !period) return entries;

  const fromDate = period.from;
  const toDate = period.to;

  // Strategy: Use byActivity as the primary source (most detailed breakdown)
  const byActivity = emissionSummary.byActivity || {};

  for (const [activityName, activityData] of Object.entries(byActivity)) {
    const scopeType = activityData.scopeType || 'Unknown';
    const categoryName = activityData.categoryName || 'Unknown Category';
    const dataPointCount = activityData.dataPointCount || 1;

    // Find matching node from byNode
    let nodeInfo = null;
    const byNode = emissionSummary.byNode || {};
    
    // Try to find a node that has emissions in this scope
    for (const [nodeName, nodeData] of Object.entries(byNode)) {
      const nodeScopes = nodeData.byScope || {};
      if (nodeScopes[scopeType] && nodeScopes[scopeType].CO2e > 0) {
        nodeInfo = {
          nodeLabel: nodeName,
          department: nodeData.department || 'Unknown Department',
          location: nodeData.location || 'Unknown Location',
        };
        break;
      }
    }

    // Fallback: use first node or create default
    if (!nodeInfo) {
      const firstNode = Object.entries(byNode)[0];
      if (firstNode) {
        const [nodeName, nodeData] = firstNode;
        nodeInfo = {
          nodeLabel: nodeName,
          department: nodeData.department || 'Unknown Department',
          location: nodeData.location || 'Unknown Location',
        };
      } else {
        nodeInfo = {
          nodeLabel: 'Default Node',
          department: 'Unknown Department',
          location: 'Unknown Location',
        };
      }
    }

    // Generate timestamps and distribute emissions
    const timestamps = generateTimestamps(fromDate, toDate, dataPointCount);
    const emissionsList = distributeEmissions(activityData, dataPointCount);

    // Create entries
    for (let i = 0; i < dataPointCount; i++) {
      const nodeId = extractNodeId(nodeInfo.nodeLabel, i);
      const scopeIdentifier = generateScopeIdentifier(scopeType, categoryName, activityName, i);

      entries.push({
        clientId,
        nodeId,
        scopeType,
        scopeIdentifier,
        categoryName,
        activity: activityName,
        location: nodeInfo.location,
        department: nodeInfo.department,
        timestamp: timestamps[i] || fromDate,
        processingStatus: 'processed',
        calculatedEmissions: emissionsList[i] || {
          CO2e: 0,
          CO2: 0,
          CH4: 0,
          N2O: 0,
          uncertainty: 0,
        },
        inputType: 'manual',
        sourceType: 'reverse-migration',
        metadata: {
          originalSummaryId: summary._id,
          reconstructed: true,
          periodType: period.type,
        },
      });
    }
  }

  // If no activities found, try to extract from byCategory
  if (entries.length === 0) {
    const byCategory = emissionSummary.byCategory || {};
    
    for (const [categoryName, categoryData] of Object.entries(byCategory)) {
      const scopeType = categoryData.scopeType || 'Unknown';
      const dataPointCount = categoryData.dataPointCount || 1;
      
      // Use activities within category if available
      const activities = categoryData.activities || {};
      
      if (Object.keys(activities).length > 0) {
        for (const [activityName, activityData] of Object.entries(activities)) {
          const actDataPointCount = activityData.dataPointCount || 1;
          const timestamps = generateTimestamps(fromDate, toDate, actDataPointCount);
          const emissionsList = distributeEmissions(activityData, actDataPointCount);

          for (let i = 0; i < actDataPointCount; i++) {
            entries.push({
              clientId,
              nodeId: 'default-node',
              scopeType,
              scopeIdentifier: generateScopeIdentifier(scopeType, categoryName, activityName, i),
              categoryName,
              activity: activityName,
              location: 'Unknown Location',
              department: 'Unknown Department',
              timestamp: timestamps[i] || fromDate,
              processingStatus: 'processed',
              calculatedEmissions: emissionsList[i],
              inputType: 'manual',
              sourceType: 'reverse-migration',
              metadata: {
                originalSummaryId: summary._id,
                reconstructed: true,
                periodType: period.type,
              },
            });
          }
        }
      } else {
        // No activities, create entries from category level
        const timestamps = generateTimestamps(fromDate, toDate, dataPointCount);
        const emissionsList = distributeEmissions(categoryData, dataPointCount);

        for (let i = 0; i < dataPointCount; i++) {
          entries.push({
            clientId,
            nodeId: 'default-node',
            scopeType,
            scopeIdentifier: generateScopeIdentifier(scopeType, categoryName, 'Unknown Activity', i),
            categoryName,
            activity: 'Unknown Activity',
            location: 'Unknown Location',
            department: 'Unknown Department',
            timestamp: timestamps[i] || fromDate,
            processingStatus: 'processed',
            calculatedEmissions: emissionsList[i],
            inputType: 'manual',
            sourceType: 'reverse-migration',
            metadata: {
              originalSummaryId: summary._id,
              reconstructed: true,
              periodType: period.type,
            },
          });
        }
      }
    }
  }

  return entries;
}

// ============================================
// VERIFICATION FUNCTION
// ============================================

async function verifyMigration() {
  try {
    console.log('\n📊 Verification Report');
    console.log('='.repeat(50));

    const totalEntries = await DataEntry.countDocuments();
    const reconstructedEntries = await DataEntry.countDocuments({ 'metadata.reconstructed': true });
    const clientGroups = await DataEntry.aggregate([
      { $group: { _id: '$clientId', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    console.log(`\nTotal DataEntry records: ${totalEntries}`);
    console.log(`Reconstructed entries: ${reconstructedEntries}`);
    console.log(`\nEntries by client:`);
    clientGroups.forEach(g => {
      console.log(`   ${g._id}: ${g.count} entries`);
    });

    // Sample entry
    const sampleEntry = await DataEntry.findOne({ 'metadata.reconstructed': true }).lean();
    if (sampleEntry) {
      console.log(`\nSample reconstructed entry:`);
      console.log(JSON.stringify(sampleEntry, null, 2));
    }

  } catch (error) {
    console.error('Verification failed:', error);
  }
}

// ============================================
// RUN MIGRATION
// ============================================

if (require.main === module) {
  reverseMigrate()
    .then(() => {
      if (process.argv.includes('--verify')) {
        return verifyMigration();
      }
    })
    .then(() => {
      console.log('\n✅ All done!');
      process.exit(0);
    })
    .catch(err => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
}

module.exports = { reverseMigrate, verifyMigration };