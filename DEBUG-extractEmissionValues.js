/**
 * ============================================================================
 * DEBUG SCRIPT: Why is extractEmissionValues returning 0?
 * ============================================================================
 * 
 * This script will:
 * 1. Get actual DataEntry records
 * 2. Show their calculatedEmissions structure
 * 3. Test the current extractEmissionValues function
 * 4. Show exactly what's wrong
 * 
 * Run this BEFORE applying the fix to see the problem
 * ============================================================================
 */

require('dotenv').config();
const mongoose = require('mongoose');

const DataEntry = require('./models/Organization/DataEntry');

// ============================================================================
// COPY THE CURRENT (BROKEN) extractEmissionValues FROM YOUR CODE
// ============================================================================

function extractEmissionValuesCURRENT(calculatedEmissions) {
  const totals = { CO2e: 0, CO2: 0, CH4: 0, N2O: 0 };

  if (!calculatedEmissions || typeof calculatedEmissions !== "object") {
    return totals;
  }

  const addBucket = (bucketObj) => {
    if (!bucketObj || typeof bucketObj !== "object") return;

    // Handle Map (if it comes from mongoose as a Map) or Object
    const keys = (bucketObj instanceof Map) ? bucketObj.keys() : Object.keys(bucketObj);

    for (const bucketKey of keys) {
      const item = (bucketObj instanceof Map) ? bucketObj.get(bucketKey) : bucketObj[bucketKey];
      
      if (!item || typeof item !== "object") continue;

      const co2e =
        Number(item.CO2e ??
              item.emission ??
              item.CO2eWithUncertainty ??
              item.emissionWithUncertainty) || 0;

      totals.CO2e += co2e;
      totals.CO2 += Number(item.CO2) || 0;
      totals.CH4 += Number(item.CH4) || 0;
      totals.N2O += Number(item.N2O) || 0;
    }
  };

  // THIS IS THE PROBLEM - It adds both incoming AND cumulative
  if (calculatedEmissions.incoming) {
    addBucket(calculatedEmissions.incoming);
  }
  if (calculatedEmissions.cumulative) {
    addBucket(calculatedEmissions.cumulative);
  }

  return totals;
}

// ============================================================================
// CORRECTED VERSION
// ============================================================================

function extractEmissionValuesCORRECT(calculatedEmissions) {
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

      const co2e =
        Number(item.CO2e ??
              item.emission ??
              item.CO2eWithUncertainty ??
              item.emissionWithUncertainty) || 0;

      totals.CO2e += co2e;
      totals.CO2 += Number(item.CO2) || 0;
      totals.CH4 += Number(item.CH4) || 0;
      totals.N2O += Number(item.N2O) || 0;
    }
  };

  // CORRECTED: Only use incoming!
  if (calculatedEmissions.incoming) {
    addBucket(calculatedEmissions.incoming);
  }

  return totals;
}

// ============================================================================
// DETAILED STRUCTURE ANALYSIS
// ============================================================================

function analyzeCalculatedEmissions(calculatedEmissions) {
  console.log('\n' + '='.repeat(80));
  console.log('DETAILED STRUCTURE ANALYSIS');
  console.log('='.repeat(80));
  
  if (!calculatedEmissions) {
    console.log('❌ calculatedEmissions is NULL or UNDEFINED');
    return null;
  }
  
  console.log('\n✅ calculatedEmissions exists');
  console.log(`   Type: ${typeof calculatedEmissions}`);
  console.log(`   Keys: ${Object.keys(calculatedEmissions).join(', ')}`);
  
  // Check incoming
  if (calculatedEmissions.incoming) {
    console.log('\n📊 INCOMING bucket found:');
    console.log(`   Keys: ${Object.keys(calculatedEmissions.incoming).join(', ')}`);
    
    for (const key of Object.keys(calculatedEmissions.incoming)) {
      const item = calculatedEmissions.incoming[key];
      console.log(`\n   ${key}:`);
      console.log(`      CO2e: ${item.CO2e}`);
      console.log(`      CO2: ${item.CO2}`);
      console.log(`      CH4: ${item.CH4}`);
      console.log(`      N2O: ${item.N2O}`);
    }
  } else {
    console.log('\n❌ NO incoming bucket');
  }
  
  // Check cumulative
  if (calculatedEmissions.cumulative) {
    console.log('\n📊 CUMULATIVE bucket found:');
    console.log(`   Keys: ${Object.keys(calculatedEmissions.cumulative).join(', ')}`);
    
    for (const key of Object.keys(calculatedEmissions.cumulative)) {
      const item = calculatedEmissions.cumulative[key];
      console.log(`\n   ${key}:`);
      console.log(`      CO2e: ${item.CO2e}`);
      console.log(`      CO2: ${item.CO2}`);
      console.log(`      CH4: ${item.CH4}`);
      console.log(`      N2O: ${item.N2O}`);
    }
  } else {
    console.log('\n❌ NO cumulative bucket');
  }
  
  return {
    hasIncoming: !!calculatedEmissions.incoming,
    hasCumulative: !!calculatedEmissions.cumulative,
    incomingKeys: calculatedEmissions.incoming ? Object.keys(calculatedEmissions.incoming) : [],
    cumulativeKeys: calculatedEmissions.cumulative ? Object.keys(calculatedEmissions.cumulative) : []
  };
}

