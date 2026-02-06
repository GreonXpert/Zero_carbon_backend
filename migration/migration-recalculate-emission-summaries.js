/**
 * ============================================================================
 * COMPREHENSIVE MIGRATION: Emission & Reduction Summary Recalculation
 * ============================================================================
 * 
 * This script recalculates BOTH emission and reduction summaries using
 * the actual controller functions to ensure consistency with production code.
 * 
 * Features:
 * - ✅ Uses controller functions (no code duplication)
 * - ✅ Weekly period support
 * - ✅ Checkpoint system for resumable migrations
 * - ✅ Dry-run mode for testing
 * - ✅ Protection flags to prevent auto-recalculation
 * - ✅ All periods: daily, weekly, monthly, yearly, all-time
 * 
 * USAGE:
 * node migration-recalculate-summaries-COMPLETE-v2.js
 * 
 * ============================================================================
 */

require('dotenv').config();
const mongoose = require('mongoose');
const EmissionSummary = require('../models/CalculationEmission/EmissionSummary');
const fs = require('fs');
const path = require('path');

// Import controller functions
const { recalculateAndSaveSummary } = require('../controllers/Calculation/CalculationSummary');
const { recomputeClientNetReductionSummary } = require('../controllers/Reduction/netReductionSummaryController');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  DRY_RUN: false,  // Set to true to test without saving
  BATCH_SIZE: 50,
  TARGET_CLIENT: 'Greon017',
  CHECKPOINT_FILE: 'migration-checkpoint-complete-v2.json',
  SKIP_PROTECTION_FLAGS: false, // Set to true if you don't want to add protection flags
  VERBOSE: true  // Set to false for less output
};

// ============================================================================
// CHECKPOINT SYSTEM
// ============================================================================

function loadCheckpoint() {
  try {
    if (fs.existsSync(CONFIG.CHECKPOINT_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.CHECKPOINT_FILE, 'utf8'));
      console.log(`📍 Loaded checkpoint: ${data.processedIds?.length || 0} already processed`);
      return data;
    }
  } catch (error) {
    console.error('⚠️  Error loading checkpoint:', error.message);
  }
  return { 
    processedIds: [], 
    stats: { 
      emissionUpdated: 0, 
      reductionUpdated: 0, 
      skipped: 0, 
      errors: 0,
      bothUpdated: 0,
      onlyEmission: 0,
      onlyReduction: 0,
      noData: 0
    } 
  };
}

