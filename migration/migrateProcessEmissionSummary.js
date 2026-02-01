// ============================================================================
// MIGRATION SCRIPT: Add processEmissionSummary to Existing Documents
// ============================================================================
// 
// This script migrates all existing EmissionSummary documents to include
// the new processEmissionSummary field.
//
// USAGE:
//   node migration/addProcessEmissionSummary.js
//
// OPTIONS:
//   --dry-run    : Preview changes without updating database
//   --client     : Migrate specific client only (e.g. --client=CLIENT_123)
//   --limit      : Limit number of documents to process (e.g. --limit=10)
//   --rollback   : Remove processEmissionSummary field (restore to original)
//
// EXAMPLES:
//   node migration/addProcessEmissionSummary.js --dry-run
//   node migration/addProcessEmissionSummary.js --client=Greon017
//   node migration/addProcessEmissionSummary.js --limit=10
//   node migration/addProcessEmissionSummary.js --rollback
//
// ============================================================================

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Import models
const EmissionSummary = require('../models/CalculationEmission/EmissionSummary');
const ProcessFlowchart = require('../models/Organization/ProcessFlowchart');
const DataEntry = require('../models/Organization/DataEntry');

// Import helper functions from CalculationSummary
const {
  extractEmissionValues,
  addEmissionValues,
  ensureMapEntry,
  buildDateRange,
  getPreviousPeriod,
  calculateTrends
} = require('../controllers/Calculation/CalculationSummary');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  dryRun: process.argv.includes('--dry-run'),
  rollback: process.argv.includes('--rollback'),
  specificClient: process.argv.find(arg => arg.startsWith('--client='))?.split('=')[1],
  limit: parseInt(process.argv.find(arg => arg.startsWith('--limit='))?.split('=')[1] || '0'),
  batchSize: 50, // Process documents in batches
  logInterval: 10 // Log progress every N documents
};

// ============================================================================
// STATISTICS TRACKING
// ============================================================================

const stats = {
  totalDocuments: 0,
  processed: 0,
  updated: 0,
  skipped: 0,
  errors: 0,
  noProcessFlowchart: 0,
  noValidNodes: 0,
  noDataEntries: 0,
  startTime: null,
  endTime: null,
  errorDetails: []
};

// ============================================================================
// HELPER: Calculate Process Emission Summary (Simplified for Migration)
// ============================================================================

