// migrations/add-apiKeyRequest-field.js
// Run this to add apiKeyRequest field to all existing documents

const mongoose = require('mongoose');
const Reduction = require('../models/Reduction/Reduction');
const Flowchart = require('../models/Organization/Flowchart');
const ProcessFlowchart = require('../models/Organization/ProcessFlowchart');

/**
 * Migration to add apiKeyRequest field to existing documents
 * This ensures backward compatibility with existing data
 */
async function migrate() {
  console.log('===============================================');
  console.log('Starting migration: add apiKeyRequest field...');
  console.log('===============================================\n');

  let totalUpdated = 0;

  // =====================================================
  // 1. Update all Reduction documents
  // =====================================================
  console.log('1️⃣  Processing Reduction documents...');
  const reductions = await Reduction.find({});
  let reductionUpdated = 0;

  for (const reduction of reductions) {
    if (!reduction.reductionDataEntry) {
      console.log(`  ⚠️  Skipping ${reduction.projectId} - no reductionDataEntry`);
      continue;
    }

    if (reduction.reductionDataEntry.apiKeyRequest) {
      console.log(`  ⏭️  Skipping ${reduction.projectId} - already has apiKeyRequest`);
      continue; // Already has it
    }

    reduction.reductionDataEntry.apiKeyRequest = {
      status: 'none',
      requestedInputType: null,
      requestedAt: null,
      approvedAt: null,
      rejectedAt: null,
      apiKeyId: null,
      requestId: null
    };

    reduction.markModified('reductionDataEntry');
    await reduction.save();
    reductionUpdated++;
    console.log(`  ✅ Updated ${reduction.projectId}`);
  }

  console.log(`\n✅ Updated ${reductionUpdated} / ${reductions.length} Reduction documents\n`);
  totalUpdated += reductionUpdated;

  // =====================================================
  // 2. Update all Flowchart scopes
  // =====================================================
  console.log('2️⃣  Processing Flowchart documents...');
  const flowcharts = await Flowchart.find({});
  let scopeCount = 0;
  let flowchartCount = 0;

  for (const flowchart of flowcharts) {
    let modified = false;
    let scopesInThisChart = 0;

    for (const node of flowchart.nodes || []) {
      for (const scope of node.details?.scopeDetails || []) {
        if (scope.apiKeyRequest) {
          continue; // Already has it
        }

        scope.apiKeyRequest = {
          status: 'none',
          requestedInputType: null,
          requestedAt: null,
          approvedAt: null,
          rejectedAt: null,
          apiKeyId: null,
          requestId: null
        };

        scopeCount++;
        scopesInThisChart++;
        modified = true;
      }
    }

    if (modified) {
      flowchart.markModified('nodes');
      await flowchart.save();
      flowchartCount++;
      console.log(`  ✅ Updated ${scopesInThisChart} scopes in flowchart ${flowchart.clientId}`);
    } else {
      console.log(`  ⏭️  Skipping flowchart ${flowchart.clientId} - all scopes already have apiKeyRequest`);
    }
  }

  console.log(`\n✅ Updated ${scopeCount} scopes across ${flowchartCount} Flowchart documents\n`);
  totalUpdated += scopeCount;

  // =====================================================
  // 3. Update all ProcessFlowchart scopes
  // =====================================================
  console.log('3️⃣  Processing ProcessFlowchart documents...');
  const processFlows = await ProcessFlowchart.find({});
  let pScopeCount = 0;
  let processFlowCount = 0;

  for (const processFlow of processFlows) {
    let modified = false;
    let scopesInThisChart = 0;

    for (const node of processFlow.nodes || []) {
      for (const scope of node.scopeDetails || []) {
        if (scope.apiKeyRequest) {
          continue; // Already has it
        }

        scope.apiKeyRequest = {
          status: 'none',
          requestedInputType: null,
          requestedAt: null,
          approvedAt: null,
          rejectedAt: null,
          apiKeyId: null,
          requestId: null
        };

        pScopeCount++;
        scopesInThisChart++;
        modified = true;
      }
    }

    if (modified) {
      processFlow.markModified('nodes');
      await processFlow.save();
      processFlowCount++;
      console.log(`  ✅ Updated ${scopesInThisChart} scopes in processflow ${processFlow.clientId}`);
    } else {
      console.log(`  ⏭️  Skipping processflow ${processFlow.clientId} - all scopes already have apiKeyRequest`);
    }
  }

  console.log(`\n✅ Updated ${pScopeCount} scopes across ${processFlowCount} ProcessFlowchart documents\n`);
  totalUpdated += pScopeCount;

  // =====================================================
  // Summary
  // =====================================================
  console.log('===============================================');
  console.log('✅ Migration Complete!');
  console.log('===============================================');
  console.log(`Total documents updated: ${totalUpdated}`);
  console.log(`  - Reductions: ${reductionUpdated}`);
  console.log(`  - Flowchart scopes: ${scopeCount}`);
  console.log(`  - ProcessFlowchart scopes: ${pScopeCount}`);
  console.log('===============================================\n');
}

/**
 * Verify migration results
 */
async function verify() {
  console.log('\n===============================================');
  console.log('Verifying migration results...');
  console.log('===============================================\n');

  // Check Reductions
  const reductions = await Reduction.find({});
  const reductionsWithField = reductions.filter(r => 
    r.reductionDataEntry && r.reductionDataEntry.apiKeyRequest
  );
  console.log(`Reductions with apiKeyRequest: ${reductionsWithField.length} / ${reductions.length}`);

  // Check Flowcharts
  const flowcharts = await Flowchart.find({});
  let flowchartScopes = 0;
  let flowchartScopesWithField = 0;
  flowcharts.forEach(fc => {
    fc.nodes?.forEach(node => {
      node.details?.scopeDetails?.forEach(scope => {
        flowchartScopes++;
        if (scope.apiKeyRequest) flowchartScopesWithField++;
      });
    });
  });
  console.log(`Flowchart scopes with apiKeyRequest: ${flowchartScopesWithField} / ${flowchartScopes}`);

  // Check ProcessFlowcharts
  const processFlows = await ProcessFlowchart.find({});
  let processScopes = 0;
  let processScopesWithField = 0;
  processFlows.forEach(pf => {
    pf.nodes?.forEach(node => {
      node.scopeDetails?.forEach(scope => {
        processScopes++;
        if (scope.apiKeyRequest) processScopesWithField++;
      });
    });
  });
  console.log(`ProcessFlowchart scopes with apiKeyRequest: ${processScopesWithField} / ${processScopes}`);

  console.log('\n✅ Verification complete!\n');
}

// =====================================================
// Run if called directly
// =====================================================
if (require.main === module) {
  // Load environment variables
  require('dotenv').config();

  const dbUri = process.env.MONGO_URI|| process.env.DB_URI;
  
  if (!dbUri) {
    console.error('❌ Error: MONGODB_URI not found in environment variables');
    process.exit(1);
  }

  console.log('Connecting to MongoDB...');
  mongoose.connect(dbUri, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  }).then(() => {
    console.log('✅ Connected to MongoDB\n');
    
    migrate()
      .then(() => verify())
      .then(() => {
        console.log('✅ All done!');
        process.exit(0);
      })
      .catch(err => {
        console.error('❌ Migration failed:', err);
        process.exit(1);
      });
  }).catch(err => {
    console.error('❌ Database connection failed:', err);
    process.exit(1);
  });
}

module.exports = { migrate, verify };