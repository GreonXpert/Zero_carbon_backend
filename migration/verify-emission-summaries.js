/**
 * ============================================================================
 * VERIFICATION SCRIPT: Comprehensive Summary Verification
 * ============================================================================
 * 
 * Verifies both emission and reduction summaries after migration
 * 
 * USAGE:
 * node verify-summaries-COMPLETE.js
 * 
 * ============================================================================
 */

require('dotenv').config();
const mongoose = require('mongoose');
const EmissionSummary = require('../models/CalculationEmission/EmissionSummary');
const DataEntry = require('../models/Organization/DataEntry');
const NetReductionEntry = require('../models/Reduction/NetReductionEntry');
const ProcessFlowchart = require('../models/Organization/Flowchart');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  TARGET_CLIENT: 'Greon017',
  SAMPLE_SIZE: 20,
  PERIOD_TYPES: ['daily', 'weekly', 'monthly', 'yearly', 'all-time']
};

// ============================================================================
// HELPERS
// ============================================================================

function buildDateRange(periodType, year, month, week, day) {
  const now = new Date();
  let from, to;

  switch (periodType) {
    case 'daily':
      from = new Date(year, month - 1, day, 0, 0, 0);
      to = new Date(year, month - 1, day, 23, 59, 59, 999);
      break;

    case 'weekly':
      const firstDayOfYear = new Date(year, 0, 1);
      const daysToWeek = (week - 1) * 7;
      from = new Date(firstDayOfYear.getTime() + daysToWeek * 24 * 60 * 60 * 1000);
      to = new Date(from.getTime() + 6 * 24 * 60 * 60 * 1000 + 23 * 60 * 60 * 1000 + 59 * 60 * 1000 + 59 * 1000);
      break;

    case 'monthly':
      from = new Date(year, month - 1, 1, 0, 0, 0);
      to = new Date(year, month, 0, 23, 59, 59, 999);
      break;

    case 'yearly':
      from = new Date(year, 0, 1, 0, 0, 0);
      to = new Date(year, 11, 31, 23, 59, 59, 999);
      break;

    case 'all-time':
      from = new Date(2020, 0, 1, 0, 0, 0);
      to = now;
      break;

    default:
      throw new Error(`Invalid period type: ${periodType}`);
  }

  return { from, to };
}

function extractEmissionValues(calculatedEmissions) {
  const totals = { CO2e: 0, CO2: 0, CH4: 0, N2O: 0 };

  if (!calculatedEmissions || typeof calculatedEmissions !== "object") {
    return totals;
  }

  const addBucket = (bucketObj) => {
    if (!bucketObj || typeof bucketObj !== "object") return;

    const keys = (bucketObj instanceof Map) ? bucketObj.keys() : Object.keys(bucketObj);

    for (const bucketKey of keys) {
      const item = (bucketObj instanceof Map) ? bucketObj.get(bucketKey) : bucketObj[bucketKey];
      
      if (!item || typeof item !== "object") continue;

      const co2e = Number(item.CO2e ?? item.emission ?? item.CO2eWithUncertainty ?? item.emissionWithUncertainty) || 0;

      totals.CO2e += co2e;
      totals.CO2 += Number(item.CO2) || 0;
      totals.CH4 += Number(item.CH4) || 0;
      totals.N2O += Number(item.N2O) || 0;
    }
  };

  addBucket(calculatedEmissions.incoming);

  return totals;
}

// ============================================================================
// VERIFY EMISSION SUMMARY
// ============================================================================

