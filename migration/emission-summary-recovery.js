/**
 * ============================================================================
 * EMERGENCY DATABASE RECOVERY SCRIPT
 * ============================================================================
 * 
 * PURPOSE: Restore accidentally deleted EmissionSummary database
 * 
 * This script will:
 * 1. Find all unique clients from DataEntry and NetReductionEntry
 * 2. Identify all periods that need recalculation
 * 3. Recalculate emission summaries for all periods
 * 4. Recalculate reduction summaries for all periods
 * 5. Create detailed recovery logs
 * 
 * PREREQUISITES:
 * - DataEntry collection must be intact
 * - NetReductionEntry collection must be intact
 * - ProcessFlowchart collection should be intact (for process emissions)
 * 
 * ============================================================================
 */

require('dotenv').config();
const mongoose = require('mongoose');
const EmissionSummary = require('../models/CalculationEmission/EmissionSummary');
const DataEntry = require('../models/Organization/DataEntry');
const NetReductionEntry = require('../models/Reduction/NetReductionEntry');
const Reduction = require('../models/Reduction/Reduction');
const ProcessFlowchart = require('../models/Organization/Flowchart');
const Client = require('../models/CMS/Client');

const { recalculateAndSaveSummary } = require('../controllers/Calculation/CalculationSummary');
const { recomputeClientNetReductionSummary } = require('../controllers/Reduction/netReductionSummaryController');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Batch processing settings
  BATCH_SIZE: 10,
  DELAY_BETWEEN_BATCHES: 2000, // ms
  
  // Period types to recover
  PERIOD_TYPES: ['daily', 'weekly', 'monthly', 'yearly', 'all-time'],
  
  // Safety limits
  MAX_CLIENTS_PER_RUN: null, // null = no limit
  
  // Dry run mode (set to false to actually write to database)
  DRY_RUN: false,
  
  // Detailed logging
  VERBOSE: true
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const prefix = {
    'INFO': '📊',
    'SUCCESS': '✅',
    'ERROR': '❌',
    'WARNING': '⚠️',
    'PROGRESS': '🔄'
  }[level] || 'ℹ️';
  
  console.log(`${timestamp} ${prefix} ${message}`);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract unique periods from DataEntry records
 */
function extractPeriodsFromDataEntries(dataEntries) {
  const periods = new Map();
  
  for (const entry of dataEntries) {
    const date = new Date(entry.timestamp);
    const year = date.getFullYear();
    const month = date.getMonth() + 1; // 1-12
    const day = date.getDate();
    const week = getWeekNumber(date);
    
    // Daily
    const dailyKey = `daily-${year}-${month}-${day}`;
    if (!periods.has(dailyKey)) {
      periods.set(dailyKey, { periodType: 'daily', year, month, day, week });
    }
    
    // Weekly
    const weeklyKey = `weekly-${year}-${week}`;
    if (!periods.has(weeklyKey)) {
      periods.set(weeklyKey, { periodType: 'weekly', year, week });
    }
    
    // Monthly
    const monthlyKey = `monthly-${year}-${month}`;
    if (!periods.has(monthlyKey)) {
      periods.set(monthlyKey, { periodType: 'monthly', year, month });
    }
    
    // Yearly
    const yearlyKey = `yearly-${year}`;
    if (!periods.has(yearlyKey)) {
      periods.set(yearlyKey, { periodType: 'yearly', year });
    }
  }
  
  // Add all-time
  periods.set('all-time', { periodType: 'all-time' });
  
  return Array.from(periods.values());
}

/**
 * Get ISO week number
 */
function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// ============================================================================
// MAIN RECOVERY FUNCTIONS
// ============================================================================

/**
 * Step 1: Discover all clients that need recovery
 */
