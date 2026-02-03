/**
 * ============================================================================
 * MIGRATION SCRIPT: Add Allocation Breakdown to EmissionSummary
 * ============================================================================
 * 
 * This script updates existing EmissionSummary documents to include the new
 * allocation breakdown structure in processEmissionSummary.byScopeIdentifier
 * 
 * WHAT IT DOES:
 * 1. Finds all EmissionSummary documents with processEmissionSummary
 * 2. For each document, recalculates processEmissionSummary with allocation breakdown
 * 3. Updates the document with new structure
 * 4. Supports checkpoint/resume for large datasets
 * 
 * CHANGES MADE:
 * - Adds rawEmissions field to each scopeIdentifier
 * - Adds allocationBreakdown with allocated/unallocated emissions
 * - Adds allocation warnings to metadata
 * 
 * SAFE TO RUN MULTIPLE TIMES: Yes (idempotent)
 * 
 * ============================================================================
 */

require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// Models
const EmissionSummary = require('../models/CalculationEmission/EmissionSummary');
const DataEntry = require('../models/Organization/DataEntry');
const ProcessFlowchart = require('../models/Organization/ProcessFlowchart');

// Helper functions
const {
  getEffectiveAllocationPct,
  applyAllocation,
  addEmissionValues,
  ensureMapEntry,
  finalizeAllocationBreakdowns,
  extractEmissionValues
} = require('../utils/allocation/allocationHelpers');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Checkpoint file to track progress
  CHECKPOINT_FILE: 'migration_allocation_checkpoint.json',
  
  // Batch size for processing
  BATCH_SIZE: 50,
  
  // Delay between batches (ms) to avoid overwhelming database
  BATCH_DELAY: 1000,
  
  // Dry run mode - if true, shows what would be done without making changes
  DRY_RUN: process.env.DRY_RUN === 'true' || false,
  
  // Skip clients (comma-separated list)
  SKIP_CLIENTS: (process.env.SKIP_CLIENTS || '').split(',').filter(Boolean),
  
  // Process only specific clients (comma-separated list, empty = all)
  ONLY_CLIENTS: (process.env.ONLY_CLIENTS || '').split(',').filter(Boolean),
  
  // Log level: 'verbose', 'normal', 'quiet'
  LOG_LEVEL: process.env.LOG_LEVEL || 'normal'
};

// ============================================================================
// CHECKPOINT MANAGEMENT
// ============================================================================

class CheckpointManager {
  constructor(filepath) {
    this.filepath = filepath;
    this.data = this.load();
  }
  
  load() {
    try {
      if (fs.existsSync(this.filepath)) {
        const content = fs.readFileSync(this.filepath, 'utf8');
        return JSON.parse(content);
      }
    } catch (error) {
      console.warn('⚠️  Warning: Could not load checkpoint file:', error.message);
    }
    
    return {
      processedIds: [],
      failedIds: [],
      stats: {
        total: 0,
        processed: 0,
        updated: 0,
        skipped: 0,
        failed: 0
      },
      startedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString()
    };
  }
  