async function calculateProcessEmissionSummaryForMigration(clientId, period) {
  try {
    // 1. Load ProcessFlowchart
    const processFlowchart = await ProcessFlowchart.findOne({
      clientId,
      isDeleted: false
    }).lean();
    
    if (!processFlowchart || !processFlowchart.nodes || processFlowchart.nodes.length === 0) {
      stats.noProcessFlowchart++;
      return null;
    }
    
    // 2. Build allowed pairs
    const allowedPairs = new Map();
    const nodeMetadata = new Map();
    
    for (const node of processFlowchart.nodes) {
      const nodeId = node.id;
      const scopeDetails = node.details?.scopeDetails || [];
      
      const validScopes = scopeDetails.filter(scope => 
        scope.isDeleted !== true && scope.fromOtherChart !== true
      );
      
      if (validScopes.length > 0) {
        allowedPairs.set(nodeId, new Set(validScopes.map(s => s.scopeIdentifier)));
        nodeMetadata.set(nodeId, {
          label: node.label,
          department: node.details?.department || 'Unknown',
          location: node.details?.location || 'Unknown',
          scopes: validScopes.map(s => ({
            scopeIdentifier: s.scopeIdentifier,
            scopeType: s.scopeType,
            categoryName: s.categoryName,
            activity: s.activity
          }))
        });
      }
    }
    
    if (allowedPairs.size === 0) {
      stats.noValidNodes++;
      return null;
    }
    
    // 3. Query DataEntry records
    const { from, to } = buildDateRange(
      period.type,
      period.year,
      period.month,
      period.week,
      period.day
    );
    
    const dataEntries = await DataEntry.find({
      clientId,
      processingStatus: 'processed',
      timestamp: { $gte: from, $lte: to }
    }).lean();
    
    if (dataEntries.length === 0) {
      stats.noDataEntries++;
      return null;
    }
    
    // 4. Initialize summary structure
    const processEmissionSummary = {
      period: { ...period, from, to },
      totalEmissions: { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0 },
      byScope: {
        'Scope 1': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
        'Scope 2': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
        'Scope 3': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 }
      },
      byCategory: {},
      byActivity: {},
      byNode: {},
      byDepartment: {},
      byLocation: {},
      byInputType: {
        manual: { CO2e: 0, dataPointCount: 0 },
        API: { CO2e: 0, dataPointCount: 0 },
        IOT: { CO2e: 0, dataPointCount: 0 }
      },
      byEmissionFactor: {},
      trends: {},
      metadata: {
        totalDataPoints: 0,
        dataEntriesIncluded: [],
        lastCalculated: new Date(),
        version: 1,
        isComplete: true,
        hasErrors: false,
        errors: []
      }
    };
    
    // 5. Filter and aggregate
    let includedCount = 0;
    
    for (const entry of dataEntries) {
      const { nodeId, scopeIdentifier, scopeType } = entry;
      
      // Filter
      if (!allowedPairs.has(nodeId) || !allowedPairs.get(nodeId).has(scopeIdentifier)) {
        continue;
      }
      
      const emissionValues = extractEmissionValues(entry.calculatedEmissions);
      if (emissionValues.CO2e === 0) continue;
      
      includedCount++;
      
      const nodeMeta = nodeMetadata.get(nodeId);
      const scopeMeta = nodeMeta.scopes.find(s => s.scopeIdentifier === scopeIdentifier);
      const categoryName = scopeMeta?.categoryName || entry.categoryName || 'Unknown Category';
      const activity = scopeMeta?.activity || entry.activity || 'Unknown Activity';
      
      // Aggregate totals
      addEmissionValues(processEmissionSummary.totalEmissions, emissionValues);
      
      // Aggregate by scope
      if (processEmissionSummary.byScope[scopeType]) {
        addEmissionValues(processEmissionSummary.byScope[scopeType], emissionValues);
        processEmissionSummary.byScope[scopeType].dataPointCount += 1;
      }
      
      // Aggregate by category
      if (!processEmissionSummary.byCategory[categoryName]) {
        processEmissionSummary.byCategory[categoryName] = {
          scopeType,
          CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0,
          dataPointCount: 0,
          activities: {}
        };
      }
      addEmissionValues(processEmissionSummary.byCategory[categoryName], emissionValues);
      processEmissionSummary.byCategory[categoryName].dataPointCount++;
      
      // Category -> Activity
      if (!processEmissionSummary.byCategory[categoryName].activities[activity]) {
        processEmissionSummary.byCategory[categoryName].activities[activity] = {
          CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0
        };
      }
      addEmissionValues(
        processEmissionSummary.byCategory[categoryName].activities[activity],
        emissionValues
      );
      processEmissionSummary.byCategory[categoryName].activities[activity].dataPointCount++;
      
      // Aggregate by activity
      if (!processEmissionSummary.byActivity[activity]) {
        processEmissionSummary.byActivity[activity] = {
          scopeType,
          categoryName,
          CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0,
          dataPointCount: 0
        };
      }
      addEmissionValues(processEmissionSummary.byActivity[activity], emissionValues);
      processEmissionSummary.byActivity[activity].dataPointCount++;
      
      // Aggregate by node
      if (!processEmissionSummary.byNode[nodeId]) {
        processEmissionSummary.byNode[nodeId] = {
          nodeLabel: nodeMeta.label,
          department: nodeMeta.department,
          location: nodeMeta.location,
          CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0,
          dataPointCount: 0,
          byScope: {
            'Scope 1': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
            'Scope 2': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
            'Scope 3': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 }
          }
        };
      }
      addEmissionValues(processEmissionSummary.byNode[nodeId], emissionValues);
      processEmissionSummary.byNode[nodeId].dataPointCount++;
      if (processEmissionSummary.byNode[nodeId].byScope[scopeType]) {
        addEmissionValues(processEmissionSummary.byNode[nodeId].byScope[scopeType], emissionValues);
        processEmissionSummary.byNode[nodeId].byScope[scopeType].dataPointCount++;
      }
      
      // Aggregate by department
      const dept = nodeMeta.department;
      if (!processEmissionSummary.byDepartment[dept]) {
        processEmissionSummary.byDepartment[dept] = {
          CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0,
          dataPointCount: 0,
          nodeCount: 0
        };
      }
      addEmissionValues(processEmissionSummary.byDepartment[dept], emissionValues);
      processEmissionSummary.byDepartment[dept].dataPointCount++;
      
      // Aggregate by location
      const loc = nodeMeta.location;
      if (!processEmissionSummary.byLocation[loc]) {
        processEmissionSummary.byLocation[loc] = {
          CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0,
          dataPointCount: 0,
          nodeCount: 0
        };
      }
      addEmissionValues(processEmissionSummary.byLocation[loc], emissionValues);
      processEmissionSummary.byLocation[loc].dataPointCount++;
      
      // Aggregate by input type
      if (processEmissionSummary.byInputType[entry.inputType]) {
        processEmissionSummary.byInputType[entry.inputType].CO2e += emissionValues.CO2e;
        processEmissionSummary.byInputType[entry.inputType].dataPointCount++;
      }
      
      // Aggregate by emission factor
      const efSource = entry.emissionFactor || 'Unknown';
      if (!processEmissionSummary.byEmissionFactor[efSource]) {
        processEmissionSummary.byEmissionFactor[efSource] = {
          CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0,
          dataPointCount: 0,
          scopeTypes: { 'Scope 1': 0, 'Scope 2': 0, 'Scope 3': 0 }
        };
      }
      addEmissionValues(processEmissionSummary.byEmissionFactor[efSource], emissionValues);
      processEmissionSummary.byEmissionFactor[efSource].dataPointCount++;
      if (processEmissionSummary.byEmissionFactor[efSource].scopeTypes[scopeType] !== undefined) {
        processEmissionSummary.byEmissionFactor[efSource].scopeTypes[scopeType]++;
      }
      
      processEmissionSummary.metadata.dataEntriesIncluded.push(entry._id);
    }
    
    processEmissionSummary.metadata.totalDataPoints = includedCount;
    
    // Calculate node counts for departments and locations
    const uniqueDept = {};
    const uniqueLoc = {};
    
    for (const [nodeId, nodeData] of Object.entries(processEmissionSummary.byNode)) {
      if (!uniqueDept[nodeData.department]) uniqueDept[nodeData.department] = new Set();
      uniqueDept[nodeData.department].add(nodeId);
      
      if (!uniqueLoc[nodeData.location]) uniqueLoc[nodeData.location] = new Set();
      uniqueLoc[nodeData.location].add(nodeId);
    }
    
    for (const [dept, nodeSet] of Object.entries(uniqueDept)) {
      if (processEmissionSummary.byDepartment[dept]) {
        processEmissionSummary.byDepartment[dept].nodeCount = nodeSet.size;
      }
    }
    
    for (const [loc, nodeSet] of Object.entries(uniqueLoc)) {
      if (processEmissionSummary.byLocation[loc]) {
        processEmissionSummary.byLocation[loc].nodeCount = nodeSet.size;
      }
    }
    
    return processEmissionSummary;
    
  } catch (error) {
    console.error('Error calculating process emission summary:', error);
    throw error;
  }
}