async function discoverClientsNeedingRecovery() {
  log('Discovering clients from DataEntry and NetReductionEntry...', 'PROGRESS');
  
  // Get unique client IDs from DataEntry
  const emissionClientIds = await DataEntry.distinct('clientId');
  log(`Found ${emissionClientIds.length} clients with emission data`);
  
  // Get unique client IDs from NetReductionEntry
  const reductionClientIds = await NetReductionEntry.distinct('clientId');
  log(`Found ${reductionClientIds.length} clients with reduction data`);
  
  // Combine and deduplicate
  const allClientIds = [...new Set([...emissionClientIds, ...reductionClientIds])];
  log(`Total unique clients: ${allClientIds.length}`, 'SUCCESS');
  
  // Get client details
  const clients = await Client.find({ clientId: { $in: allClientIds } })
    .select('clientId name')
    .lean();
  
  const clientMap = new Map(clients.map(c => [c.clientId, c]));
  
  return allClientIds.map(clientId => ({
    clientId,
    name: clientMap.get(clientId)?.name || 'Unknown',
    hasEmissionData: emissionClientIds.includes(clientId),
    hasReductionData: reductionClientIds.includes(clientId)
  }));
}

/**
 * Step 2: Discover all periods for a client
 */
async function discoverPeriodsForClient(clientId) {
  log(`  Discovering periods for client: ${clientId}`, 'PROGRESS');
  
  // Get all data entries for this client
  const dataEntries = await DataEntry.find({ 
    clientId,
    emissionCalculationStatus: 'completed',
    calculatedEmissions: { $exists: true }
  })
    .select('timestamp')
    .lean();
  
  if (dataEntries.length === 0) {
    log(`  No completed emission calculations found for client: ${clientId}`, 'WARNING');
    return [];
  }
  
  const periods = extractPeriodsFromDataEntries(dataEntries);
  log(`  Found ${periods.length} unique periods`, 'SUCCESS');
  
  return periods;
}

/**
 * Step 3: Recalculate emission summary for a specific period
 */
async function recalculateEmissionSummaryForPeriod(clientId, period) {
  const { periodType, year, month, week, day } = period;
  
  try {
    if (CONFIG.DRY_RUN) {
      log(`  [DRY RUN] Would recalculate ${periodType} summary for ${year}/${month || ''}/${day || ''}`, 'INFO');
      return { success: true, dryRun: true };
    }
    
    log(`  Recalculating ${periodType} summary for ${year}/${month || ''}/${day || ''}...`, 'PROGRESS');
    
    // Call the existing recalculation function
    const summary = await recalculateAndSaveSummary(
      clientId,
      periodType,
      year,
      month,
      week,
      day
    );
    
    if (summary) {
      const totalCO2e = summary.emissionSummary?.totalEmissions?.CO2e || 0;
      log(`  ✅ ${periodType} summary saved - Total CO2e: ${totalCO2e.toFixed(2)} tonnes`, 'SUCCESS');
      return { success: true, summary, totalCO2e };
    } else {
      log(`  ⚠️ No data for ${periodType} ${year}/${month || ''}/${day || ''}`, 'WARNING');
      return { success: false, reason: 'no_data' };
    }
    
  } catch (error) {
    log(`  ❌ Error recalculating ${periodType} summary: ${error.message}`, 'ERROR');
    return { success: false, error: error.message };
  }
}

/**
 * Step 4: Recalculate reduction summaries for a client
 */
async function recalculateReductionSummariesForClient(clientId) {
  try {
    if (CONFIG.DRY_RUN) {
      log(`  [DRY RUN] Would recalculate reduction summaries for client: ${clientId}`, 'INFO');
      return { success: true, dryRun: true };
    }
    
    log(`  Recalculating reduction summaries...`, 'PROGRESS');
    
    // Call the existing reduction summary recalculation function
    await recomputeClientNetReductionSummary(clientId);
    
    log(`  ✅ Reduction summaries recalculated`, 'SUCCESS');
    return { success: true };
    
  } catch (error) {
    log(`  ❌ Error recalculating reduction summaries: ${error.message}`, 'ERROR');
    return { success: false, error: error.message };
  }
}

/**
 * Step 5: Process a single client (all periods)
 */