  save() {
    try {
      this.data.lastUpdated = new Date().toISOString();
      fs.writeFileSync(this.filepath, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error('❌ Error saving checkpoint:', error.message);
    }
  }
  
  hasProcessed(id) {
    return this.data.processedIds.includes(id.toString());
  }
  
  markProcessed(id, updated = true) {
    const idStr = id.toString();
    if (!this.data.processedIds.includes(idStr)) {
      this.data.processedIds.push(idStr);
      this.data.stats.processed++;
      if (updated) {
        this.data.stats.updated++;
      } else {
        this.data.stats.skipped++;
      }
    }
  }
  
  markFailed(id, error) {
    const idStr = id.toString();
    if (!this.data.failedIds.includes(idStr)) {
      this.data.failedIds.push(idStr);
      this.data.stats.failed++;
    }
  }
  
  getStats() {
    return this.data.stats;
  }
  
  clear() {
    this.data = {
      processedIds: [],
      failedIds: [],
      stats: {
        total: 0,
        processed: 0,
        updated: 0,
        skipped: 0,
        failed: 0
      },
      startedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString()
    };
    this.save();
  }
}

// ============================================================================
// LOGGING
// ============================================================================

const log = {
  verbose: (...args) => {
    if (CONFIG.LOG_LEVEL === 'verbose') {
      console.log(...args);
    }
  },
  normal: (...args) => {
    if (CONFIG.LOG_LEVEL !== 'quiet') {
      console.log(...args);
    }
  },
  always: (...args) => {
    console.log(...args);
  },
  error: (...args) => {
    console.error(...args);
  }
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Build date range for a period
 */
function buildDateRange(periodType, year, month, week, day) {
  let from, to;
  
  if (periodType === 'daily') {
    from = new Date(year, month - 1, day, 0, 0, 0);
    to = new Date(year, month - 1, day, 23, 59, 59, 999);
  } else if (periodType === 'monthly') {
    from = new Date(year, month - 1, 1, 0, 0, 0);
    const lastDay = new Date(year, month, 0).getDate();
    to = new Date(year, month - 1, lastDay, 23, 59, 59, 999);
  } else if (periodType === 'yearly') {
    from = new Date(year, 0, 1, 0, 0, 0);
    to = new Date(year, 11, 31, 23, 59, 59, 999);
  } else if (periodType === 'weekly') {
    // Simplified week calculation
    const firstDayOfYear = new Date(year, 0, 1);
    const daysOffset = (week - 1) * 7;
    from = new Date(firstDayOfYear.getTime() + daysOffset * 24 * 60 * 60 * 1000);
    to = new Date(from.getTime() + 6 * 24 * 60 * 60 * 1000);
    to.setHours(23, 59, 59, 999);
  }
  
  return { from, to };
}

/**
 * Normalize scope identifier
 */
function normalizeScopeIdentifier(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Recalculate processEmissionSummary with allocation breakdown
 */
async function recalculateProcessEmissionSummary(emissionSummary) {
  const { clientId, period } = emissionSummary;
  const { type: periodType, year, month, week, day } = period;
  
  log.verbose(`  🔄 Recalculating for period: ${periodType} ${year}${month ? '-' + month : ''}${day ? '-' + day : ''}`);
  
  try {
    // Load ProcessFlowchart
    const processFlowchart = await ProcessFlowchart.findOne({
      clientId,
      isDeleted: false
    }).lean();
    
    if (!processFlowchart || !Array.isArray(processFlowchart.nodes) || processFlowchart.nodes.length === 0) {
      log.verbose(`  ⚠️  No ProcessFlowchart found for client ${clientId}`);
      return null;
    }
    
    // Build scopeIndex with allocation
    const scopeIndex = new Map();
    
    for (const node of processFlowchart.nodes) {
      const processNodeId = node.id || null;
      const nodeMeta = {
        label: node.label || "Unknown Node",
        department: node.details?.department || "Unknown",
        location: node.details?.location || "Unknown"
      };
      
      const scopeDetails = Array.isArray(node.details?.scopeDetails) ? node.details.scopeDetails : [];
      const validScopes = scopeDetails.filter(s => 
        normalizeScopeIdentifier(s.scopeIdentifier) && 
        s.isDeleted !== true
      );
      
      for (const s of validScopes) {
        const sid = normalizeScopeIdentifier(s.scopeIdentifier);
        const allocationPct = getEffectiveAllocationPct(s);
        
        if (!scopeIndex.has(sid)) scopeIndex.set(sid, []);
        scopeIndex.get(sid).push({
          processNodeId,
          nodeMeta,
          allocationPct,
          scopeMeta: {
            scopeIdentifier: sid,
            scopeType: s.scopeType,
            categoryName: s.categoryName,
            activity: s.activity,
            fromOtherChart: s.fromOtherChart || false
          }
        });
      }
    }
    
    if (scopeIndex.size === 0) {
      log.verbose(`  ⚠️  No valid scopes in ProcessFlowchart`);
      return null;
    }
    
    // Get date range
    const { from, to } = buildDateRange(periodType, year, month, week, day);
    
    // Load DataEntry records
    const dataEntries = await DataEntry.find({
      clientId,
      processingStatus: "processed",
      timestamp: { $gte: from, $lte: to }
    }).lean();
    
    log.verbose(`  📊 Found ${dataEntries.length} data entries`);
    
    // Initialize summary structure
    const processEmissionSummary = {
      period,
      totalEmissions: { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0 },
      byScope: {
        "Scope 1": { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
        "Scope 2": { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
        "Scope 3": { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 }
      },
      byCategory: new Map(),
      byActivity: new Map(),
      byNode: new Map(),
      byScopeIdentifier: new Map(),
      byDepartment: new Map(),
      byLocation: new Map(),
      byInputType: {
        manual: { CO2e: 0, dataPointCount: 0 },
        API: { CO2e: 0, dataPointCount: 0 },
        IOT: { CO2e: 0, dataPointCount: 0 }
      },
      byEmissionFactor: new Map(),
      trends: {},
      metadata: {
        totalDataPoints: 0,
        dataEntriesIncluded: [],
        lastCalculated: new Date(),
        calculatedBy: null,
        version: 1,
        isComplete: true,
        hasErrors: false,
        errors: [],
        calculationDuration: 0,
        allocationApplied: true,
        sharedScopeIdentifiers: 0,
        allocationWarnings: []
      }
    };
    
    // Process data entries
    let includedCount = 0;
    let filteredCount = 0;
    const processedEntryIds = new Set();
    const sharedScopeSet = new Set();
    
    for (const entry of dataEntries) {
      const sid = normalizeScopeIdentifier(entry.scopeIdentifier);
      if (!sid) { filteredCount++; continue; }
      
      const matches = scopeIndex.get(sid);
      if (!matches || matches.length === 0) { filteredCount++; continue; }
      
      // Get RAW emission values
      const rawEmissionValues = extractEmissionValues(entry.calculatedEmissions);
      if (rawEmissionValues.CO2e === 0) continue;
      
      const scopeType = entry.scopeType || matches[0].scopeMeta.scopeType || "Unknown";
      const isSharedScope = matches.length > 1;
      
      if (isSharedScope && !sharedScopeSet.has(sid)) {
        sharedScopeSet.add(sid);
        processEmissionSummary.metadata.sharedScopeIdentifiers++;
      }
      
      // 🆕 ENHANCED: Initialize byScopeIdentifier with rawEmissions tracking
      const scopeIdBucket = ensureMapEntry(processEmissionSummary.byScopeIdentifier, sid, {
        scopeType,
        categoryName: matches[0].scopeMeta.categoryName || "Unknown Category",
        activity: matches[0].scopeMeta.activity || sid,
        isShared: isSharedScope,
        
        // 🆕 NEW: Raw emissions tracking
        rawEmissions: {
          CO2e: 0,
          CO2: 0,
          CH4: 0,
          N2O: 0,
          uncertainty: 0
        },
        
        totalAllocatedPct: 0,
        nodes: new Map(),
        dataPointCount: 0,
        allocationBreakdown: null
      });
      
      // 🆕 ACCUMULATE RAW EMISSIONS
      addEmissionValues(scopeIdBucket.rawEmissions, rawEmissionValues);
      scopeIdBucket.dataPointCount += 1;
      
      // Process each node
      for (const match of matches) {
        const allocationPct = match.allocationPct;
        const emissionValues = applyAllocation(rawEmissionValues, allocationPct);
        
        if (emissionValues.CO2e < 0.0001) continue;
        
        includedCount++;
        
        const categoryName = match.scopeMeta.categoryName || "Unknown Category";
        const activity = match.scopeMeta.activity || sid;
        const processNodeId = match.processNodeId || `unknown-process-node::${sid}`;
        
        // Update totals
        addEmissionValues(processEmissionSummary.totalEmissions, emissionValues);
        
        // Update byScope
        if (processEmissionSummary.byScope[scopeType]) {
          addEmissionValues(processEmissionSummary.byScope[scopeType], emissionValues);
          processEmissionSummary.byScope[scopeType].dataPointCount += 1;
        }
        
        // Update byCategory
        const cat = ensureMapEntry(processEmissionSummary.byCategory, categoryName, { 
          scopeType, 
          activities: new Map() 
        });
        addEmissionValues(cat, emissionValues);
        const catAct = ensureMapEntry(cat.activities, activity);
        addEmissionValues(catAct, emissionValues);
        
        // Update byActivity
        const act = ensureMapEntry(processEmissionSummary.byActivity, activity, { 
          scopeType, 
          categoryName 
        });
        addEmissionValues(act, emissionValues);
        
        // Update byNode
        const nodeBucket = ensureMapEntry(processEmissionSummary.byNode, processNodeId, {
          nodeLabel: match.nodeMeta.label,
          department: match.nodeMeta.department,
          location: match.nodeMeta.location,
          scopeIdentifiers: new Map(),
          byScope: {
            "Scope 1": { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
            "Scope 2": { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
            "Scope 3": { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 }
          }
        });
        addEmissionValues(nodeBucket, emissionValues);
        
        if (nodeBucket.byScope[scopeType]) {
          addEmissionValues(nodeBucket.byScope[scopeType], emissionValues);
          nodeBucket.byScope[scopeType].dataPointCount += 1;
        }
        
        // Track scopeIdentifier within node
        if (!nodeBucket.scopeIdentifiers.has(sid)) {
          nodeBucket.scopeIdentifiers.set(sid, {
            allocationPct,
            isShared: isSharedScope,
            CO2e: 0,
            dataPointCount: 0
          });
        }
        const nodeScope = nodeBucket.scopeIdentifiers.get(sid);
        nodeScope.CO2e += emissionValues.CO2e;
        nodeScope.dataPointCount += 1;
        
        // 🆕 ENHANCED: Track node allocation with full emission values
        if (!scopeIdBucket.nodes.has(processNodeId)) {
          scopeIdBucket.nodes.set(processNodeId, {
            nodeLabel: match.nodeMeta.label,
            department: match.nodeMeta.department,
            location: match.nodeMeta.location,
            allocationPct,
            allocatedEmissions: {
              CO2e: 0,
              CO2: 0,
              CH4: 0,
              N2O: 0,
              uncertainty: 0
            },
            dataPointCount: 0
          });
        }
        
        const nodeInScope = scopeIdBucket.nodes.get(processNodeId);
        addEmissionValues(nodeInScope.allocatedEmissions, emissionValues);
        nodeInScope.dataPointCount += 1;
        
        // Update other aggregations
        const dept = ensureMapEntry(processEmissionSummary.byDepartment, match.nodeMeta.department);
        addEmissionValues(dept, emissionValues);
        
        const loc = ensureMapEntry(processEmissionSummary.byLocation, match.nodeMeta.location);
        addEmissionValues(loc, emissionValues);
        
        if (processEmissionSummary.byInputType[entry.inputType]) {
          processEmissionSummary.byInputType[entry.inputType].CO2e += emissionValues.CO2e;
          processEmissionSummary.byInputType[entry.inputType].dataPointCount += 1;
        }
        
        const eff = ensureMapEntry(
          processEmissionSummary.byEmissionFactor,
          entry.emissionFactor || "Unknown",
          { scopeTypes: { "Scope 1": 0, "Scope 2": 0, "Scope 3": 0 } }
        );
        addEmissionValues(eff, emissionValues);
        eff.scopeTypes[scopeType] += 1;
      }
      
      // Track entry ID
      if (!processedEntryIds.has(entry._id.toString())) {
        processEmissionSummary.metadata.dataEntriesIncluded.push(entry._id);
        processedEntryIds.add(entry._id.toString());
      }
    }
    
    // 🆕 FINALIZE ALLOCATION BREAKDOWNS
    log.verbose(`  🔧 Finalizing allocation breakdowns...`);
    const finalizationStats = finalizeAllocationBreakdowns(
      processEmissionSummary.byScopeIdentifier,
      processEmissionSummary.metadata.allocationWarnings
    );
    
    log.verbose(`  ✅ Finalized: ${finalizationStats.totalScopesProcessed} scopes, ` +
                `${finalizationStats.totalFullyAllocatedScopes} fully allocated, ` +
                `${finalizationStats.totalUnallocatedScopes} with unallocated portions`);
    
    processEmissionSummary.metadata.totalDataPoints = includedCount;
    
    return processEmissionSummary;
    
  } catch (error) {
    log.error(`  ❌ Error recalculating: ${error.message}`);
    throw error;
  }
}

/**
 * Convert Map objects to plain objects for MongoDB storage
 */
function convertMapsToObjects(obj) {
  if (obj instanceof Map) {
    const result = {};
    for (const [key, value] of obj.entries()) {
      result[key] = convertMapsToObjects(value);
    }
    return result;
  } else if (obj && typeof obj === 'object' && !Array.isArray(obj) && !(obj instanceof Date)) {
    const result = {};
    for (const key in obj) {
      result[key] = convertMapsToObjects(obj[key]);
    }
    return result;
  } else {
    return obj;
  }
}

/**
 * Update a single EmissionSummary document
 */
async function updateEmissionSummary(doc, checkpoint) {
  const docId = doc._id.toString();
  
  // Skip if already processed
  if (checkpoint.hasProcessed(docId)) {
    log.verbose(`  ⏭️  Skipping ${docId} (already processed)`);
    return { updated: false, reason: 'already_processed' };
  }
  
  // Skip if client in skip list
  if (CONFIG.SKIP_CLIENTS.includes(doc.clientId)) {
    log.verbose(`  ⏭️  Skipping ${docId} (client in skip list)`);
    checkpoint.markProcessed(docId, false);
    checkpoint.save();
    return { updated: false, reason: 'client_skipped' };
  }
  
  // Skip if client not in only list (if specified)
  if (CONFIG.ONLY_CLIENTS.length > 0 && !CONFIG.ONLY_CLIENTS.includes(doc.clientId)) {
    log.verbose(`  ⏭️  Skipping ${docId} (client not in only list)`);
    checkpoint.markProcessed(docId, false);
    checkpoint.save();
    return { updated: false, reason: 'client_not_in_only_list' };
  }
  
  try {
    log.normal(`\n📄 Processing: ${docId}`);
    log.normal(`   Client: ${doc.clientId}`);
    log.normal(`   Period: ${doc.period.type} ${doc.period.year}${doc.period.month ? '-' + doc.period.month : ''}`);
    
    // Check if document already has allocation breakdown
    const hasByScopeIdentifier = doc.processEmissionSummary?.byScopeIdentifier;
    
    if (hasByScopeIdentifier) {
      // Check if any scopeIdentifier has allocationBreakdown
      const byScopeId = doc.processEmissionSummary.byScopeIdentifier;
      const hasAllocationBreakdown = Object.values(byScopeId).some(
        scope => scope.allocationBreakdown !== undefined && scope.allocationBreakdown !== null
      );
      
      if (hasAllocationBreakdown) {
        log.normal(`   ✓ Already has allocation breakdown - skipping`);
        checkpoint.markProcessed(docId, false);
        checkpoint.save();
        return { updated: false, reason: 'already_has_breakdown' };
      }
    }
    
    // Recalculate processEmissionSummary
    const newProcessEmissionSummary = await recalculateProcessEmissionSummary(doc);
    
    if (!newProcessEmissionSummary) {
      log.normal(`   ⚠️  Could not recalculate (no ProcessFlowchart or data)`);
      checkpoint.markProcessed(docId, false);
      checkpoint.save();
      return { updated: false, reason: 'no_data' };
    }
    
    // Convert Maps to objects
    const processEmissionSummaryObj = convertMapsToObjects(newProcessEmissionSummary);
    
    // Update document
    if (CONFIG.DRY_RUN) {
      log.normal(`   🔍 DRY RUN: Would update document with new allocation breakdown`);
      log.verbose(`   New structure includes:
         - ${Object.keys(processEmissionSummaryObj.byScopeIdentifier || {}).length} scopeIdentifiers
         - ${newProcessEmissionSummary.metadata.sharedScopeIdentifiers} shared scopes
         - ${newProcessEmissionSummary.metadata.allocationWarnings.length} allocation warnings`);
    } else {
      await EmissionSummary.updateOne(
        { _id: doc._id },
        {
          $set: {
            processEmissionSummary: processEmissionSummaryObj,
            'metadata.lastCalculated': new Date(),
            'metadata.version': (doc.metadata?.version || 0) + 1
          }
        }
      );
      log.normal(`   ✅ Updated successfully`);
    }
    
    checkpoint.markProcessed(docId, true);
    checkpoint.save();
    
    return { 
      updated: true, 
      sharedScopes: newProcessEmissionSummary.metadata.sharedScopeIdentifiers,
      warnings: newProcessEmissionSummary.metadata.allocationWarnings.length
    };
    
  } catch (error) {
    log.error(`   ❌ Error: ${error.message}`);
    checkpoint.markFailed(docId, error.message);
    checkpoint.save();
    return { updated: false, reason: 'error', error: error.message };
  }
}

/**
 * Process documents in batches
 */
async function processBatch(documents, checkpoint) {
  const results = {
    updated: 0,
    skipped: 0,
    failed: 0
  };
  
  for (const doc of documents) {
    const result = await updateEmissionSummary(doc, checkpoint);
    
    if (result.updated) {
      results.updated++;
    } else if (result.error) {
      results.failed++;
    } else {
      results.skipped++;
    }
    
    // Small delay to avoid overwhelming the database
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return results;
}

/**
 * Delay function
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// MAIN MIGRATION FUNCTION
// ============================================================================

async function runMigration() {
  const startTime = Date.now();
  
  log.always('\n' + '='.repeat(80));
  log.always('📊 EMISSION SUMMARY ALLOCATION BREAKDOWN MIGRATION');
  log.always('='.repeat(80));
  log.always(`\nConfiguration:`);
  log.always(`  - Dry Run: ${CONFIG.DRY_RUN ? 'YES (no changes will be made)' : 'NO (will update database)'}`);
  log.always(`  - Batch Size: ${CONFIG.BATCH_SIZE}`);
  log.always(`  - Batch Delay: ${CONFIG.BATCH_DELAY}ms`);
  log.always(`  - Log Level: ${CONFIG.LOG_LEVEL}`);
  if (CONFIG.SKIP_CLIENTS.length > 0) {
    log.always(`  - Skip Clients: ${CONFIG.SKIP_CLIENTS.join(', ')}`);
  }
  if (CONFIG.ONLY_CLIENTS.length > 0) {
    log.always(`  - Only Clients: ${CONFIG.ONLY_CLIENTS.join(', ')}`);
  }
  log.always('');
  
  try {
    // Connect to MongoDB
    log.normal('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
    log.normal('✅ Connected to MongoDB\n');
    
    // Initialize checkpoint
    const checkpoint = new CheckpointManager(CONFIG.CHECKPOINT_FILE);
    
    if (checkpoint.data.processedIds.length > 0) {
      log.always(`📋 Resuming from checkpoint:`);
      log.always(`   - Already processed: ${checkpoint.data.processedIds.length} documents`);
      log.always(`   - Failed: ${checkpoint.data.failedIds.length} documents`);
      log.always('');
    }
    
    // Find all EmissionSummary documents with processEmissionSummary
    log.normal('🔍 Finding EmissionSummary documents...');
    
    // Find documents that have processEmissionSummary but DON'T have byScopeIdentifier yet
    // This means we need to recalculate them to ADD the byScopeIdentifier structure
    const query = {
      processEmissionSummary: { $exists: true, $ne: null },
      'processEmissionSummary.byScopeIdentifier': { $exists: false }
    };
    
    const totalCount = await EmissionSummary.countDocuments(query);
    checkpoint.data.stats.total = totalCount;
    
    // Also count documents that already have byScopeIdentifier (for info)
    const alreadyHasByScopeId = await EmissionSummary.countDocuments({
      'processEmissionSummary.byScopeIdentifier': { $exists: true }
    });
    
    log.always(`📊 EmissionSummary Analysis:`);
    log.always(`   - Documents needing byScopeIdentifier: ${totalCount}`);
    log.always(`   - Documents already have byScopeIdentifier: ${alreadyHasByScopeId}`);
    log.always('');
    
    if (totalCount === 0) {
      if (alreadyHasByScopeId > 0) {
        log.always('✅ All documents already have byScopeIdentifier structure!');
        log.always('   No migration needed.');
      } else {
        log.always('⚠️  No documents found with processEmissionSummary');
        log.always('');
        log.always('💡 This could mean:');
        log.always('   1. Emission summaries have not been calculated yet');
        log.always('   2. All documents already migrated');
        log.always('');
        const allDocsCount = await EmissionSummary.countDocuments({});
        log.always(`📊 Total EmissionSummary documents: ${allDocsCount}`);
      }
      log.always('');
      return;
    }
    
    log.always(`🎯 Will add byScopeIdentifier (with allocation tracking) to ${totalCount} documents\n`);
    
    // Process in batches
    let processedInThisRun = 0;
    let batchNumber = 0;
    
    while (processedInThisRun < totalCount) {
      batchNumber++;
      
      // Fetch next batch
      const documents = await EmissionSummary.find(query)
        .limit(CONFIG.BATCH_SIZE)
        .skip(processedInThisRun)
        .lean();
      
      if (documents.length === 0) break;
      
      log.always(`\n${'─'.repeat(80)}`);
      log.always(`📦 Batch ${batchNumber} (${processedInThisRun + 1}-${processedInThisRun + documents.length} of ${totalCount})`);
      log.always('─'.repeat(80));
      
      // Process batch
      const batchResults = await processBatch(documents, checkpoint);
      
      processedInThisRun += documents.length;
      
      // Show batch summary
      log.always(`\n📊 Batch ${batchNumber} Summary:`);
      log.always(`   - Updated: ${batchResults.updated}`);
      log.always(`   - Skipped: ${batchResults.skipped}`);
      log.always(`   - Failed: ${batchResults.failed}`);
      
      // Show overall progress
      const stats = checkpoint.getStats();
      const progress = ((stats.processed / totalCount) * 100).toFixed(1);
      log.always(`\n📈 Overall Progress: ${stats.processed}/${totalCount} (${progress}%)`);
      log.always(`   - Updated: ${stats.updated}`);
      log.always(`   - Skipped: ${stats.skipped}`);
      log.always(`   - Failed: ${stats.failed}`);
      
      // Delay between batches
      if (processedInThisRun < totalCount) {
        log.verbose(`\n⏸️  Pausing for ${CONFIG.BATCH_DELAY}ms...`);
        await delay(CONFIG.BATCH_DELAY);
      }
    }
    
    // Final summary
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const stats = checkpoint.getStats();
    
    log.always('\n' + '='.repeat(80));
    log.always('✅ MIGRATION COMPLETE');
    log.always('='.repeat(80));
    log.always(`\n📊 Final Statistics:`);
    log.always(`   - Total Documents: ${totalCount}`);
    log.always(`   - Updated: ${stats.updated}`);
    log.always(`   - Skipped: ${stats.skipped}`);
    log.always(`   - Failed: ${stats.failed}`);
    log.always(`   - Duration: ${duration}s`);
    
    if (stats.failed > 0) {
      log.always(`\n⚠️  ${stats.failed} documents failed to process.`);
      log.always(`   Check checkpoint file for failed IDs: ${CONFIG.CHECKPOINT_FILE}`);
    }
    
    if (CONFIG.DRY_RUN) {
      log.always(`\n🔍 This was a DRY RUN - no changes were made to the database.`);
      log.always(`   Set DRY_RUN=false to apply changes.`);
    }
    
    log.always('');
    
  } catch (error) {
    log.error('\n❌ Migration failed with error:');
    log.error(error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    log.normal('🔌 Disconnected from MongoDB\n');
  }
}

// ============================================================================
// RUN MIGRATION
// ============================================================================

if (require.main === module) {
  runMigration()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

module.exports = { runMigration };