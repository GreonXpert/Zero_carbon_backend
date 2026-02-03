// ============================================================================
// VERIFICATION SCRIPT: Allocation Percentage Feature
// ============================================================================
// 
// This script verifies allocation percentages in ProcessFlowchart documents
// and optionally fixes invalid allocations.
//
// USAGE:
//   node migration/verifyAllocations.js
//
// OPTIONS:
//   --client=ID    : Verify specific client only
//   --fix          : Automatically fix invalid allocations (equal distribution)
//   --fix-strategy : Strategy: 'equal' (default), 'first-100', 'proportional'
//   --verbose      : Show detailed logging
//   --json         : Output results as JSON
//
// ============================================================================

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const ProcessFlowchart = require('../models/Organization/ProcessFlowchart');

const CONFIG = {
  client: process.argv.find(arg => arg.startsWith('--client='))?.split('=')[1],
  fix: process.argv.includes('--fix'),
  fixStrategy: process.argv.find(arg => arg.startsWith('--fix-strategy='))?.split('=')[1] || 'equal',
  verbose: process.argv.includes('--verbose'),
  json: process.argv.includes('--json')
};

const RESULTS = {
  totalFlowcharts: 0,
  flowchartsWithSharedScopes: 0,
  totalSharedScopes: 0,
  validAllocations: 0,
  invalidAllocations: 0,
  fixedAllocations: 0,
  scopesMissingAllocation: 0,
  details: []
};

function getEffectiveAllocationPct(scopeDetail) {
  if (scopeDetail.allocationPct !== undefined && scopeDetail.allocationPct !== null) {
    return scopeDetail.allocationPct;
  }
  return 100;
}

function buildAllocationIndex(nodes) {
  const index = new Map();
  
  for (const node of nodes) {
    if (node.isDeleted) continue;
    
    const nodeId = node.id;
    const nodeLabel = node.label || node.details?.nodeType || nodeId;
    const scopeDetails = node.details?.scopeDetails || [];
    
    for (const scope of scopeDetails) {
      if (scope.isDeleted || scope.fromOtherChart) continue;
      
      const sid = scope.scopeIdentifier;
      if (!sid) continue;
      
      const hasPct = scope.allocationPct !== undefined && scope.allocationPct !== null;
      
      if (!index.has(sid)) {
        index.set(sid, []);
      }
      
      index.get(sid).push({
        nodeId,
        nodeLabel,
        allocationPct: getEffectiveAllocationPct(scope),
        hasExplicitPct: hasPct,
        scopeType: scope.scopeType,
        categoryName: scope.categoryName
      });
    }
  }
  
  return index;
}

function validateFlowchart(flowchart) {
  const allocationIndex = buildAllocationIndex(flowchart.nodes);
  const result = {
    clientId: flowchart.clientId,
    totalScopes: allocationIndex.size,
    sharedScopes: [],
    uniqueScopes: 0,
    isValid: true,
    scopesMissingAllocation: 0
  };
  
  for (const [scopeId, entries] of allocationIndex) {
    const missingPct = entries.filter(e => !e.hasExplicitPct);
    if (missingPct.length > 0) {
      result.scopesMissingAllocation += missingPct.length;
    }
    
    if (entries.length === 1) {
      result.uniqueScopes++;
      continue;
    }
    
    const totalPct = entries.reduce((sum, e) => sum + e.allocationPct, 0);
    const isValid = Math.abs(totalPct - 100) <= 0.01;
    
    if (!isValid) {
      result.isValid = false;
    }
    
    result.sharedScopes.push({
      scopeIdentifier: scopeId,
      nodeCount: entries.length,
      totalAllocation: totalPct,
      isValid,
      entries: entries.map(e => ({
        nodeId: e.nodeId,
        nodeLabel: e.nodeLabel,
        allocationPct: e.allocationPct,
        hasExplicitPct: e.hasExplicitPct
      }))
    });
  }
  
  return result;
}

function fixAllocations(flowchart, strategy = 'equal') {
  const allocationIndex = buildAllocationIndex(flowchart.nodes);
  let fixed = 0;
  
  for (const [scopeId, entries] of allocationIndex) {
    if (entries.length <= 1) continue;
    
    const totalPct = entries.reduce((sum, e) => sum + e.allocationPct, 0);
    const isValid = Math.abs(totalPct - 100) <= 0.01;
    
    if (isValid) continue;
    
    let newAllocations;
    
    switch (strategy) {
      case 'first-100':
        newAllocations = entries.map((e, i) => ({
          nodeId: e.nodeId,
          allocationPct: i === 0 ? 100 : 0
        }));
        break;
        
      case 'proportional':
        const factor = 100 / totalPct;
        newAllocations = entries.map(e => ({
          nodeId: e.nodeId,
          allocationPct: Math.round(e.allocationPct * factor * 100) / 100
        }));
        const adjustedSum = newAllocations.reduce((s, a) => s + a.allocationPct, 0);
        newAllocations[newAllocations.length - 1].allocationPct += 100 - adjustedSum;
        break;
        
      case 'equal':
      default:
        const equalPct = Math.round((100 / entries.length) * 100) / 100;
        newAllocations = entries.map((e, i) => ({
          nodeId: e.nodeId,
          allocationPct: i === entries.length - 1 
            ? 100 - (equalPct * (entries.length - 1))
            : equalPct
        }));
        break;
    }
    
    for (const alloc of newAllocations) {
      for (const node of flowchart.nodes) {
        if (node.id !== alloc.nodeId) continue;
        if (!node.details?.scopeDetails) continue;
        
        const scope = node.details.scopeDetails.find(s => s.scopeIdentifier === scopeId);
        if (scope) {
          scope.allocationPct = alloc.allocationPct;
        }
      }
    }
    
    fixed++;
  }
  
  return fixed;
}