// ============================================================================
// MIGRATION: Add processEmissionSummary to Documents
// ============================================================================

async function migrateDocument(doc) {
  try {
    stats.processed++;
    
    // Log progress
    if (stats.processed % CONFIG.logInterval === 0) {
      console.log(`Progress: ${stats.processed}/${stats.totalDocuments} documents processed...`);
    }
    
    // Skip if already has processEmissionSummary (unless rollback mode)
    if (!CONFIG.rollback && doc.processEmissionSummary) {
      stats.skipped++;
      return { success: true, skipped: true };
    }
    
    // ROLLBACK MODE: Remove processEmissionSummary
    if (CONFIG.rollback) {
      if (!CONFIG.dryRun) {
        await EmissionSummary.updateOne(
          { _id: doc._id },
          { $unset: { processEmissionSummary: "" } }
        );
      }
      stats.updated++;
      return { success: true, action: 'removed' };
    }
    
    // NORMAL MODE: Calculate and add processEmissionSummary
    const processEmissionSummary = await calculateProcessEmissionSummaryForMigration(
      doc.clientId,
      doc.period
    );
    
    if (!processEmissionSummary) {
      stats.skipped++;
      return { success: true, skipped: true, reason: 'No process data available' };
    }
    
    // Update document
    if (!CONFIG.dryRun) {
      await EmissionSummary.updateOne(
        { _id: doc._id },
        { 
          $set: { 
            processEmissionSummary: processEmissionSummary,
            'metadata.version': (doc.metadata?.version || 0) + 1,
            'metadata.lastCalculated': new Date()
          }
        }
      );
    }
    
    stats.updated++;
    
    return {
      success: true,
      action: 'updated',
      summary: {
        totalCO2e: processEmissionSummary.totalEmissions.CO2e,
        nodes: Object.keys(processEmissionSummary.byNode).length,
        dataPoints: processEmissionSummary.metadata.totalDataPoints
      }
    };
    
  } catch (error) {
    stats.errors++;
    stats.errorDetails.push({
      documentId: doc._id,
      clientId: doc.clientId,
      period: doc.period,
      error: error.message
    });
    console.error(`Error processing document ${doc._id}:`, error.message);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// MAIN MIGRATION FUNCTION
// ============================================================================

async function runMigration() {
  console.log('\n' + '='.repeat(80));
  console.log('PROCESS EMISSION SUMMARY MIGRATION');
  console.log('='.repeat(80));
  console.log(`Mode: ${CONFIG.rollback ? 'ROLLBACK' : 'MIGRATE'}`);
  console.log(`Dry Run: ${CONFIG.dryRun ? 'YES (no changes will be made)' : 'NO (changes will be applied)'}`);
  if (CONFIG.specificClient) console.log(`Client: ${CONFIG.specificClient}`);
  if (CONFIG.limit) console.log(`Limit: ${CONFIG.limit} documents`);
  console.log('='.repeat(80) + '\n');
  
  try {
    // Connect to MongoDB
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('✅ Connected to MongoDB\n');
    
    // Build query
    const query = {};
    if (CONFIG.specificClient) {
      query.clientId = CONFIG.specificClient;
    }
    
    // Get total count
    stats.totalDocuments = await EmissionSummary.countDocuments(query);
    console.log(`Found ${stats.totalDocuments} emission summary documents\n`);
    
    if (stats.totalDocuments === 0) {
      console.log('No documents to process. Exiting.\n');
      return;
    }
    
    // Confirm if not dry run
    if (!CONFIG.dryRun && !CONFIG.rollback) {
      console.log('⚠️  WARNING: This will modify the database!');
      console.log('   Run with --dry-run flag to preview changes first.\n');
      
      // Give user 5 seconds to cancel
      console.log('Starting in 5 seconds... Press Ctrl+C to cancel\n');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    stats.startTime = Date.now();
    
    // Process documents in batches
    let skip = 0;
    const limit = CONFIG.limit || stats.totalDocuments;
    const batchSize = CONFIG.batchSize;
    
    while (skip < limit) {
      const documentsToProcess = Math.min(batchSize, limit - skip);
      
      const documents = await EmissionSummary.find(query)
        .skip(skip)
        .limit(documentsToProcess)
        .lean();
      
      if (documents.length === 0) break;
      
      // Process batch
      const results = await Promise.all(
        documents.map(doc => migrateDocument(doc))
      );
      
      skip += documentsToProcess;
      
      // Optional: Add delay between batches to avoid overloading
      if (skip < limit) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    stats.endTime = Date.now();
    
    // Print results
    printResults();
    
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    throw error;
  } finally {
    await mongoose.connection.close();
    console.log('\n✅ Database connection closed\n');
  }
}

// ============================================================================
// PRINT RESULTS
// ============================================================================

function printResults() {
  const duration = ((stats.endTime - stats.startTime) / 1000).toFixed(2);
  
  console.log('\n' + '='.repeat(80));
  console.log('MIGRATION RESULTS');
  console.log('='.repeat(80));
  console.log(`Total Documents:        ${stats.totalDocuments}`);
  console.log(`Processed:              ${stats.processed}`);
  console.log(`Updated:                ${stats.updated}`);
  console.log(`Skipped:                ${stats.skipped}`);
  console.log(`Errors:                 ${stats.errors}`);
  console.log(`No ProcessFlowchart:    ${stats.noProcessFlowchart}`);
  console.log(`No Valid Nodes:         ${stats.noValidNodes}`);
  console.log(`No Data Entries:        ${stats.noDataEntries}`);
  console.log(`Duration:               ${duration} seconds`);
  console.log('='.repeat(80));
  
  if (CONFIG.dryRun) {
    console.log('\n⚠️  DRY RUN MODE - No changes were made to the database');
  } else if (CONFIG.rollback) {
    console.log('\n✅ ROLLBACK COMPLETE - processEmissionSummary field removed');
  } else {
    console.log('\n✅ MIGRATION COMPLETE - processEmissionSummary field added');
  }
  
  if (stats.errors > 0) {
    console.log('\n❌ ERRORS OCCURRED:');
    stats.errorDetails.slice(0, 10).forEach((err, idx) => {
      console.log(`\n${idx + 1}. Document: ${err.documentId}`);
      console.log(`   Client: ${err.clientId}`);
      console.log(`   Period: ${JSON.stringify(err.period)}`);
      console.log(`   Error: ${err.error}`);
    });
    if (stats.errorDetails.length > 10) {
      console.log(`\n... and ${stats.errorDetails.length - 10} more errors`);
    }
  }
  
  console.log('');
}

// ============================================================================
// RUN MIGRATION
// ============================================================================

// Catch unhandled errors
process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
  process.exit(1);
});

// Run migration
runMigration()
  .then(() => {
    console.log('Migration script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration script failed:', error);
    process.exit(1);
  });