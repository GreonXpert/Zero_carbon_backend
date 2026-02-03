// ============================================================================
// MIGRATION SCRIPT: Allocation Percentage Feature (CRITICAL FIX)
// ============================================================================
// 
// 🔧 CRITICAL FIX: Use .lean() to bypass Mongoose defaults
// 
// The issue was that Mongoose applies schema defaults to in-memory documents,
// making the migration think allocationPct already exists when it doesn't!
//
// Solution: Load documents with .lean() to get raw database data without defaults
//
// ============================================================================

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const ProcessFlowchart = require('../models/Organization/ProcessFlowchart');
const EmissionSummary = require('../models/CalculationEmission/EmissionSummary');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  dryRun: process.argv.includes('--dry-run'),
  client: process.argv.find(arg => arg.startsWith('--client='))?.split('=')[1],
  skipFlowchart: process.argv.includes('--skip-flowchart'),
  skipSummary: process.argv.includes('--skip-summary'),
  autoDistribute: process.argv.includes('--auto-distribute'),
  limit: parseInt(process.argv.find(arg => arg.startsWith('--limit='))?.split('=')[1] || '0'),
  verbose: process.argv.includes('--verbose'),
  batchSize: 50
};

const STATS = {
  flowchart: {
    total: 0,
    processed: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    scopesUpdated: 0,
    scopesSkipped: 0,
    sharedScopesFound: 0,
    autoDistributed: 0
  },
  summary: {
    total: 0,
    processed: 0,
    updated: 0,
    skipped: 0,
    errors: 0
  },
  sharedScopes: [],
  startTime: null,
  endTime: null
};

// ============================================================================
// CHECKPOINT SYSTEM
// ============================================================================

const CHECKPOINT_FILE = path.join(__dirname, '.allocation_migration_checkpoint.json');
const fs = require('fs');

function saveCheckpoint(phase, lastProcessedId) {
  const checkpoint = {
    phase,
    lastProcessedId: lastProcessedId?.toString(),
    timestamp: new Date().toISOString(),
    stats: STATS
  };
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
  if (CONFIG.verbose) {
    console.log(`📍 Checkpoint saved: ${phase} - ${lastProcessedId}`);
  }
}

function loadCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      const data = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
      console.log(`📍 Found checkpoint from ${data.timestamp}`);
      console.log(`   Phase: ${data.phase}, Last ID: ${data.lastProcessedId}`);
      return data;
    }
  } catch (err) {
    console.warn('⚠️ Could not load checkpoint:', err.message);
  }
  return null;
}

function clearCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      fs.unlinkSync(CHECKPOINT_FILE);
      console.log('🗑️ Checkpoint cleared');
    }
  } catch (err) {
    console.warn('⚠️ Could not clear checkpoint:', err.message);
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

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
      if (scope.isDeleted) continue;
      if (scope.fromOtherChart) continue;
      
      const sid = scope.scopeIdentifier;
      if (!sid) continue;
      
      if (!index.has(sid)) {
        index.set(sid, []);
      }
      
      index.get(sid).push({
        nodeId,
        nodeLabel,
        allocationPct: getEffectiveAllocationPct(scope),
        scopeType: scope.scopeType,
        categoryName: scope.categoryName
      });
    }
  }
  
  return index;
}

function findSharedScopes(allocationIndex) {
  const shared = [];
  
  for (const [scopeId, entries] of allocationIndex) {
    if (entries.length > 1) {
      const totalPct = entries.reduce((sum, e) => sum + e.allocationPct, 0);
      shared.push({
        scopeIdentifier: scopeId,
        nodeCount: entries.length,
        totalAllocation: totalPct,
        isValid: Math.abs(totalPct - 100) <= 0.01,
        entries
      });
    }
  }
  
  return shared;
}

/**
 * 🔧 CRITICAL FIX: This function now works on PLAIN objects (from .lean())
 * No Mongoose defaults are applied, so we see the TRUE database state
 */
function updateFlowchartAllocations(plainFlowchart, autoDistribute = false) {
  let scopesUpdated = 0;
  let scopesSkipped = 0;
  let autoDistributed = 0;
  let modified = false;
  
  const nodes = plainFlowchart.nodes || [];
  
  // First pass: Add allocationPct to all valid scopes that don't have it
  for (const node of nodes) {
    if (node.isDeleted) continue;
    if (!node.details?.scopeDetails) continue;
    
    for (const scope of node.details.scopeDetails) {
      if (scope.isDeleted) {
        scopesSkipped++;
        if (CONFIG.verbose) {
          console.log(`   ⏭️ Skipped deleted scope: ${scope.scopeIdentifier || 'unknown'}`);
        }
        continue;
      }
      
      if (!scope.scopeIdentifier) {
        scopesSkipped++;
        if (CONFIG.verbose) {
          console.log(`   ⏭️ Skipped scope without identifier in node ${node.id}`);
        }
        continue;
      }
      
      // 🔧 CRITICAL: Check if field EXISTS in database (plain object check)
      if (scope.allocationPct === undefined || scope.allocationPct === null) {
        scope.allocationPct = 100;
        scopesUpdated++;
        modified = true;
        
        if (CONFIG.verbose) {
          console.log(`   ✅ Added allocationPct: 100 to ${scope.scopeIdentifier} (fromOtherChart: ${scope.fromOtherChart || false})`);
        }
      } else {
        if (CONFIG.verbose) {
          console.log(`   ℹ️ Already has allocationPct: ${scope.allocationPct} for ${scope.scopeIdentifier}`);
        }
      }
    }
  }
  
  // Second pass: Auto-distribute if enabled
  if (autoDistribute && modified) {
    const allocationIndex = buildAllocationIndex(nodes);
    const sharedScopes = findSharedScopes(allocationIndex);
    
    for (const shared of sharedScopes) {
      const allDefault = shared.entries.every(e => e.allocationPct === 100);
      
      if (allDefault && shared.nodeCount > 1) {
        const equalPct = Math.round((100 / shared.nodeCount) * 100) / 100;
        const remainder = 100 - (equalPct * shared.nodeCount);
        
        let distributed = 0;
        for (const entry of shared.entries) {
          for (const node of nodes) {
            if (node.id !== entry.nodeId) continue;
            if (!node.details?.scopeDetails) continue;
            
            const scope = node.details.scopeDetails.find(
              s => s.scopeIdentifier === shared.scopeIdentifier && !s.isDeleted
            );
            
            if (scope) {
              if (distributed === shared.nodeCount - 1) {
                scope.allocationPct = equalPct + remainder;
              } else {
                scope.allocationPct = equalPct;
              }
              distributed++;
              modified = true;
              
              if (CONFIG.verbose) {
                console.log(`   🔄 Auto-distributed ${scope.allocationPct}% to ${entry.nodeLabel} for ${shared.scopeIdentifier}`);
              }
            }
          }
        }
        
        if (distributed > 0) {
          autoDistributed++;
        }
      }
    }
  }
  
  return { updated: modified, scopesUpdated, scopesSkipped, autoDistributed };
}

function logProgress(current, total, prefix = '') {
  const pct = ((current / total) * 100).toFixed(1);
  process.stdout.write(`\r${prefix}Progress: ${current}/${total} (${pct}%)`);
}

// ============================================================================
// PHASE 1: MIGRATE PROCESS FLOWCHARTS
// ============================================================================

async function migrateProcessFlowcharts(resumeFromId = null) {
  console.log('\n' + '='.repeat(70));
  console.log('📋 PHASE 1: Migrating ProcessFlowchart Documents');
  console.log('='.repeat(70));
  
  const query = { isDeleted: { $ne: true } };
  
  if (CONFIG.client) {
    query.clientId = CONFIG.client;
    console.log(`🔍 Filtering by clientId: ${CONFIG.client}`);
  }
  
  if (resumeFromId) {
    query._id = { $gt: new mongoose.Types.ObjectId(resumeFromId) };
    console.log(`📍 Resuming from ID: ${resumeFromId}`);
  }
  
  STATS.flowchart.total = await ProcessFlowchart.countDocuments(query);
  console.log(`📊 Total documents to process: ${STATS.flowchart.total}`);
  
  if (STATS.flowchart.total === 0) {
    console.log('✅ No ProcessFlowchart documents to migrate');
    return;
  }
  
  let lastId = resumeFromId ? new mongoose.Types.ObjectId(resumeFromId) : null;
  let processed = 0;
  const limit = CONFIG.limit || Infinity;
  
  while (processed < STATS.flowchart.total && processed < limit) {
    const batchQuery = { ...query };
    if (lastId) {
      batchQuery._id = { $gt: lastId };
    }
    
    // 🔧 CRITICAL FIX: Use .lean() to get raw database data WITHOUT Mongoose defaults
    const plainBatch = await ProcessFlowchart.find(batchQuery)
      .sort({ _id: 1 })
      .limit(CONFIG.batchSize)
      .lean();  // ← THIS IS THE FIX!
    
    if (plainBatch.length === 0) break;
    
    for (const plainFlowchart of plainBatch) {
      try {
        STATS.flowchart.processed++;
        processed++;
        
        if (CONFIG.verbose) {
          console.log(`\n\n📄 Processing: ${plainFlowchart.clientId} (${plainFlowchart._id})`);
        }
        
        // Work on plain object
        const result = updateFlowchartAllocations(plainFlowchart, CONFIG.autoDistribute);
        
        if (!result.updated) {
          STATS.flowchart.skipped++;
          if (CONFIG.verbose) {
            console.log(`   ⏭️ Skipped ${plainFlowchart.clientId} (no changes needed)`);
          }
          lastId = plainFlowchart._id;
          logProgress(processed, Math.min(STATS.flowchart.total, limit), '📋 Flowchart ');
          continue;
        }
        
        STATS.flowchart.scopesUpdated += result.scopesUpdated;
        STATS.flowchart.scopesSkipped += result.scopesSkipped;
        STATS.flowchart.autoDistributed += result.autoDistributed;
        
        // Find shared scopes for reporting
        const allocationIndex = buildAllocationIndex(plainFlowchart.nodes);
        const sharedScopes = findSharedScopes(allocationIndex);
        
        if (sharedScopes.length > 0) {
          STATS.flowchart.sharedScopesFound += sharedScopes.length;
          STATS.sharedScopes.push({
            clientId: plainFlowchart.clientId,
            sharedScopes: sharedScopes.map(s => ({
              scopeIdentifier: s.scopeIdentifier,
              nodeCount: s.nodeCount,
              totalAllocation: s.totalAllocation,
              isValid: s.isValid
            }))
          });
        }
        
        // Save if not dry run
        if (!CONFIG.dryRun) {
          // 🔧 Load as Mongoose document for saving
          const mongooseDoc = await ProcessFlowchart.findById(plainFlowchart._id);
          
          // Apply changes from plain object to Mongoose document
          mongooseDoc.nodes = plainFlowchart.nodes;
          mongooseDoc.markModified('nodes');
          
          await mongooseDoc.save();
          STATS.flowchart.updated++;
          
          if (CONFIG.verbose) {
            console.log(`   ✅ Saved changes to database`);
          }
        } else {
          STATS.flowchart.updated++;
          if (CONFIG.verbose) {
            console.log(`   🔍 [DRY-RUN] Would save changes`);
          }
        }
        
        if (CONFIG.verbose) {
          console.log(`   📊 Summary: ${result.scopesUpdated} updated, ${result.scopesSkipped} skipped, ${sharedScopes.length} shared scopes`);
        }
        
        lastId = plainFlowchart._id;
        
      } catch (err) {
        STATS.flowchart.errors++;
        console.error(`\n❌ Error processing ${plainFlowchart?.clientId}:`, err.message);
        if (CONFIG.verbose) {
          console.error(err.stack);
        }
      }
      
      logProgress(processed, Math.min(STATS.flowchart.total, limit), '📋 Flowchart ');
    }
    
    saveCheckpoint('flowchart', lastId);
  }
  
  console.log('\n');
}

// ============================================================================
// PHASE 2: SKIP SUMMARY RECALCULATION (Can be done separately)
// ============================================================================

async function recalculateEmissionSummaries(resumeFromId = null) {
  console.log('\n' + '='.repeat(70));
  console.log('📊 PHASE 2: Skipping EmissionSummary Recalculation');
  console.log('='.repeat(70));
  console.log('ℹ️ Run this separately after flowchart migration completes');
  console.log('ℹ️ Use --skip-summary flag to skip this phase\n');
  return;
}

// ============================================================================
// REPORT GENERATION
// ============================================================================