async function verifyEmissionSummary(summary) {
  try {
    const { clientId, period } = summary;
    const { type, year, month, week, day } = period;

    const { from, to } = buildDateRange(type, year, month, week, day);

    const dataEntries = await DataEntry.find({
      clientId,
      processingStatus: 'processed',
      timestamp: { $gte: from, $lte: to }
    }).lean();

    // Calculate actual total
    let actualTotal = 0;
    for (const entry of dataEntries) {
      const emissions = extractEmissionValues(entry.calculatedEmissions);
      actualTotal += emissions.CO2e;
    }

    const summaryTotal = summary.emissionSummary?.totalEmissions?.CO2e || 0;
    const difference = Math.abs(summaryTotal - actualTotal);
    const percentDiff = actualTotal > 0 ? (difference / actualTotal) * 100 : 0;

    return {
      type: 'emission',
      status: difference < 0.01 ? 'MATCH' : 'MISMATCH',
      period: `${type} ${year || ''}${month ? '-' + month : ''}${week ? '-W' + week : ''}${day ? '-' + day : ''}`,
      summaryTotal,
      actualTotal,
      difference,
      percentDiff,
      entriesCount: dataEntries.length,
      hasUnknown: checkForUnknown(summary.emissionSummary)
    };

  } catch (error) {
    return {
      type: 'emission',
      status: 'ERROR',
      error: error.message
    };
  }
}

// ============================================================================
// VERIFY REDUCTION SUMMARY
// ============================================================================

async function verifyReductionSummary(summary) {
  try {
    const { clientId, period } = summary;
    const { type, year, month, week, day } = period;

    const { from, to } = buildDateRange(type, year, month, week, day);

    const entries = await NetReductionEntry.find({
      clientId,
      timestamp: { $gte: from, $lte: to }
    }).lean();

    // Calculate actual total
    let actualTotal = 0;
    for (const entry of entries) {
      actualTotal += Number(entry.netReduction || 0);
    }

    const summaryTotal = summary.reductionSummary?.totalNetReduction || 0;
    const difference = Math.abs(summaryTotal - actualTotal);
    const percentDiff = actualTotal > 0 ? (difference / actualTotal) * 100 : 0;

    return {
      type: 'reduction',
      status: difference < 0.01 ? 'MATCH' : 'MISMATCH',
      period: `${type} ${year || ''}${month ? '-' + month : ''}${week ? '-W' + week : ''}${day ? '-' + day : ''}`,
      summaryTotal,
      actualTotal,
      difference,
      percentDiff,
      entriesCount: entries.length,
      hasUnknown: checkForUnknown(summary.reductionSummary)
    };

  } catch (error) {
    return {
      type: 'reduction',
      status: 'ERROR',
      error: error.message
    };
  }
}

// ============================================================================
// CHECK FOR "UNKNOWN" VALUES
// ============================================================================

function checkForUnknown(summary) {
  if (!summary) return false;

  const issues = [];

  // Check byCategory
  if (summary.byCategory) {
    for (const [key, value] of Object.entries(summary.byCategory)) {
      if (key === 'Unknown' || key === 'Unknown Category') {
        issues.push(`Category: ${key}`);
      }
      if (value.activities) {
        for (const actKey of Object.keys(value.activities)) {
          if (actKey === 'Unknown' || actKey === 'Unknown Activity') {
            issues.push(`Activity: ${actKey}`);
          }
        }
      }
    }
  }

  // Check byDepartment
  if (summary.byDepartment) {
    for (const key of Object.keys(summary.byDepartment)) {
      if (key === 'Unknown') {
        issues.push(`Department: ${key}`);
      }
    }
  }

  // Check byLocation
  if (summary.byLocation) {
    for (const key of Object.keys(summary.byLocation)) {
      if (key === 'Unknown') {
        issues.push(`Location: ${key}`);
      }
    }
  }

  return issues.length > 0 ? issues : false;
}

// ============================================================================
// MAIN VERIFICATION
// ============================================================================

