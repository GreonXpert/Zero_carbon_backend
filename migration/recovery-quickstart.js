/**
 * ============================================================================
 * QUICK START - EMISSION SUMMARY RECOVERY
 * ============================================================================
 * 
 * This script provides a simplified recovery process with progress tracking
 * and verification.
 * 
 * ============================================================================
 */

require('dotenv').config();
const mongoose = require('mongoose');
const EmissionSummary = require('../models/CalculationEmission/EmissionSummary');
const DataEntry = require('../models/Organization/DataEntry');
const NetReductionEntry = require('../models/Reduction/NetReductionEntry');

// ============================================================================
// STEP 1: PRE-RECOVERY DIAGNOSTICS
// ============================================================================

async function runDiagnostics() {
  console.log('\n📊 RUNNING PRE-RECOVERY DIAGNOSTICS...\n');
  
  try {
    await mongoose.connect("mongodb+srv://zerocarbon:zerocarbon@zerocarbon.ujopg7s.mongodb.net/zeroCarbon");
    
    // Check DataEntry collection
    const dataEntryCount = await DataEntry.countDocuments();
    const completedEmissions = await DataEntry.countDocuments({
      emissionCalculationStatus: 'completed',
      calculatedEmissions: { $exists: true }
    });
    
    console.log(`✅ DataEntry Collection:`);
    console.log(`   Total entries: ${dataEntryCount}`);
    console.log(`   Completed calculations: ${completedEmissions}`);
    
    // Check NetReductionEntry collection
    const reductionCount = await NetReductionEntry.countDocuments();
    console.log(`\n✅ NetReductionEntry Collection:`);
    console.log(`   Total entries: ${reductionCount}`);
    
    // Check EmissionSummary collection
    const summaryCount = await EmissionSummary.countDocuments();
    console.log(`\n📊 EmissionSummary Collection:`);
    console.log(`   Current documents: ${summaryCount}`);
    
    // Get unique clients
    const clientsWithData = await DataEntry.distinct('clientId');
    console.log(`\n🏢 Clients with data: ${clientsWithData.length}`);
    
    // Sample a few clients
    if (clientsWithData.length > 0) {
      console.log(`\n📋 Sample Clients:`);
      for (let i = 0; i < Math.min(5, clientsWithData.length); i++) {
        const clientId = clientsWithData[i];
        const count = await DataEntry.countDocuments({ 
          clientId,
          emissionCalculationStatus: 'completed'
        });
        console.log(`   - ${clientId}: ${count} completed emissions`);
      }
    }
    
    await mongoose.connection.close();
    
    console.log('\n' + '='.repeat(80));
    console.log('✅ DIAGNOSTICS COMPLETE');
    console.log('='.repeat(80));
    
    if (summaryCount === 0) {
      console.log('\n⚠️  WARNING: EmissionSummary collection is empty!');
      console.log('   This confirms the database was deleted.');
    }
    
    if (completedEmissions > 0) {
      console.log(`\n✅ RECOVERY IS POSSIBLE`);
      console.log(`   You have ${completedEmissions} completed emission calculations`);
      console.log(`   that can be used to rebuild summaries.`);
    } else {
      console.log(`\n❌ RECOVERY NOT POSSIBLE`);
      console.log(`   No completed emission calculations found.`);
    }
    
  } catch (error) {
    console.error('❌ Error running diagnostics:', error);
    await mongoose.connection.close();
  }
}

// ============================================================================
// STEP 2: TEST RECOVERY ON SINGLE CLIENT
// ============================================================================

async function testRecoverySingleClient(testClientId = null) {
  console.log('\n🧪 TESTING RECOVERY ON SINGLE CLIENT...\n');
  
  try {
    await mongoose.connect("mongodb+srv://zerocarbon:zerocarbon@zerocarbon.ujopg7s.mongodb.net/zeroCarbon");
    
    // Find a client with data if none specified
    if (!testClientId) {
      const clients = await DataEntry.distinct('clientId');
      if (clients.length === 0) {
        console.log('❌ No clients found with data');
        await mongoose.connection.close();
        return;
      }
      testClientId = clients[0];
    }
    
    console.log(`Testing with client: ${testClientId}`);
    
    // Count existing summaries
    const existingCount = await EmissionSummary.countDocuments({ clientId: testClientId });
    console.log(`Existing summaries: ${existingCount}`);
    
    // Import recovery function
    const { recalculateAndSaveSummary } = require('../controllers/Calculation/CalculationSummary');
    
    // Try to recover monthly summary for current year/month
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    
    console.log(`\nAttempting to recover monthly summary for ${year}-${month}...`);
    
    const summary = await recalculateAndSaveSummary(
      testClientId,
      'monthly',
      year,
      month
    );
    
    if (summary) {
      const totalCO2e = summary.emissionSummary?.totalEmissions?.CO2e || 0;
      console.log(`\n✅ SUCCESS! Summary created:`);
      console.log(`   Period: ${summary.period.type} ${summary.period.year}/${summary.period.month}`);
      console.log(`   Total CO2e: ${totalCO2e.toFixed(2)} tonnes`);
      console.log(`   Scope 1: ${summary.emissionSummary.byScope['Scope 1']?.CO2e.toFixed(2) || 0} tonnes`);
      console.log(`   Scope 2: ${summary.emissionSummary.byScope['Scope 2']?.CO2e.toFixed(2) || 0} tonnes`);
      console.log(`   Scope 3: ${summary.emissionSummary.byScope['Scope 3']?.CO2e.toFixed(2) || 0} tonnes`);
      console.log(`   Data points: ${summary.emissionSummary.metadata.totalDataPoints}`);
      
      console.log(`\n✅ TEST SUCCESSFUL - Full recovery should work!`);
    } else {
      console.log(`\n⚠️  No data found for this period`);
    }
    
    await mongoose.connection.close();
    
  } catch (error) {
    console.error('❌ Error during test recovery:', error);
    await mongoose.connection.close();
  }
}