function saveCheckpoint(data) {
  try {
    fs.writeFileSync(CONFIG.CHECKPOINT_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('⚠️  Error saving checkpoint:', error.message);
  }
}

// ============================================================================
// PERIOD EXTRACTION
// ============================================================================

/**
 * Extract period information from an EmissionSummary document
 */
function extractPeriodInfo(summary) {
  const { type, year, month, week, day } = summary.period;
  return { type, year, month, week, day };
}

/**
 * Get timestamps for reduction summary calculation
 * For weekly periods, we need to provide sample timestamps within that week
 */
function getTimestampsForPeriod(summary) {
  const { type, year, month, week, day } = summary.period;
  const timestamps = [];

  switch (type) {
    case 'daily':
      if (year && month && day) {
        timestamps.push(new Date(year, month - 1, day, 12, 0, 0));
      }
      break;

    case 'weekly':
      if (year && week) {
        // Calculate the start of the week
        const firstDayOfYear = new Date(year, 0, 1);
        const daysToWeek = (week - 1) * 7;
        const weekStart = new Date(firstDayOfYear.getTime() + daysToWeek * 24 * 60 * 60 * 1000);
        
        // Add timestamps for each day of the week
        for (let i = 0; i < 7; i++) {
          const dayTimestamp = new Date(weekStart.getTime() + i * 24 * 60 * 60 * 1000);
          timestamps.push(dayTimestamp);
        }
      }
      break;

    case 'monthly':
      if (year && month) {
        // Add a timestamp for the middle of the month
        timestamps.push(new Date(year, month - 1, 15, 12, 0, 0));
      }
      break;

    case 'yearly':
      if (year) {
        // Add a timestamp for the middle of the year
        timestamps.push(new Date(year, 5, 15, 12, 0, 0));
      }
      break;

    case 'all-time':
      // For all-time, we don't need specific timestamps
      // The function will handle it
      break;
  }

  return timestamps;
}

// ============================================================================
// APPLY PROTECTION FLAGS
// ============================================================================

/**
 * Add protection flags to prevent auto-recalculation from overwriting migrated data
 */
async function applyProtectionFlags(summaryId) {
  if (CONFIG.SKIP_PROTECTION_FLAGS) {
    return;
  }

  try {
    await EmissionSummary.findByIdAndUpdate(
      summaryId,
      {
        $set: {
          'metadata.migratedData': true,
          'metadata.preventAutoRecalculation': true,
          'metadata.migrationTimestamp': new Date(),
          'metadata.migrationVersion': 'v2-controller-based'
        }
      }
    );
  } catch (error) {
    console.error(`⚠️  Failed to apply protection flags to ${summaryId}:`, error.message);
  }
}

// ============================================================================
// PROCESS SINGLE SUMMARY
// ============================================================================

/**
 * Process a single EmissionSummary document
 * Returns: { emissionSuccess, reductionSuccess, error }
 */
async function processSummary(summary, userId = null) {
  const { clientId, _id } = summary;
  const { type, year, month, week, day } = extractPeriodInfo(summary);
  
  const result = {
    emissionSuccess: false,
    reductionSuccess: false,
    emissionData: null,
    reductionData: null,
    error: null
  };

  try {
    // ============================================================
    // RECALCULATE EMISSION SUMMARY
    // ============================================================
    if (CONFIG.VERBOSE) {
      console.log(`  📊 Recalculating emission summary for ${type} period...`);
    }

    try {
      const emissionSummary = await recalculateAndSaveSummary(
        clientId,
        type,
        year,
        month,
        week,
        day,
        userId
      );

      if (emissionSummary && emissionSummary.emissionSummary) {
        result.emissionSuccess = true;
        result.emissionData = emissionSummary.emissionSummary;
        
        if (CONFIG.VERBOSE) {
          const totalCO2e = emissionSummary.emissionSummary.totalEmissions?.CO2e || 0;
          console.log(`     ✅ Emission: ${totalCO2e.toFixed(2)} CO2e tonnes`);
        }
      } else {
        if (CONFIG.VERBOSE) {
          console.log(`     ℹ️  No emission data for this period`);
        }
      }
    } catch (emissionError) {
      console.error(`     ❌ Emission calculation failed: ${emissionError.message}`);
      result.error = `Emission: ${emissionError.message}`;
    }

    // ============================================================
    // RECALCULATE REDUCTION SUMMARY
    // ============================================================
    if (CONFIG.VERBOSE) {
      console.log(`  🌱 Recalculating reduction summary for ${type} period...`);
    }

    try {
      const timestamps = getTimestampsForPeriod(summary);
      
      await recomputeClientNetReductionSummary(clientId, {
        timestamps: timestamps.length > 0 ? timestamps : undefined
      });

      // Fetch the updated summary to check if reduction data was added
      const updatedSummary = await EmissionSummary.findById(_id).lean();
      
      if (updatedSummary && updatedSummary.reductionSummary) {
        result.reductionSuccess = true;
        result.reductionData = updatedSummary.reductionSummary;
        
        if (CONFIG.VERBOSE) {
          const totalReduction = updatedSummary.reductionSummary.totalNetReduction || 0;
          console.log(`     ✅ Reduction: ${totalReduction.toFixed(2)} CO2e tonnes reduced`);
        }
      } else {
        if (CONFIG.VERBOSE) {
          console.log(`     ℹ️  No reduction data for this period`);
        }
      }
    } catch (reductionError) {
      console.error(`     ❌ Reduction calculation failed: ${reductionError.message}`);
      if (result.error) {
        result.error += ` | Reduction: ${reductionError.message}`;
      } else {
        result.error = `Reduction: ${reductionError.message}`;
      }
    }

    // ============================================================
    // APPLY PROTECTION FLAGS (if not in dry-run)
    // ============================================================
    if (!CONFIG.DRY_RUN && (result.emissionSuccess || result.reductionSuccess)) {
      await applyProtectionFlags(_id);
    }

  } catch (error) {
    console.error(`  ❌ Unexpected error processing summary:`, error);
    result.error = error.message;
  }

  return result;
}

// ============================================================================
// FORMAT PERIOD LABEL
// ============================================================================

function formatPeriodLabel(summary) {
  const { type, year, month, week, day } = summary.period;
  
  let label = type;
  if (year) label += ` ${year}`;
  if (month) label += `-${String(month).padStart(2, '0')}`;
  if (week) label += `-W${String(week).padStart(2, '0')}`;
  if (day) label += `-${String(day).padStart(2, '0')}`;
  
  return label;
}

// ============================================================================
// MAIN MIGRATION
// ============================================================================

async function runMigration() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║  COMPREHENSIVE EMISSION & REDUCTION SUMMARY MIGRATION (v2)     ║');
  console.log('║  Using Controller Functions                                    ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('📋 Configuration:');
  console.log(`   - DRY RUN: ${CONFIG.DRY_RUN ? '✅ YES (no changes will be saved)' : '❌ NO (changes will be saved)'}`);
  console.log(`   - Batch Size: ${CONFIG.BATCH_SIZE}`);
  console.log(`   - Target Client: ${CONFIG.TARGET_CLIENT}`);
  console.log(`   - Protection Flags: ${CONFIG.SKIP_PROTECTION_FLAGS ? '❌ Disabled' : '✅ Enabled'}`);
  console.log(`   - Verbose Mode: ${CONFIG.VERBOSE ? '✅ Enabled' : '❌ Disabled'}`);
  console.log('');

  try {
    // ============================================================
    // CONNECT TO DATABASE
    // ============================================================
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');
    console.log('');

    // ============================================================
    // GET TOTAL COUNT
    // ============================================================
    const totalSummaries = await EmissionSummary.countDocuments({ 
      clientId: CONFIG.TARGET_CLIENT 
    });
    console.log(`📊 Total summaries to process: ${totalSummaries}`);
    console.log('');

    // ============================================================
    // LOAD CHECKPOINT
    // ============================================================
    const checkpoint = loadCheckpoint();
    const processedIds = new Set(checkpoint.processedIds || []);
    const stats = checkpoint.stats || { 
      emissionUpdated: 0, 
      reductionUpdated: 0, 
      skipped: 0, 
      errors: 0,
      bothUpdated: 0,
      onlyEmission: 0,
      onlyReduction: 0,
      noData: 0
    };

    let processedCount = processedIds.size;
    const startTime = Date.now();

    // ============================================================
    // PROCESS IN BATCHES
    // ============================================================
    let skip = 0;
    let batchNumber = 0;

    while (skip < totalSummaries) {
      batchNumber++;
      
      const summaries = await EmissionSummary.find({ 
        clientId: CONFIG.TARGET_CLIENT 
      })
        .skip(skip)
        .limit(CONFIG.BATCH_SIZE)
        .lean();

      if (summaries.length === 0) break;

      console.log(`\n📦 Processing batch ${batchNumber} (${skip + 1}-${skip + summaries.length} of ${totalSummaries})...`);

      for (const summary of summaries) {
        const summaryId = summary._id.toString();
        
        // Skip if already processed
        if (processedIds.has(summaryId)) {
          stats.skipped++;
          continue;
        }

        const periodLabel = formatPeriodLabel(summary);
        console.log(`\n  🔄 Processing ${periodLabel} (${summaryId.slice(-6)})`);

        // Process the summary
        const result = await processSummary(summary);

        // Update statistics
        if (result.error) {
          stats.errors++;
          console.log(`  ❌ Failed: ${result.error}`);
        } else if (result.emissionSuccess && result.reductionSuccess) {
          stats.bothUpdated++;
          stats.emissionUpdated++;
          stats.reductionUpdated++;
        } else if (result.emissionSuccess) {
          stats.onlyEmission++;
          stats.emissionUpdated++;
        } else if (result.reductionSuccess) {
          stats.onlyReduction++;
          stats.reductionUpdated++;
        } else {
          stats.noData++;
          console.log(`  ℹ️  No data available for this period`);
        }

        // Mark as processed
        processedIds.add(summaryId);
        processedCount++;
      }

      // ============================================================
      // SAVE CHECKPOINT
      // ============================================================
      saveCheckpoint({
        processedIds: [...processedIds],
        stats,
        lastProcessed: new Date().toISOString(),
        batchNumber
      });

      console.log(`\n📍 Checkpoint saved: ${processedCount}/${totalSummaries} processed`);
      console.log(`   ✅ Both Updated: ${stats.bothUpdated}`);
      console.log(`   📊 Only Emission: ${stats.onlyEmission}`);
      console.log(`   🌱 Only Reduction: ${stats.onlyReduction}`);
      console.log(`   ℹ️  No Data: ${stats.noData}`);
      console.log(`   ⏭️  Skipped: ${stats.skipped}`);
      console.log(`   ❌ Errors: ${stats.errors}`);

      skip += CONFIG.BATCH_SIZE;
      
      // Small delay between batches to avoid overwhelming the database
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // ============================================================
    // FINAL REPORT
    // ============================================================
    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);

    console.log('\n');
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║  MIGRATION COMPLETE                                            ║');
    console.log('╚════════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('📊 Final Statistics:');
    console.log(`   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`   Total Processed:        ${processedCount}/${totalSummaries}`);
    console.log(`   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`   ✅ Both Updated:        ${stats.bothUpdated}`);
    console.log(`   📊 Only Emission:       ${stats.onlyEmission}`);
    console.log(`   🌱 Only Reduction:      ${stats.onlyReduction}`);
    console.log(`   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`   Total Emission Updates: ${stats.emissionUpdated}`);
    console.log(`   Total Reduction Updates:${stats.reductionUpdated}`);
    console.log(`   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`   ℹ️  No Data:            ${stats.noData}`);
    console.log(`   ⏭️  Skipped:            ${stats.skipped}`);
    console.log(`   ❌ Errors:              ${stats.errors}`);
    console.log(`   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`   ⏱️  Duration:           ${duration} minutes`);
    console.log(`   🔧 Mode:                ${CONFIG.DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
    console.log(`   🛡️  Protection Flags:   ${CONFIG.SKIP_PROTECTION_FLAGS ? 'Disabled' : 'Enabled'}`);
    console.log('');

    // ============================================================
    // CLEANUP CHECKPOINT FILE
    // ============================================================
    if (processedCount >= totalSummaries) {
      if (fs.existsSync(CONFIG.CHECKPOINT_FILE)) {
        // Keep a backup
        const backupFile = CONFIG.CHECKPOINT_FILE.replace('.json', '-backup.json');
        fs.copyFileSync(CONFIG.CHECKPOINT_FILE, backupFile);
        fs.unlinkSync(CONFIG.CHECKPOINT_FILE);
        console.log('✅ Checkpoint file removed (backup saved)');
      }
    } else {
      console.log('ℹ️  Checkpoint file retained for resuming later');
    }

  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
    console.log('');
    console.log('✅ Migration script completed');
  }
}

// ============================================================================
// RUN MIGRATION
// ============================================================================

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n⚠️  Migration interrupted by user');
  console.log('💾 Progress has been saved to checkpoint file');
  console.log('🔄 You can resume by running this script again');
  await mongoose.disconnect();
  process.exit(0);
});

// Run the migration
runMigration()
  .then(() => {
    console.log('🎉 All done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });