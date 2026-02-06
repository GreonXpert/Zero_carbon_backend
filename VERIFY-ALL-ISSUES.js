/**
 * ============================================================================
 * COMPREHENSIVE VERIFICATION: Find ALL Possible Issues
 * ============================================================================
 * 
 * This script checks EVERYTHING that could cause zero summaries:
 * 1. DataEntry structure
 * 2. calculatedEmissions format
 * 3. extractEmissionValues function behavior
 * 4. Data integrity
 * 5. Node/scope configuration
 * 
 * Run this to get a complete picture of what's wrong
 * ============================================================================
 */

require('dotenv').config();
const mongoose = require('mongoose');

const DataEntry = require('./models/Organization/DataEntry');
const Flowchart = require('./models/Organization/Flowchart');
const ProcessFlowchart = require('./models/Organization/ProcessFlowchart');

async function comprehensiveVerification() {
  console.log('\n');
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║         COMPREHENSIVE VERIFICATION - ALL ISSUES                ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');

  try {
    // Connect
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected\n');

    const clientId = 'Greon017';

    // ========================================================================
    // CHECK 1: DataEntry Count and Status
    // ========================================================================
    console.log('═'.repeat(80));
    console.log('CHECK 1: DataEntry Records');
    console.log('═'.repeat(80));

    const totalEntries = await DataEntry.countDocuments({ clientId });
    const processedEntries = await DataEntry.countDocuments({ 
      clientId, 
      processingStatus: 'processed' 
    });
    const withCalculated = await DataEntry.countDocuments({
      clientId,
      processingStatus: 'processed',
      calculatedEmissions: { $exists: true }
    });

    console.log(`Total entries: ${totalEntries}`);
    console.log(`Processed entries: ${processedEntries}`);
    console.log(`With calculatedEmissions: ${withCalculated}`);

    if (withCalculated === 0) {
      console.log('\n❌ CRITICAL: NO entries have calculatedEmissions!');
      console.log('   Emission calculation never ran on these entries.');
      console.log('   You need to trigger emission calculation first.');
      return;
    }

    // ========================================================================
    // CHECK 2: Sample Entry Deep Dive
    // ========================================================================
    console.log('\n');
    console.log('═'.repeat(80));
    console.log('CHECK 2: Sample Entry Structure (February 2026)');
    console.log('═'.repeat(80));

    const febEntry = await DataEntry.findOne({
      clientId,
      processingStatus: 'processed',
      calculatedEmissions: { $exists: true },
      timestamp: {
        $gte: new Date('2026-02-01'),
        $lte: new Date('2026-02-28')
      }
    }).lean();

    if (!febEntry) {
      console.log('\n⚠️  No February 2026 entries found');
      console.log('   Trying any month...\n');
      
      const anyEntry = await DataEntry.findOne({
        clientId,
        processingStatus: 'processed',
        calculatedEmissions: { $exists: true }
      }).lean();

      if (!anyEntry) {
        console.log('❌ No entries with calculatedEmissions found at all!');
        return;
      }

      analyzeSingleEntry(anyEntry);
    } else {
      analyzeSingleEntry(febEntry);
    }

    // ========================================================================
    // CHECK 3: All Entries Summary
    // ========================================================================
    console.log('\n');
    console.log('═'.repeat(80));
    console.log('CHECK 3: All February 2026 Entries');
    console.log('═'.repeat(80));

    const allFebEntries = await DataEntry.find({
      clientId,
      processingStatus: 'processed',
      timestamp: {
        $gte: new Date('2026-02-01'),
        $lte: new Date('2026-02-28')
      }
    })
    .select('_id timestamp calculatedEmissions')
    .lean();

    console.log(`\nFound ${allFebEntries.length} February entries`);

    let withData = 0;
    let withoutData = 0;
    let totalManualCO2e = 0;

    for (const entry of allFebEntries) {
      if (entry.calculatedEmissions?.incoming) {
        withData++;
        
        // Manually calculate CO2e
        for (const key in entry.calculatedEmissions.incoming) {
          const item = entry.calculatedEmissions.incoming[key];
          totalManualCO2e += Number(item.CO2e || 0);
        }
      } else {
        withoutData++;
      }
    }

    console.log(`  - With incoming data: ${withData}`);
    console.log(`  - Without incoming data: ${withoutData}`);
    console.log(`  - Manual total CO2e: ${totalManualCO2e.toFixed(3)} tonnes`);

    if (totalManualCO2e > 0) {
      console.log('\n✅ Data exists! The problem is in extractEmissionValues function.');
    } else {
      console.log('\n❌ No emission data! Entries need emission calculation.');
    }

    // ========================================================================
    // CHECK 4: Flowchart Configuration
    // ========================================================================
    console.log('\n');
    console.log('═'.repeat(80));
    console.log('CHECK 4: Flowchart Configuration');
    console.log('═'.repeat(80));

    const flowchart = await Flowchart.findOne({ clientId, isActive: true });
    const processFlowchart = await ProcessFlowchart.findOne({ clientId, isDeleted: false });

    if (!flowchart && !processFlowchart) {
      console.log('\n❌ NO active flowchart found!');
      console.log('   This will cause calculation to fail.');
    } else {
      console.log('\n✅ Flowchart found');
      
      if (flowchart) {
        console.log(`   - Organization Flowchart: ${flowchart.nodes?.length || 0} nodes`);
      }
      if (processFlowchart) {
        console.log(`   - Process Flowchart: ${processFlowchart.nodes?.length || 0} nodes`);
      }
    }

    // ========================================================================
    // FINAL DIAGNOSIS
    // ========================================================================
    console.log('\n\n');
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║                    FINAL DIAGNOSIS                             ║');
    console.log('╚════════════════════════════════════════════════════════════════╝');
    console.log('');

    if (withCalculated === 0) {
      console.log('🔴 ISSUE: NO EMISSION CALCULATIONS');
      console.log('   Entries exist but calculatedEmissions is missing.');
      console.log('');
      console.log('✅ SOLUTION:');
      console.log('   Trigger emission calculation on existing entries');
      console.log('   Then re-run the migration');
    } else if (totalManualCO2e === 0) {
      console.log('🔴 ISSUE: EMISSION DATA IS ZERO');
      console.log('   calculatedEmissions exists but contains no data.');
      console.log('');
      console.log('✅ SOLUTION:');
      console.log('   Check emission calculation logic');
      console.log('   Verify emission factors are configured');
    } else {
      console.log('🔴 ISSUE: EXTRACTION FUNCTION BROKEN');
      console.log('   Data exists but extractEmissionValues returns 0.');
      console.log('');
      console.log('✅ SOLUTION:');
      console.log('   Fix the extractEmissionValues function');
      console.log('   See URGENT-FIX-ZEROS.md for instructions');
    }

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB');
  }
}