async function runVerification() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║  COMPREHENSIVE SUMMARY VERIFICATION                            ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');

  try {
    // Connect to MongoDB
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');
    console.log('');

    // Get statistics
    const totalSummaries = await EmissionSummary.countDocuments({ clientId: CONFIG.TARGET_CLIENT });

    const withEmissions = await EmissionSummary.countDocuments({
      clientId: CONFIG.TARGET_CLIENT,
      'emissionSummary.totalEmissions.CO2e': { $gt: 0 }
    });

    const withReductions = await EmissionSummary.countDocuments({
      clientId: CONFIG.TARGET_CLIENT,
      'reductionSummary.totalNetReduction': { $gt: 0 }
    });

    console.log('📊 Summary Statistics:');
    console.log(`   - Total Summaries: ${totalSummaries}`);
    console.log(`   - With Emissions: ${withEmissions}`);
    console.log(`   - With Reductions: ${withReductions}`);
    console.log('');

    // Verification results
    const results = {
      emissionMatches: 0,
      emissionMismatches: 0,
      reductionMatches: 0,
      reductionMismatches: 0,
      unknownIssues: 0,
      errors: 0
    };

    // Sample and verify
    console.log('🔍 Verifying sample summaries...');
    console.log('');

    for (const periodType of CONFIG.PERIOD_TYPES) {
      console.log(`\n📅 ${periodType.toUpperCase()} Summaries:`);
      console.log('─'.repeat(70));

      const samples = await EmissionSummary.aggregate([
        {
          $match: {
            clientId: CONFIG.TARGET_CLIENT,
            'period.type': periodType,
            'emissionSummary.totalEmissions.CO2e': { $gt: 0 }
          }
        },
        { $sample: { size: Math.floor(CONFIG.SAMPLE_SIZE / CONFIG.PERIOD_TYPES.length) } }
      ]);

      for (const summary of samples) {
        // Verify emissions
        const emissionResult = await verifyEmissionSummary(summary);
        
        if (emissionResult.status === 'MATCH') {
          results.emissionMatches++;
          console.log(`  ✅ EMISSION ${emissionResult.period}: ${emissionResult.summaryTotal.toFixed(2)} CO2e (${emissionResult.entriesCount} entries)`);
        } else if (emissionResult.status === 'MISMATCH') {
          results.emissionMismatches++;
          console.log(`  ❌ EMISSION ${emissionResult.period}:`);
          console.log(`     Summary: ${emissionResult.summaryTotal.toFixed(2)} CO2e`);
          console.log(`     Actual:  ${emissionResult.actualTotal.toFixed(2)} CO2e`);
          console.log(`     Diff:    ${emissionResult.difference.toFixed(2)} (${emissionResult.percentDiff.toFixed(2)}%)`);
        } else {
          results.errors++;
          console.log(`  ⚠️ EMISSION ${emissionResult.period}: ERROR - ${emissionResult.error}`);
        }

        // Check for unknowns
        if (emissionResult.hasUnknown) {
          results.unknownIssues++;
          console.log(`  ⚠️ Found "Unknown" values: ${emissionResult.hasUnknown.join(', ')}`);
        }

        // Verify reductions if present
        if (summary.reductionSummary) {
          const reductionResult = await verifyReductionSummary(summary);
          
          if (reductionResult.status === 'MATCH') {
            results.reductionMatches++;
            console.log(`     💚 REDUCTION: ${reductionResult.summaryTotal.toFixed(2)} CO2e reduced`);
          } else if (reductionResult.status === 'MISMATCH') {
            results.reductionMismatches++;
            console.log(`     ❌ REDUCTION mismatch: ${reductionResult.difference.toFixed(2)} CO2e`);
          }
        }
      }
    }

    // Final report
    console.log('\n');
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║  VERIFICATION COMPLETE                                         ║');
    console.log('╚════════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('📊 Verification Results:');
    console.log(`   - Emission Matches: ${results.emissionMatches} ✅`);
    console.log(`   - Emission Mismatches: ${results.emissionMismatches} ❌`);
    console.log(`   - Reduction Matches: ${results.reductionMatches} ✅`);
    console.log(`   - Reduction Mismatches: ${results.reductionMismatches} ❌`);
    console.log(`   - "Unknown" Issues: ${results.unknownIssues} ⚠️`);
    console.log(`   - Errors: ${results.errors} ⚠️`);
    console.log('');

    if (results.emissionMatches > 0 && results.emissionMismatches === 0 && results.unknownIssues === 0) {
      console.log('✅ All verified summaries are correct with proper metadata!');
    } else if (results.unknownIssues > 0) {
      console.log('⚠️ Some summaries still have "Unknown" values. Review metadata extraction.');
    } else if (results.emissionMismatches > 0) {
      console.log('⚠️ Some summaries have mismatches. Review calculation logic.');
    }

  } catch (error) {
    console.error('\n❌ Verification failed:', error);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
}

// Run verification
runVerification()
  .then(() => {
    console.log('✅ Verification completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Verification failed:', error);
    process.exit(1);
  });