function generateReport() {
  console.log('\n' + '='.repeat(70));
  console.log('📋 MIGRATION REPORT');
  console.log('='.repeat(70));
  
  const duration = ((STATS.endTime - STATS.startTime) / 1000).toFixed(2);
  
  console.log(`\n⏱️ Duration: ${duration} seconds`);
  console.log(`🏃 Mode: ${CONFIG.dryRun ? 'DRY RUN (no changes made)' : 'LIVE'}`);
  
  if (!CONFIG.skipFlowchart) {
    console.log('\n📋 ProcessFlowchart Migration:');
    console.log(`   Total: ${STATS.flowchart.total}`);
    console.log(`   Processed: ${STATS.flowchart.processed}`);
    console.log(`   Updated: ${STATS.flowchart.updated}`);
    console.log(`   Skipped: ${STATS.flowchart.skipped}`);
    console.log(`   Errors: ${STATS.flowchart.errors}`);
    console.log(`   Scopes Updated: ${STATS.flowchart.scopesUpdated}`);
    console.log(`   Scopes Skipped: ${STATS.flowchart.scopesSkipped}`);
    console.log(`   Shared Scopes Found: ${STATS.flowchart.sharedScopesFound}`);
    
    if (CONFIG.autoDistribute) {
      console.log(`   Auto-Distributed: ${STATS.flowchart.autoDistributed}`);
    }
  }
  
  if (STATS.sharedScopes.length > 0) {
    console.log('\n⚠️ SHARED SCOPES DETECTED:');
    console.log('   These scopeIdentifiers appear in multiple nodes.');
    console.log('   Review and set appropriate allocation percentages.');
    console.log('-'.repeat(50));
    
    for (const client of STATS.sharedScopes.slice(0, 10)) {
      console.log(`\n   Client: ${client.clientId}`);
      for (const scope of client.sharedScopes) {
        const status = scope.isValid ? '✅' : '❌';
        console.log(`   ${status} ${scope.scopeIdentifier}: ${scope.nodeCount} nodes, sum=${scope.totalAllocation}%`);
      }
    }
    
    if (STATS.sharedScopes.length > 10) {
      console.log(`\n   ... and ${STATS.sharedScopes.length - 10} more clients with shared scopes`);
    }
  }
  
  const reportFile = path.join(__dirname, `allocation_migration_report_${Date.now()}.json`);
  const report = {
    timestamp: new Date().toISOString(),
    config: CONFIG,
    stats: STATS,
    sharedScopes: STATS.sharedScopes
  };
  
  try {
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    console.log(`\n📄 Detailed report saved to: ${reportFile}`);
  } catch (err) {
    console.warn(`\n⚠️ Could not save report: ${err.message}`);
  }
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║     ALLOCATION MIGRATION SCRIPT (CRITICAL FIX - .lean())             ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  
  console.log('\n📋 Configuration:');
  console.log(`   Dry Run: ${CONFIG.dryRun}`);
  console.log(`   Client Filter: ${CONFIG.client || 'All'}`);
  console.log(`   Skip Flowchart: ${CONFIG.skipFlowchart}`);
  console.log(`   Skip Summary: ${CONFIG.skipSummary}`);
  console.log(`   Auto-Distribute: ${CONFIG.autoDistribute}`);
  console.log(`   Limit: ${CONFIG.limit || 'None'}`);
  console.log(`   Verbose: ${CONFIG.verbose}`);
  
  try {
    console.log('\n🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('✅ Connected to MongoDB');
  } catch (err) {
    console.error('❌ Failed to connect to MongoDB:', err.message);
    process.exit(1);
  }
  
  STATS.startTime = Date.now();
  
  const checkpoint = loadCheckpoint();
  let flowchartResumeId = null;
  
  if (checkpoint && !CONFIG.dryRun) {
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    const resume = await new Promise((resolve) => {
      rl.question('Resume from checkpoint? (y/n): ', (answer) => {
        rl.close();
        resolve(answer.toLowerCase() === 'y');
      });
    });
    
    if (resume) {
      if (checkpoint.phase === 'flowchart') {
        flowchartResumeId = checkpoint.lastProcessedId;
      }
      Object.assign(STATS.flowchart, checkpoint.stats?.flowchart || {});
    } else {
      clearCheckpoint();
    }
  }
  
  try {
    if (!CONFIG.skipFlowchart) {
      await migrateProcessFlowcharts(flowchartResumeId);
    }
    
    if (!CONFIG.skipSummary) {
      await recalculateEmissionSummaries();
    }
    
    STATS.endTime = Date.now();
    
    generateReport();
    
    if (!CONFIG.dryRun) {
      clearCheckpoint();
    }
    
    console.log('\n✅ Migration completed successfully!');
    
    if (CONFIG.dryRun) {
      console.log('\n⚠️ This was a DRY RUN - no changes were made to the database');
      console.log('   Run without --dry-run to apply changes');
    }
    
  } catch (err) {
    console.error('\n❌ Migration failed:', err);
    console.error(err.stack);
    console.log('💡 You can resume from the last checkpoint by running the script again.');
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
}

main().catch(console.error);