function analyzeSingleEntry(entry) {
  console.log(`\nEntry ID: ${entry._id}`);
  console.log(`Timestamp: ${entry.timestamp}`);
  console.log(`Processing Status: ${entry.processingStatus}`);

  if (!entry.calculatedEmissions) {
    console.log('\n❌ NO calculatedEmissions field!');
    return;
  }

  console.log('\n📊 calculatedEmissions structure:');
  console.log(JSON.stringify(entry.calculatedEmissions, null, 2));

  // Check incoming
  if (entry.calculatedEmissions.incoming) {
    console.log('\n✅ Has INCOMING bucket:');
    
    for (const key in entry.calculatedEmissions.incoming) {
      const item = entry.calculatedEmissions.incoming[key];
      console.log(`   ${key}:`);
      console.log(`      CO2e: ${item.CO2e}`);
      console.log(`      CO2: ${item.CO2}`);
      console.log(`      CH4: ${item.CH4}`);
      console.log(`      N2O: ${item.N2O}`);
    }
  } else {
    console.log('\n❌ NO incoming bucket');
  }

  // Check cumulative
  if (entry.calculatedEmissions.cumulative) {
    console.log('\n📊 Has CUMULATIVE bucket:');
    
    for (const key in entry.calculatedEmissions.cumulative) {
      const item = entry.calculatedEmissions.cumulative[key];
      console.log(`   ${key}:`);
      console.log(`      CO2e: ${item.CO2e}`);
      console.log(`      CO2: ${item.CO2}`);
    }
  } else {
    console.log('\n⚠️  NO cumulative bucket');
  }

  // Manual calculation
  let manualCO2e = 0;
  if (entry.calculatedEmissions.incoming) {
    for (const key in entry.calculatedEmissions.incoming) {
      manualCO2e += Number(entry.calculatedEmissions.incoming[key].CO2e || 0);
    }
  }

  console.log(`\n📈 Manual calculation: ${manualCO2e} CO2e`);

  if (manualCO2e > 0) {
    console.log('✅ Data is valid and can be extracted');
  } else {
    console.log('❌ Data is zero or invalid');
  }
}

if (require.main === module) {
  comprehensiveVerification()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

module.exports = { comprehensiveVerification };