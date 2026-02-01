// ============================================================================
// RECALCULATION SCRIPT: Update Process Emission Summaries
// ============================================================================
// 
// This script recalculates processEmissionSummary for existing documents.
// Use this after running simpleMigration.js to populate the empty structures.
//
// USAGE:
//   node migration/recalculateProcessSummaries.js
//
// OPTIONS:
//   --client=ID  : Recalculate specific client only
//   --period=TYPE: Recalculate specific period type (daily/monthly/yearly/all-time)
//   --year=YYYY  : Recalculate specific year
//   --limit=N    : Limit number of documents
//
// EXAMPLES:
//   node migration/recalculateProcessSummaries.js --client=Greon017
//   node migration/recalculateProcessSummaries.js --period=monthly --year=2026
//
// ============================================================================

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Import required modules
const EmissionSummary = require('../models/CalculationEmission/EmissionSummary');
const { calculateProcessEmissionSummaryPrecise } = require('../controllers/Calculation/CalculationSummary');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  client: process.argv.find(arg => arg.startsWith('--client='))?.split('=')[1],
  periodType: process.argv.find(arg => arg.startsWith('--period='))?.split('=')[1],
  year: parseInt(process.argv.find(arg => arg.startsWith('--year='))?.split('=')[1] || '0'),
  limit: parseInt(process.argv.find(arg => arg.startsWith('--limit='))?.split('=')[1] || '0'),
  batchSize: 50
};

// ============================================================================
// STATISTICS
// ============================================================================

const stats = {
  totalDocuments: 0,
  processed: 0,
  updated: 0,
  failed: 0,
  skipped: 0,
  startTime: null,
  endTime: null,
  errors: []
};

// ============================================================================
// RECALCULATE SINGLE DOCUMENT
// ============================================================================

async function recalculateDocument(doc) {
  try {
    console.log(`Recalculating ${doc.clientId} - ${doc.period.type} ${doc.period.year}/${doc.period.month || ''}...`);
    
    // Calculate process emission summary
    const processEmissionSummary = await calculateProcessEmissionSummaryPrecise(
      doc.clientId,
      doc.period.type,
      doc.period.year,
      doc.period.month,
      doc.period.week,
      doc.period.day,
      null // userId
    );
    
    if (!processEmissionSummary) {
      console.log(`  ⚠️  No process data available`);
      stats.skipped++;
      return { success: true, skipped: true };
    }
    
    // Update document
    await EmissionSummary.updateOne(
      { _id: doc._id },
      {
        $set: {
          processEmissionSummary: processEmissionSummary,
          'metadata.lastCalculated': new Date(),
          'metadata.version': (doc.metadata?.version || 0) + 1
        }
      }
    );
    
    console.log(`  ✅ Updated (${processEmissionSummary.totalEmissions.CO2e.toFixed(2)} tCO2e, ${processEmissionSummary.metadata.totalDataPoints} points)`);
    
    stats.updated++;
    return { success: true };
    
  } catch (error) {
    console.error(`  ❌ Error:`, error.message);
    stats.failed++;
    stats.errors.push({
      documentId: doc._id,
      clientId: doc.clientId,
      error: error.message
    });
    return { success: false, error: error.message };
  }
}

// ============================================================================
// MAIN RECALCULATION FUNCTION
// ============================================================================

async function runRecalculation() {
  console.log('\n' + '='.repeat(80));
  console.log('PROCESS EMISSION SUMMARY RECALCULATION');
  console.log('='.repeat(80));
  if (CONFIG.client) console.log(`Client: ${CONFIG.client}`);
  if (CONFIG.periodType) console.log(`Period Type: ${CONFIG.periodType}`);
  if (CONFIG.year) console.log(`Year: ${CONFIG.year}`);
  if (CONFIG.limit) console.log(`Limit: ${CONFIG.limit}`);
  console.log('='.repeat(80) + '\n');
  
  try {
    // Connect to MongoDB
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('✅ Connected\n');
    
    // Build query
    const query = {};
    if (CONFIG.client) query.clientId = CONFIG.client;
    if (CONFIG.periodType) query['period.type'] = CONFIG.periodType;
    if (CONFIG.year) query['period.year'] = CONFIG.year;
    
    // Get total count
    stats.totalDocuments = await EmissionSummary.countDocuments(query);
    const limit = CONFIG.limit || stats.totalDocuments;
    
    console.log(`Found ${stats.totalDocuments} documents to recalculate`);
    console.log(`Will process ${limit} documents\n`);
    
    if (stats.totalDocuments === 0) {
      console.log('No documents to process. Exiting.\n');
      return;
    }
    
    stats.startTime = Date.now();
    
    // Process in batches
    let skip = 0;
    
    while (skip < limit) {
      const batchSize = Math.min(CONFIG.batchSize, limit - skip);
      
      const documents = await EmissionSummary.find(query)
        .skip(skip)
        .limit(batchSize)
        .lean();
      
      if (documents.length === 0) break;
      
      console.log(`\nBatch ${Math.floor(skip / CONFIG.batchSize) + 1}: Processing ${documents.length} documents...`);
      
      // Process each document
      for (const doc of documents) {
        stats.processed++;
        await recalculateDocument(doc);
      }
      
      skip += batchSize;
      
      // Progress update
      const progress = ((stats.processed / limit) * 100).toFixed(1);
      console.log(`Progress: ${stats.processed}/${limit} (${progress}%)\n`);
      
      // Small delay to avoid overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    stats.endTime = Date.now();
    
    // Print results
    printResults();
    
  } catch (error) {
    console.error('\n❌ Recalculation failed:', error);
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
  console.log('RECALCULATION RESULTS');
  console.log('='.repeat(80));
  console.log(`Total Documents:   ${stats.totalDocuments}`);
  console.log(`Processed:         ${stats.processed}`);
  console.log(`Updated:           ${stats.updated}`);
  console.log(`Skipped:           ${stats.skipped}`);
  console.log(`Failed:            ${stats.failed}`);
  console.log(`Duration:          ${duration} seconds`);
  console.log('='.repeat(80));
  
  if (stats.updated === stats.processed - stats.skipped) {
    console.log('\n✅ RECALCULATION COMPLETE - All documents updated successfully\n');
  } else {
    console.log(`\n⚠️  PARTIAL SUCCESS - ${stats.failed} documents failed\n`);
  }
  
  if (stats.errors.length > 0) {
    console.log('Errors:');
    stats.errors.slice(0, 10).forEach((err, idx) => {
      console.log(`${idx + 1}. Document: ${err.documentId}`);
      console.log(`   Client: ${err.clientId}`);
      console.log(`   Error: ${err.error}\n`);
    });
    if (stats.errors.length > 10) {
      console.log(`... and ${stats.errors.length - 10} more errors\n`);
    }
  }
}

// ============================================================================
// RUN
// ============================================================================

runRecalculation()
  .then(() => {
    console.log('Recalculation script completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Recalculation script failed:', error);
    process.exit(1);
  });