function printResults() {
  if (CONFIG.json) {
    console.log(JSON.stringify(RESULTS, null, 2));
    return;
  }
  
  console.log('\n' + '='.repeat(70));
  console.log('📋 ALLOCATION VERIFICATION REPORT');
  console.log('='.repeat(70));
  
  console.log(`\n📊 Summary:`);
  console.log(`   Total Flowcharts: ${RESULTS.totalFlowcharts}`);
  console.log(`   Flowcharts with Shared Scopes: ${RESULTS.flowchartsWithSharedScopes}`);
  console.log(`   Total Shared Scopes: ${RESULTS.totalSharedScopes}`);
  console.log(`   Valid Allocations: ${RESULTS.validAllocations}`);
  console.log(`   Invalid Allocations: ${RESULTS.invalidAllocations}`);
  console.log(`   Scopes Missing allocationPct: ${RESULTS.scopesMissingAllocation}`);
  
  if (CONFIG.fix) {
    console.log(`   Fixed Allocations: ${RESULTS.fixedAllocations}`);
  }
  
  const invalidFlowcharts = RESULTS.details.filter(d => !d.isValid);
  
  if (invalidFlowcharts.length > 0) {
    console.log('\n❌ INVALID ALLOCATIONS:');
    console.log('-'.repeat(50));
    
    for (const fc of invalidFlowcharts) {
      console.log(`\n   Client: ${fc.clientId}`);
      
      const invalidScopes = fc.sharedScopes.filter(s => !s.isValid);
      for (const scope of invalidScopes) {
        console.log(`   ❌ ${scope.scopeIdentifier}: sum=${scope.totalAllocation}% (expected 100%)`);
        for (const entry of scope.entries) {
          console.log(`      - ${entry.nodeLabel} (${entry.nodeId}): ${entry.allocationPct}%`);
        }
      }
    }
  } else {
    console.log('\n✅ All allocations are valid!');
  }
  
  if (RESULTS.totalSharedScopes > 0 && CONFIG.verbose) {
    console.log('\n📊 SHARED SCOPES SUMMARY:');
    console.log('-'.repeat(50));
    
    for (const fc of RESULTS.details) {
      if (fc.sharedScopes.length === 0) continue;
      
      console.log(`\n   Client: ${fc.clientId}`);
      for (const scope of fc.sharedScopes) {
        const status = scope.isValid ? '✅' : '❌';
        console.log(`   ${status} ${scope.scopeIdentifier}: ${scope.nodeCount} nodes, sum=${scope.totalAllocation}%`);
      }
    }
  }
}

async function main() {
  if (!CONFIG.json) {
    console.log('╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║       ALLOCATION VERIFICATION SCRIPT                                 ║');
    console.log('╚══════════════════════════════════════════════════════════════════════╝');
    
    console.log('\n📋 Configuration:');
    console.log(`   Client Filter: ${CONFIG.client || 'All'}`);
    console.log(`   Fix Mode: ${CONFIG.fix}`);
    console.log(`   Fix Strategy: ${CONFIG.fixStrategy}`);
    console.log(`   Verbose: ${CONFIG.verbose}`);
  }
  
  try {
    if (!CONFIG.json) console.log('\n🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    if (!CONFIG.json) console.log('✅ Connected to MongoDB');
  } catch (err) {
    console.error('❌ Failed to connect to MongoDB:', err.message);
    process.exit(1);
  }
  
  try {
    const query = { isDeleted: { $ne: true } };
    if (CONFIG.client) {
      query.clientId = CONFIG.client;
    }
    
    const flowcharts = await ProcessFlowchart.find(query);
    RESULTS.totalFlowcharts = flowcharts.length;
    
    if (!CONFIG.json) {
      console.log(`\n📊 Found ${flowcharts.length} ProcessFlowchart documents`);
    }
    
    for (const flowchart of flowcharts) {
      const validation = validateFlowchart(flowchart);
      
      RESULTS.scopesMissingAllocation += validation.scopesMissingAllocation;
      
      if (validation.sharedScopes.length > 0) {
        RESULTS.flowchartsWithSharedScopes++;
        RESULTS.totalSharedScopes += validation.sharedScopes.length;
        
        for (const scope of validation.sharedScopes) {
          if (scope.isValid) {
            RESULTS.validAllocations++;
          } else {
            RESULTS.invalidAllocations++;
          }
        }
      }
      
      if (CONFIG.fix && !validation.isValid) {
        const fixed = fixAllocations(flowchart, CONFIG.fixStrategy);
        if (fixed > 0) {
          flowchart.markModified('nodes');
          await flowchart.save();
          RESULTS.fixedAllocations += fixed;
          
          const revalidation = validateFlowchart(flowchart);
          validation.sharedScopes = revalidation.sharedScopes;
          validation.isValid = revalidation.isValid;
        }
      }
      
      RESULTS.details.push(validation);
    }
    
    printResults();
    
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await mongoose.disconnect();
    if (!CONFIG.json) console.log('\n🔌 Disconnected from MongoDB');
  }
}

main().catch(console.error);