// ============================================================================
// MAIN DEBUG FUNCTION
// ============================================================================

async function debugExtractEmissionValues() {
  console.log('\n');
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║           DEBUG: extractEmissionValues Function               ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');

  try {
    // Connect to database
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // Get sample data entries
    const entries = await DataEntry.find({
      clientId: 'Greon017',
      processingStatus: 'processed',
      calculatedEmissions: { $exists: true }
    })
    .limit(5)
    .lean();

    if (entries.length === 0) {
      console.log('❌ No processed entries with calculatedEmissions found!');
      return;
    }

    console.log(`✅ Found ${entries.length} entries with calculatedEmissions\n`);

    // Test each entry
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      
      console.log('\n' + '═'.repeat(80));
      console.log(`ENTRY ${i + 1} / ${entries.length}`);
      console.log('═'.repeat(80));
      console.log(`ID: ${entry._id}`);
      console.log(`Timestamp: ${entry.timestamp}`);
      console.log(`Node: ${entry.nodeId}`);
      console.log(`Scope: ${entry.scopeIdentifier}`);
      
      // Analyze structure
      const analysis = analyzeCalculatedEmissions(entry.calculatedEmissions);
      
      if (!analysis) {
        console.log('\n❌ Could not analyze calculatedEmissions');
        continue;
      }
      
      // Test current (broken) function
      console.log('\n' + '-'.repeat(80));
      console.log('TESTING CURRENT extractEmissionValues:');
      console.log('-'.repeat(80));
      
      const currentResult = extractEmissionValuesCURRENT(entry.calculatedEmissions);
      console.log(`Result: CO2e = ${currentResult.CO2e}`);
      
      if (currentResult.CO2e === 0) {
        console.log('❌ RETURNS ZERO! This is the problem!');
      } else {
        console.log(`✅ Returns: ${currentResult.CO2e}`);
      }
      
      // Test corrected function
      console.log('\n' + '-'.repeat(80));
      console.log('TESTING CORRECTED extractEmissionValues:');
      console.log('-'.repeat(80));
      
      const correctResult = extractEmissionValuesCORRECT(entry.calculatedEmissions);
      console.log(`Result: CO2e = ${correctResult.CO2e}`);
      
      if (correctResult.CO2e > 0) {
        console.log(`✅ WORKS! Returns: ${correctResult.CO2e}`);
      } else {
        console.log('⚠️  Still returns zero - different issue');
      }
      
      // Show the difference
      console.log('\n' + '-'.repeat(80));
      console.log('COMPARISON:');
      console.log('-'.repeat(80));
      console.log(`Current version: ${currentResult.CO2e} CO2e`);
      console.log(`Correct version: ${correctResult.CO2e} CO2e`);
      console.log(`Difference: ${Math.abs(correctResult.CO2e - currentResult.CO2e)} CO2e`);
      
      if (currentResult.CO2e !== correctResult.CO2e) {
        console.log('\n⚠️  THE FUNCTIONS PRODUCE DIFFERENT RESULTS!');
        console.log('   This confirms the extractEmissionValues function needs to be fixed.');
      }
    }

    // ============================================================
    // FINAL DIAGNOSIS
    // ============================================================
    
    console.log('\n\n');
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║                    DIAGNOSIS SUMMARY                           ║');
    console.log('╚════════════════════════════════════════════════════════════════╝');
    console.log('');
    
    // Calculate totals
    let totalCurrent = 0;
    let totalCorrect = 0;
    
    for (const entry of entries) {
      totalCurrent += extractEmissionValuesCURRENT(entry.calculatedEmissions).CO2e;
      totalCorrect += extractEmissionValuesCORRECT(entry.calculatedEmissions).CO2e;
    }
    
    console.log(`Sample of ${entries.length} entries:`);
    console.log(`  Current function total: ${totalCurrent.toFixed(3)} CO2e`);
    console.log(`  Correct function total: ${totalCorrect.toFixed(3)} CO2e`);
    console.log('');
    
    if (totalCurrent === 0 && totalCorrect > 0) {
      console.log('🔴 CRITICAL ISSUE IDENTIFIED:');
      console.log('   The current extractEmissionValues function returns ZERO');
      console.log('   but the corrected version returns valid values.');
      console.log('');
      console.log('💡 ROOT CAUSE:');
      console.log('   The function is not correctly extracting data from');
      console.log('   the calculatedEmissions.incoming bucket.');
      console.log('');
      console.log('✅ SOLUTION:');
      console.log('   1. Open: controllers/Calculation/CalculationSummary.js');
      console.log('   2. Find: extractEmissionValues function (line ~72)');
      console.log('   3. Replace with the corrected version');
      console.log('   4. Restart your server');
      console.log('   5. Re-run the migration script');
      console.log('');
    } else if (totalCurrent > 0 && totalCorrect > 0) {
      console.log('✅ Function appears to be working');
      console.log('   Issue might be elsewhere in the calculation pipeline');
    } else {
      console.log('⚠️  Both functions return zero');
      console.log('   The issue might be:');
      console.log('   1. calculatedEmissions data is missing/corrupt');
      console.log('   2. Data structure is different than expected');
      console.log('   3. Emission calculation never ran on these entries');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB');
  }
}

// ============================================================================
// RUN DEBUG
// ============================================================================

if (require.main === module) {
  debugExtractEmissionValues()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

module.exports = { debugExtractEmissionValues };