async function processClient(clientInfo, index, total) {
  const { clientId, name, hasEmissionData, hasReductionData } = clientInfo;
  
  log(`\n${'='.repeat(80)}`, 'INFO');
  log(`Processing Client ${index + 1}/${total}: ${name} (${clientId})`, 'INFO');
  log(`${'='.repeat(80)}`, 'INFO');
  
  const results = {
    clientId,
    name,
    emissionSummaries: {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      noData: 0,
      totalCO2e: 0
    },
    reductionSummaries: {
      attempted: 0,
      succeeded: 0,
      failed: 0
    },
    errors: []
  };
  
  // Process emission summaries
  if (hasEmissionData) {
    const periods = await discoverPeriodsForClient(clientId);
    results.emissionSummaries.attempted = periods.length;
    
    for (const period of periods) {
      const result = await recalculateEmissionSummaryForPeriod(clientId, period);
      
      if (result.success) {
        results.emissionSummaries.succeeded++;
        if (result.totalCO2e) {
          results.emissionSummaries.totalCO2e += result.totalCO2e;
        }
      } else if (result.reason === 'no_data') {
        results.emissionSummaries.noData++;
      } else {
        results.emissionSummaries.failed++;
        results.errors.push({
          type: 'emission',
          period,
          error: result.error
        });
      }
      
      // Small delay to prevent overwhelming the database
      await delay(100);
    }
  }
  
  // Process reduction summaries
  if (hasReductionData) {
    results.reductionSummaries.attempted = 1;
    const result = await recalculateReductionSummariesForClient(clientId);
    
    if (result.success) {
      results.reductionSummaries.succeeded++;
    } else {
      results.reductionSummaries.failed++;
      results.errors.push({
        type: 'reduction',
        error: result.error
      });
    }
  }
  
  return results;
}

/**
 * Step 6: Generate recovery report
 */
