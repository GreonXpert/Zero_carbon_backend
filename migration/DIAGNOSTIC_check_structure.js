/**
 * ============================================================================
 * DIAGNOSTIC SCRIPT - Check EmissionSummary Structure
 * ============================================================================
 * 
 * This script analyzes your EmissionSummary collection to understand
 * the actual structure and help fix the migration query
 * 
 * ============================================================================
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function diagnose() {
  console.log('\n' + '='.repeat(80));
  console.log('🔍 DIAGNOSTIC - EmissionSummary Structure Analysis');
  console.log('='.repeat(80) + '\n');

  try {
    // Connect to MongoDB
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    const db = mongoose.connection.db;
    const collection = db.collection('emissionsummaries');

    // 1. Count total documents
    console.log('📊 Document Counts:');
    console.log('─'.repeat(80));
    
    const totalCount = await collection.countDocuments({});
    console.log(`Total EmissionSummary documents: ${totalCount}`);

    if (totalCount === 0) {
      console.log('\n❌ No documents found in emissionsummaries collection');
      console.log('   Collection might be named differently or database is empty');
      
      // List all collections
      console.log('\n📋 Available collections:');
      const collections = await db.listCollections().toArray();
      collections.forEach(col => console.log(`   - ${col.name}`));
      
      return;
    }

    // 2. Check for processEmissionSummary field
    const withProcessEmissionSummary = await collection.countDocuments({
      processEmissionSummary: { $exists: true }
    });
    console.log(`Documents with processEmissionSummary: ${withProcessEmissionSummary}`);

    const withProcessEmissionSummaryByScopeId = await collection.countDocuments({
      'processEmissionSummary.byScopeIdentifier': { $exists: true }
    });
    console.log(`Documents with processEmissionSummary.byScopeIdentifier: ${withProcessEmissionSummaryByScopeId}`);

    const withProcessEmissionSummaryNotNull = await collection.countDocuments({
      processEmissionSummary: { $ne: null, $exists: true }
    });
    console.log(`Documents with non-null processEmissionSummary: ${withProcessEmissionSummaryNotNull}`);

    // 3. Sample a few documents to see structure
    console.log('\n📄 Sample Document Structure:');
    console.log('─'.repeat(80));
    
    const samples = await collection.find({}).limit(3).toArray();
    
    samples.forEach((doc, index) => {
      console.log(`\nSample ${index + 1}:`);
      console.log(`  _id: ${doc._id}`);
      console.log(`  clientId: ${doc.clientId || 'N/A'}`);
      console.log(`  period.type: ${doc.period?.type || 'N/A'}`);
      console.log(`  period.year: ${doc.period?.year || 'N/A'}`);
      console.log(`  period.month: ${doc.period?.month || 'N/A'}`);
      
      // Check top-level fields
      const topLevelFields = Object.keys(doc);
      console.log(`  Top-level fields: ${topLevelFields.join(', ')}`);
      
      // Check if processEmissionSummary exists
      if (doc.processEmissionSummary) {
        console.log(`  ✅ Has processEmissionSummary`);
        const pesFields = Object.keys(doc.processEmissionSummary);
        console.log(`     Fields: ${pesFields.join(', ')}`);
        
        if (doc.processEmissionSummary.byScopeIdentifier) {
          const scopeIds = Object.keys(doc.processEmissionSummary.byScopeIdentifier);
          console.log(`     ✅ Has byScopeIdentifier with ${scopeIds.length} scopes`);
          
          // Check first scope for structure
          if (scopeIds.length > 0) {
            const firstScope = doc.processEmissionSummary.byScopeIdentifier[scopeIds[0]];
            const scopeFields = Object.keys(firstScope);
            console.log(`     First scope (${scopeIds[0]}) fields: ${scopeFields.join(', ')}`);
            
            // Check if already has allocation breakdown
            if (firstScope.allocationBreakdown) {
              console.log(`     ✅ Already has allocationBreakdown`);
            } else {
              console.log(`     ❌ Missing allocationBreakdown`);
            }
            
            if (firstScope.rawEmissions) {
              console.log(`     ✅ Already has rawEmissions`);
            } else {
              console.log(`     ❌ Missing rawEmissions`);
            }
          }
        } else {
          console.log(`     ❌ No byScopeIdentifier field`);
        }
      } else {
        console.log(`  ❌ No processEmissionSummary field`);
      }
      
      // Check for emissionSummary (alternative field name)
      if (doc.emissionSummary) {
        console.log(`  ℹ️  Has emissionSummary (not processEmissionSummary)`);
      }
    });

    // 4. Check what needs migration
    console.log('\n📊 Migration Analysis:');
    console.log('─'.repeat(80));

    // Find documents that have processEmissionSummary but no allocation breakdown
    const needsMigration = await collection.aggregate([
      {
        $match: {
          processEmissionSummary: { $exists: true, $ne: null }
        }
      },
      {
        $project: {
          _id: 1,
          clientId: 1,
          'period.type': 1,
          'period.year': 1,
          'period.month': 1,
          hasByScopeIdentifier: {
            $cond: {
              if: { $ifNull: ['$processEmissionSummary.byScopeIdentifier', false] },
              then: true,
              else: false
            }
          }
        }
      }
    ]).toArray();

    console.log(`\nDocuments with processEmissionSummary: ${needsMigration.length}`);
    console.log(`Documents with byScopeIdentifier: ${needsMigration.filter(d => d.hasByScopeIdentifier).length}`);

    if (needsMigration.length > 0) {
      console.log('\n📋 First 5 documents that might need migration:');
      needsMigration.slice(0, 5).forEach(doc => {
        console.log(`  - ${doc._id} (${doc.clientId}, ${doc.period?.type} ${doc.period?.year})`);
      });
    }

    // 5. Provide recommendation
    console.log('\n💡 Recommendation:');
    console.log('─'.repeat(80));

    if (withProcessEmissionSummaryByScopeId === 0 && withProcessEmissionSummary > 0) {
      console.log('⚠️  Documents have processEmissionSummary but no byScopeIdentifier');
      console.log('   The migration query should be updated to:');
      console.log('   { processEmissionSummary: { $exists: true, $ne: null } }');
    } else if (withProcessEmissionSummaryByScopeId > 0) {
      console.log(`✅ Found ${withProcessEmissionSummaryByScopeId} documents with byScopeIdentifier`);
      console.log('   Migration script should work with these documents');
      
      // Check if any already have allocation breakdown
      const sampleWithByScopeId = await collection.findOne({
        'processEmissionSummary.byScopeIdentifier': { $exists: true }
      });
      
      if (sampleWithByScopeId) {
        const firstScopeId = Object.keys(sampleWithByScopeId.processEmissionSummary.byScopeIdentifier)[0];
        const firstScope = sampleWithByScopeId.processEmissionSummary.byScopeIdentifier[firstScopeId];
        
        if (firstScope.allocationBreakdown) {
          console.log('   ℹ️  Some documents already have allocationBreakdown');
          console.log('   Migration will skip these documents');
        } else {
          console.log('   ✅ Documents need migration - ready to proceed');
        }
      }
    } else {
      console.log('❌ No documents found with processEmissionSummary structure');
      console.log('   Options:');
      console.log('   1. processEmissionSummary might be calculated on-demand');
      console.log('   2. Field might have a different name');
      console.log('   3. Need to calculate summaries first');
    }

    console.log('\n✅ Diagnostic complete\n');

  } catch (error) {
    console.error('\n❌ Error during diagnosis:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB\n');
  }
}

if (require.main === module) {
  diagnose()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

module.exports = { diagnose };