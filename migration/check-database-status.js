/**
 * ============================================================================
 * DATABASE STATUS CHECKER
 * ============================================================================
 * 
 * Quick script to check the current state of emission summaries
 * 
 * Usage: node check-database-status.js
 * 
 * ============================================================================
 */

require('dotenv').config();
const mongoose = require('mongoose');
const EmissionSummary = require('../models/CalculationEmission/EmissionSummary');
const DataEntry = require('../models/Organization/DataEntry');
const NetReductionEntry = require('../models/Reduction/NetReductionEntry');
const ProcessFlowchart = require('../models/Organization/Flowchart');

async function checkStatus() {
  try {
    console.log('\n' + '='.repeat(80));
    console.log('DATABASE STATUS CHECK');
    console.log('='.repeat(80) + '\n');
    
    await mongoose.connect("mongodb+srv://zerocarbon:zerocarbon@zerocarbon.ujopg7s.mongodb.net/zeroCarbon");
    
    // ========================================================================
    // EMISSION SUMMARIES
    // ========================================================================
    console.log('📊 EMISSION SUMMARIES\n');
    
    const totalSummaries = await EmissionSummary.countDocuments();
    console.log(`Total Summaries: ${totalSummaries}`);
    
    if (totalSummaries === 0) {
      console.log('❌ WARNING: No emission summaries found!');
      console.log('   The database may have been deleted.\n');
    } else {
      // Count by period type
      const periodTypes = ['daily', 'weekly', 'monthly', 'yearly', 'all-time'];
      console.log('\nBy Period Type:');
      for (const periodType of periodTypes) {
        const count = await EmissionSummary.countDocuments({ 'period.type': periodType });
        console.log(`  ${periodType.padEnd(12)}: ${count}`);
      }
      
      // Clients with summaries
      const clientsWithSummaries = await EmissionSummary.distinct('clientId');
      console.log(`\nClients with summaries: ${clientsWithSummaries.length}`);
      
      // Summaries with errors
      const withErrors = await EmissionSummary.countDocuments({ 'metadata.hasErrors': true });
      console.log(`Summaries with errors: ${withErrors}`);
      
      // Recent calculation
      const mostRecent = await EmissionSummary.findOne()
        .sort({ 'metadata.lastCalculated': -1 })
        .select('metadata.lastCalculated clientId period');
      
      if (mostRecent) {
        const timeSince = Date.now() - new Date(mostRecent.metadata.lastCalculated).getTime();
        const hoursSince = Math.floor(timeSince / 1000 / 60 / 60);
        console.log(`Last calculation: ${mostRecent.metadata.lastCalculated.toISOString()} (${hoursSince}h ago)`);
      }
      
      // Total emissions
      const allTimeSummaries = await EmissionSummary.find({ 'period.type': 'all-time' })
        .select('emissionSummary.totalEmissions')
        .lean();
      
      const totalCO2e = allTimeSummaries.reduce((sum, s) => 
        sum + (s.emissionSummary?.totalEmissions?.CO2e || 0), 0
      );
      
      console.log(`\nTotal CO2e (all-time): ${totalCO2e.toFixed(2)} tonnes`);
    }
    
    // ========================================================================
    // DATA ENTRIES
    // ========================================================================
    console.log('\n' + '-'.repeat(80) + '\n');
    console.log('📝 DATA ENTRIES\n');
    
    const totalEntries = await DataEntry.countDocuments();
    const completedEmissions = await DataEntry.countDocuments({
      emissionCalculationStatus: 'completed',
      calculatedEmissions: { $exists: true }
    });
    const pendingEmissions = await DataEntry.countDocuments({
      emissionCalculationStatus: 'pending'
    });
    const failedEmissions = await DataEntry.countDocuments({
      emissionCalculationStatus: { $in: ['failed', 'error'] }
    });
    
    console.log(`Total entries: ${totalEntries}`);
    console.log(`Completed emissions: ${completedEmissions}`);
    console.log(`Pending: ${pendingEmissions}`);
    console.log(`Failed: ${failedEmissions}`);
    
    const clientsWithData = await DataEntry.distinct('clientId');
    console.log(`\nClients with data: ${clientsWithData.length}`);
    
    // Check if we have data but no summaries
    if (completedEmissions > 0 && totalSummaries === 0) {
      console.log('\n⚠️  ISSUE DETECTED:');
      console.log('   You have completed emission calculations but no summaries.');
      console.log('   This suggests the summary database was deleted.');
      console.log('   Run recovery: node emission-summary-recovery.js');
    }
    
    // ========================================================================
    // REDUCTION ENTRIES
    // ========================================================================
    console.log('\n' + '-'.repeat(80) + '\n');
    console.log('🌱 REDUCTION ENTRIES\n');
    
    const totalReductions = await NetReductionEntry.countDocuments();
    const clientsWithReductions = await NetReductionEntry.distinct('clientId');
    
    console.log(`Total reduction entries: ${totalReductions}`);
    console.log(`Clients with reductions: ${clientsWithReductions.length}`);
    
    if (totalReductions > 0) {
      const recentReduction = await NetReductionEntry.findOne()
        .sort({ timestamp: -1 })
        .select('timestamp netReduction');
      
      if (recentReduction) {
        console.log(`Latest entry: ${recentReduction.timestamp.toISOString()}`);
      }
      
      // Check for reduction summaries
      const summariesWithReductions = await EmissionSummary.countDocuments({
        'reductionSummary.totalNetReduction': { $exists: true, $ne: 0 }
      });
      
      console.log(`\nSummaries with reductions: ${summariesWithReductions}`);
      
      if (totalReductions > 0 && summariesWithReductions === 0) {
        console.log('⚠️  Reduction entries exist but no reduction summaries found.');
      }
    }
    
    // ========================================================================
    // PROCESS FLOWCHARTS
    // ========================================================================
    console.log('\n' + '-'.repeat(80) + '\n');
    console.log('📐 PROCESS FLOWCHARTS\n');
    
    const totalFlowcharts = await ProcessFlowchart.countDocuments({ isDeleted: false });
    const clientsWithFlowcharts = await ProcessFlowchart.distinct('clientId', { isDeleted: false });
    
    console.log(`Active flowcharts: ${totalFlowcharts}`);
    console.log(`Clients with flowcharts: ${clientsWithFlowcharts.length}`);
    
    // Check for process emission summaries
    const processEmissionSummaries = await EmissionSummary.countDocuments({
      'processEmissionSummary.totalEmissions': { $exists: true }
    });
    
    console.log(`Summaries with process emissions: ${processEmissionSummaries}`);
    
    // ========================================================================
    // DATA CONSISTENCY CHECKS
    // ========================================================================
    console.log('\n' + '='.repeat(80) + '\n');
    console.log('🔍 CONSISTENCY CHECKS\n');
    
    const checks = [];
    
    // Check 1: Clients with data should have summaries
    const clientsMissingEmissionSummaries = clientsWithData.filter(c => 
      !clientsWithSummaries.includes(c)
    );
    
    if (clientsMissingEmissionSummaries.length > 0) {
      checks.push({
        status: '⚠️',
        issue: `${clientsMissingEmissionSummaries.length} clients have data but no emission summaries`,
        clients: clientsMissingEmissionSummaries.slice(0, 5)
      });
    } else {
      checks.push({
        status: '✅',
        issue: 'All clients with data have emission summaries'
      });
    }
    
    // Check 2: Clients with reductions should have reduction summaries
    if (totalReductions > 0) {
      const summariesWithReductionData = await EmissionSummary.distinct('clientId', {
        'reductionSummary.totalNetReduction': { $exists: true, $ne: 0 }
      });
      
      const clientsMissingReductionSummaries = clientsWithReductions.filter(c =>
        !summariesWithReductionData.includes(c)
      );
      
      if (clientsMissingReductionSummaries.length > 0) {
        checks.push({
          status: '⚠️',
          issue: `${clientsMissingReductionSummaries.length} clients have reductions but no reduction summaries`,
          clients: clientsMissingReductionSummaries.slice(0, 5)
        });
      } else {
        checks.push({
          status: '✅',
          issue: 'All clients with reductions have reduction summaries'
        });
      }
    }
    
    // Check 3: Clients with flowcharts should have process summaries
    if (totalFlowcharts > 0) {
      const summariesWithProcessData = await EmissionSummary.distinct('clientId', {
        'processEmissionSummary.totalEmissions.CO2e': { $gt: 0 }
      });
      
      const clientsMissingProcessSummaries = clientsWithFlowcharts.filter(c =>
        !summariesWithProcessData.includes(c)
      );
      
      if (clientsMissingProcessSummaries.length > 0) {
        checks.push({
          status: '⚠️',
          issue: `${clientsMissingProcessSummaries.length} clients have flowcharts but no process summaries`,
          clients: clientsMissingProcessSummaries.slice(0, 5)
        });
      } else {
        checks.push({
          status: '✅',
          issue: 'All clients with flowcharts have process summaries'
        });
      }
    }
    
    // Display checks
    for (const check of checks) {
      console.log(`${check.status} ${check.issue}`);
      if (check.clients && check.clients.length > 0) {
        console.log(`   Sample clients: ${check.clients.join(', ')}`);
      }
    }
    
    // ========================================================================
    // RECOMMENDATIONS
    // ========================================================================
    const hasIssues = checks.some(c => c.status === '⚠️');
    
    if (hasIssues) {
      console.log('\n' + '='.repeat(80) + '\n');
      console.log('📋 RECOMMENDATIONS\n');
      
      if (totalSummaries === 0 && completedEmissions > 0) {
        console.log('🔧 CRITICAL: Run database recovery immediately');
        console.log('   Command: node emission-summary-recovery.js\n');
      } else if (clientsMissingEmissionSummaries.length > 0) {
        console.log('🔧 Run recovery for specific clients:');
        console.log('   1. First test: node recovery-quickstart.js test <clientId>');
        console.log('   2. Then full recovery: node emission-summary-recovery.js\n');
      }
      
      console.log('📚 For detailed instructions, see: RECOVERY_GUIDE.md');
    } else {
      console.log('\n' + '='.repeat(80) + '\n');
      console.log('✅ DATABASE STATUS: HEALTHY\n');
      console.log('All checks passed. Your database is in good shape!');
      console.log('\nRecommendation: Create a backup to prevent future data loss');
      console.log('Command: node backup-emission-summaries.js full');
    }
    
    console.log('\n' + '='.repeat(80) + '\n');
    
    await mongoose.connection.close();
    
  } catch (error) {
    console.error('\n❌ Error checking status:', error);
    await mongoose.connection.close();
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  checkStatus();
}

module.exports = { checkStatus };