function generateRecoveryReport(allResults, startTime) {
  const endTime = Date.now();
  const duration = (endTime - startTime) / 1000; // seconds
  
  log('\n\n' + '='.repeat(80), 'INFO');
  log('RECOVERY REPORT', 'INFO');
  log('='.repeat(80), 'INFO');
  
  const totals = {
    clients: allResults.length,
    emissionSummaries: {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      noData: 0,
      totalCO2e: 0
    },
    reductionSummaries: {
      attempted: 0,
      succeeded: 0,
      failed: 0
    },
    totalErrors: 0
  };
  
  for (const result of allResults) {
    totals.emissionSummaries.attempted += result.emissionSummaries.attempted;
    totals.emissionSummaries.succeeded += result.emissionSummaries.succeeded;
    totals.emissionSummaries.failed += result.emissionSummaries.failed;
    totals.emissionSummaries.noData += result.emissionSummaries.noData;
    totals.emissionSummaries.totalCO2e += result.emissionSummaries.totalCO2e;
    
    totals.reductionSummaries.attempted += result.reductionSummaries.attempted;
    totals.reductionSummaries.succeeded += result.reductionSummaries.succeeded;
    totals.reductionSummaries.failed += result.reductionSummaries.failed;
    
    totals.totalErrors += result.errors.length;
  }
  
  log(`\nClients Processed: ${totals.clients}`, 'INFO');
  log(`Duration: ${duration.toFixed(2)} seconds`, 'INFO');
  
  log('\nEMISSION SUMMARIES:', 'INFO');
  log(`  Attempted: ${totals.emissionSummaries.attempted}`, 'INFO');
  log(`  Succeeded: ${totals.emissionSummaries.succeeded}`, 'SUCCESS');
  log(`  No Data: ${totals.emissionSummaries.noData}`, 'WARNING');
  log(`  Failed: ${totals.emissionSummaries.failed}`, 'ERROR');
  log(`  Total CO2e Calculated: ${totals.emissionSummaries.totalCO2e.toFixed(2)} tonnes`, 'INFO');
  
  log('\nREDUCTION SUMMARIES:', 'INFO');
  log(`  Attempted: ${totals.reductionSummaries.attempted}`, 'INFO');
  log(`  Succeeded: ${totals.reductionSummaries.succeeded}`, 'SUCCESS');
  log(`  Failed: ${totals.reductionSummaries.failed}`, 'ERROR');
  
  log(`\nTotal Errors: ${totals.totalErrors}`, totals.totalErrors > 0 ? 'ERROR' : 'SUCCESS');
  
  if (CONFIG.DRY_RUN) {
    log('\n⚠️  DRY RUN MODE - No changes were made to the database', 'WARNING');
  }
  
  log('\n' + '='.repeat(80), 'INFO');
  
  // Save detailed report to file
  const reportPath = `./recovery-report-${Date.now()}.json`;
  const fs = require('fs');
  fs.writeFileSync(reportPath, JSON.stringify({
    summary: totals,
    duration,
    dryRun: CONFIG.DRY_RUN,
    timestamp: new Date().toISOString(),
    clientResults: allResults
  }, null, 2));
  
  log(`\nDetailed report saved to: ${reportPath}`, 'SUCCESS');
  
  return totals;
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  const startTime = Date.now();
  
  log('\n' + '='.repeat(80), 'INFO');
  log('EMISSION SUMMARY DATABASE RECOVERY', 'INFO');
  log('='.repeat(80), 'INFO');
  log(`Dry Run Mode: ${CONFIG.DRY_RUN}`, CONFIG.DRY_RUN ? 'WARNING' : 'INFO');
  log(`Batch Size: ${CONFIG.BATCH_SIZE}`, 'INFO');
  log(`Period Types: ${CONFIG.PERIOD_TYPES.join(', ')}`, 'INFO');
  log('='.repeat(80) + '\n', 'INFO');
  
  try {
    // Connect to MongoDB
    log('Connecting to MongoDB...', 'PROGRESS');
    await mongoose.connect("mongodb+srv://zerocarbon:zerocarbon@zerocarbon.ujopg7s.mongodb.net/zeroCarbon");
    log('Connected to MongoDB', 'SUCCESS');
    
    // Step 1: Discover all clients
    const clients = await discoverClientsNeedingRecovery();
    
    // Apply safety limit if configured
    const clientsToProcess = CONFIG.MAX_CLIENTS_PER_RUN 
      ? clients.slice(0, CONFIG.MAX_CLIENTS_PER_RUN)
      : clients;
    
    if (CONFIG.MAX_CLIENTS_PER_RUN && clients.length > CONFIG.MAX_CLIENTS_PER_RUN) {
      log(`\n⚠️  Processing limited to first ${CONFIG.MAX_CLIENTS_PER_RUN} clients`, 'WARNING');
    }
    
    log(`\nProcessing ${clientsToProcess.length} clients...`, 'INFO');
    
    // Step 2: Process each client
    const allResults = [];
    
    for (let i = 0; i < clientsToProcess.length; i++) {
      const clientInfo = clientsToProcess[i];
      const result = await processClient(clientInfo, i, clientsToProcess.length);
      allResults.push(result);
      
      // Delay between clients
      if (i < clientsToProcess.length - 1) {
        await delay(CONFIG.DELAY_BETWEEN_BATCHES);
      }
    }
    
    // Step 3: Generate report
    const totals = generateRecoveryReport(allResults, startTime);
    
    // Exit status
    const exitCode = totals.totalErrors > 0 ? 1 : 0;
    
    await mongoose.connection.close();
    log('\nDatabase connection closed', 'INFO');
    
    process.exit(exitCode);
    
  } catch (error) {
    log(`Fatal error: ${error.message}`, 'ERROR');
    console.error(error);
    await mongoose.connection.close();
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  log('\n\nReceived SIGINT, shutting down gracefully...', 'WARNING');
  await mongoose.connection.close();
  process.exit(0);
});

// Run the script
if (require.main === module) {
  main();
}

module.exports = {
  discoverClientsNeedingRecovery,
  discoverPeriodsForClient,
  recalculateEmissionSummaryForPeriod,
  recalculateReductionSummariesForClient
};