// ============================================================================
// STEP 3: VERIFY RECOVERY RESULTS
// ============================================================================

async function verifyRecovery() {
  console.log('\n🔍 VERIFYING RECOVERY RESULTS...\n');
  
  try {
    await mongoose.connect("mongodb+srv://zerocarbon:zerocarbon@zerocarbon.ujopg7s.mongodb.net/zeroCarbon");
    
    // Count total summaries
    const totalSummaries = await EmissionSummary.countDocuments();
    console.log(`📊 Total Emission Summaries: ${totalSummaries}`);
    
    // Count by period type
    const periodTypes = ['daily', 'weekly', 'monthly', 'yearly', 'all-time'];
    console.log(`\n📅 Summaries by Period Type:`);
    for (const periodType of periodTypes) {
      const count = await EmissionSummary.countDocuments({ 'period.type': periodType });
      console.log(`   ${periodType}: ${count}`);
    }
    
    // Count by client
    const clientIds = await EmissionSummary.distinct('clientId');
    console.log(`\n🏢 Clients with Summaries: ${clientIds.length}`);
    
    // Check for errors
    const summariesWithErrors = await EmissionSummary.countDocuments({
      'metadata.hasErrors': true
    });
    console.log(`\n⚠️  Summaries with Errors: ${summariesWithErrors}`);
    
    // Calculate total emissions across all clients
    const allTimeSummaries = await EmissionSummary.find({
      'period.type': 'all-time'
    }).select('clientId emissionSummary.totalEmissions').lean();
    
    let totalCO2e = 0;
    for (const summary of allTimeSummaries) {
      totalCO2e += summary.emissionSummary?.totalEmissions?.CO2e || 0;
    }
    
    console.log(`\n📊 Total CO2e across all clients: ${totalCO2e.toFixed(2)} tonnes`);
    
    // Sample some recent summaries
    const recentSummaries = await EmissionSummary.find()
      .sort({ 'metadata.lastCalculated': -1 })
      .limit(5)
      .select('clientId period emissionSummary.totalEmissions metadata.lastCalculated')
      .lean();
    
    console.log(`\n📋 Recent Summaries:`);
    for (const summary of recentSummaries) {
      const totalCO2e = summary.emissionSummary?.totalEmissions?.CO2e || 0;
      console.log(`   ${summary.clientId} - ${summary.period.type} ${summary.period.year || ''}/${summary.period.month || ''} - ${totalCO2e.toFixed(2)} tonnes`);
    }
    
    await mongoose.connection.close();
    
    console.log('\n' + '='.repeat(80));
    console.log('✅ VERIFICATION COMPLETE');
    console.log('='.repeat(80));
    
  } catch (error) {
    console.error('❌ Error during verification:', error);
    await mongoose.connection.close();
  }
}

// ============================================================================
// MAIN MENU
// ============================================================================

async function showMenu() {
  console.log('\n' + '='.repeat(80));
  console.log('EMISSION SUMMARY RECOVERY TOOLKIT');
  console.log('='.repeat(80));
  console.log('\nChoose an option:');
  console.log('  1. Run diagnostics (check current state)');
  console.log('  2. Test recovery on single client');
  console.log('  3. Run full recovery (all clients)');
  console.log('  4. Verify recovery results');
  console.log('  5. Exit');
  console.log('\n');
  
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  readline.question('Enter option (1-5): ', async (answer) => {
    readline.close();
    
    switch(answer.trim()) {
      case '1':
        await runDiagnostics();
        break;
      case '2':
        await testRecoverySingleClient();
        break;
      case '3':
        console.log('\n⚠️  Running full recovery...');
        console.log('This will process all clients and may take a while.');
        const recovery = require('./emission-summary-recovery');
        // This would run the full recovery script
        console.log('\nPlease run: node emission-summary-recovery.js');
        break;
      case '4':
        await verifyRecovery();
        break;
      case '5':
        console.log('\nGoodbye!');
        process.exit(0);
        break;
      default:
        console.log('\n❌ Invalid option');
    }
  });
}

// Run menu if executed directly
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    showMenu();
  } else {
    switch(args[0]) {
      case 'diagnostics':
        runDiagnostics();
        break;
      case 'test':
        testRecoverySingleClient(args[1]);
        break;
      case 'verify':
        verifyRecovery();
        break;
      default:
        console.log('Usage: node recovery-quickstart.js [diagnostics|test|verify]');
    }
  }
}

module.exports = {
  runDiagnostics,
  testRecoverySingleClient,
  verifyRecovery
};