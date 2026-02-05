/**
 * ============================================================================
 * COMPREHENSIVE MIGRATION: Emission & Reduction Summary Recalculation
 * ============================================================================
 * 
 * This script recalculates BOTH emission and reduction summaries with:
 * - ✅ Weekly period support
 * - ✅ Proper category, activity, department, location extraction
 * - ✅ Fixed "Unknown" values
 * - ✅ All periods: daily, weekly, monthly, yearly, all-time
 * 
 * USAGE:
 * node migration-recalculate-summaries-COMPLETE.js
 * 
 * ============================================================================
 */

require('dotenv').config();
const mongoose = require('mongoose');
const EmissionSummary = require('../models/CalculationEmission/EmissionSummary');
const DataEntry = require('../models/Organization/DataEntry');
const ProcessFlowchart = require('../models/Organization/Flowchart');
const NetReductionEntry = require('../models/Reduction/NetReductionEntry');
const Reduction = require('../models/Reduction/Reduction');
const fs = require('fs');
const path = require('path');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  DRY_RUN: false,  // Set to true to test without saving
  BATCH_SIZE: 50,
  TARGET_CLIENT: 'Greon017',
  CHECKPOINT_FILE: 'migration-checkpoint-complete.json'
};

// ============================================================================
// CHECKPOINT SYSTEM
// ============================================================================

function loadCheckpoint() {
  try {
    if (fs.existsSync(CONFIG.CHECKPOINT_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG.CHECKPOINT_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('⚠️  Error loading checkpoint:', error.message);
  }
  return { processedIds: [], stats: { updated: 0, skipped: 0, errors: 0 } };
}

function saveCheckpoint(data) {
  try {
    fs.writeFileSync(CONFIG.CHECKPOINT_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('⚠️  Error saving checkpoint:', error.message);
  }
}

// ============================================================================
// DATE RANGE BUILDER (WITH WEEKLY SUPPORT)
// ============================================================================

function buildDateRange(periodType, year, month, week, day) {
  const now = new Date();
  let from, to;

  switch (periodType) {
    case 'daily':
      if (year && month && day) {
        from = new Date(year, month - 1, day, 0, 0, 0);
        to = new Date(year, month - 1, day, 23, 59, 59, 999);
      } else {
        from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
      }
      break;

    case 'weekly':
      if (year && week) {
        const firstDayOfYear = new Date(year, 0, 1);
        const daysToWeek = (week - 1) * 7;
        from = new Date(firstDayOfYear.getTime() + daysToWeek * 24 * 60 * 60 * 1000);
        to = new Date(from.getTime() + 6 * 24 * 60 * 60 * 1000 + 23 * 60 * 60 * 1000 + 59 * 60 * 1000 + 59 * 1000);
      } else {
        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() - now.getDay());
        from = new Date(startOfWeek.getFullYear(), startOfWeek.getMonth(), startOfWeek.getDate(), 0, 0, 0);
        to = new Date(from.getTime() + 6 * 24 * 60 * 60 * 1000 + 23 * 60 * 60 * 1000 + 59 * 60 * 1000 + 59 * 1000);
      }
      break;

    case 'monthly':
      if (year && month) {
        from = new Date(year, month - 1, 1, 0, 0, 0);
        to = new Date(year, month, 0, 23, 59, 59, 999);
      } else {
        from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
        to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      }
      break;

    case 'yearly':
      if (year) {
        from = new Date(year, 0, 1, 0, 0, 0);
        to = new Date(year, 11, 31, 23, 59, 59, 999);
      } else {
        from = new Date(now.getFullYear(), 0, 1, 0, 0, 0);
        to = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
      }
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

// ============================================================================
// METADATA EXTRACTION FROM NODES
// ============================================================================

async function buildMetadataCache(clientId) {
  console.log('📚 Building metadata cache from ProcessFlowchart...');
  
  const flowcharts = await ProcessFlowchart.find({ clientId }).lean();
  
  const metadataCache = new Map(); // scopeIdentifier -> metadata
  
  for (const chart of flowcharts) {
    for (const node of chart.nodes || []) {
      const { department, location } = node.details || {};
      
      for (const scope of node.details?.scopeDetails || []) {
        const metadata = {
          scopeIdentifier: scope.scopeIdentifier,
          category: scope.categoryName || 'Unknown',
          activity: scope.activity || 'Unknown',
          department: department || 'Unknown',
          location: location || 'Unknown',
          scopeType: scope.scopeType || 'Unknown',
          nodeLabel: node.label || 'Unknown Node'
        };
        
        metadataCache.set(scope.scopeIdentifier, metadata);
      }
    }
  }
  
  console.log(`✅ Loaded metadata for ${metadataCache.size} scope identifiers`);
  return metadataCache;
}

// ============================================================================
// EMISSION EXTRACTION (WITH PROPER METADATA)
// ============================================================================

function extractEmissionValues(calculatedEmissions, metadataCache, dataEntry) {
  const emissions = {
    CO2e: 0,
    CO2: 0,
    CH4: 0,
    N2O: 0,
    scopeType: 'Unknown',
    category: 'Unknown',
    activity: 'Unknown',
    department: 'Unknown',
    location: 'Unknown',
    nodeLabel: 'Unknown Node'
  };

  if (!calculatedEmissions || typeof calculatedEmissions !== "object") {
    return emissions;
  }

  // Extract from incoming bucket
  const addBucket = (bucketObj) => {
    if (!bucketObj || typeof bucketObj !== "object") return;

    const keys = (bucketObj instanceof Map) ? bucketObj.keys() : Object.keys(bucketObj);

    for (const bucketKey of keys) {
      const item = (bucketObj instanceof Map) ? bucketObj.get(bucketKey) : bucketObj[bucketKey];
      
      if (!item || typeof item !== "object") continue;

      const co2e = Number(item.CO2e ?? item.emission ?? item.CO2eWithUncertainty ?? item.emissionWithUncertainty) || 0;

      emissions.CO2e += co2e;
      emissions.CO2 += Number(item.CO2) || 0;
      emissions.CH4 += Number(item.CH4) || 0;
      emissions.N2O += Number(item.N2O) || 0;
    }
  };

  addBucket(calculatedEmissions.incoming);

  // 🔥 GET METADATA FROM CACHE
  const scopeId = dataEntry.scopeIdentifier || dataEntry.scope?.scopeIdentifier;
  if (scopeId && metadataCache.has(scopeId)) {
    const meta = metadataCache.get(scopeId);
    emissions.scopeType = meta.scopeType;
    emissions.category = meta.category;
    emissions.activity = meta.activity;
    emissions.department = meta.department;
    emissions.location = meta.location;
    emissions.nodeLabel = meta.nodeLabel;
  }

  return emissions;
}

// ============================================================================
// ENSURE MAP ENTRY
// ============================================================================

function ensureMapEntry(map, key, defaultValue = {}) {
  if (!map.has(key)) {
    map.set(key, {
      CO2e: 0,
      CO2: 0,
      CH4: 0,
      N2O: 0,
      uncertainty: 0,
      dataPointCount: 0,
      ...defaultValue
    });
  }
  return map.get(key);
}

// ============================================================================
// RECALCULATE EMISSION SUMMARY FOR ONE PERIOD
// ============================================================================

async function recalculateEmissionSummary(summary, metadataCache) {
  const { clientId, period } = summary;
  const { type, year, month, week, day } = period;

  try {
    const { from, to } = buildDateRange(type, year, month, week, day);

    // Get dataentries for this period
    const dataEntries = await DataEntry.find({
      clientId,
      processingStatus: 'processed',
      timestamp: { $gte: from, $lte: to }
    }).lean();

    if (dataEntries.length === 0) {
      return { hasData: false };
    }

    // Initialize summary structure
    const emissionSummary = {
      totalEmissions: { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0 },
      byScope: {},
      byCategory: new Map(),
      byActivity: new Map(),
      byNode: new Map(),
      byDepartment: new Map(),
      byLocation: new Map(),
      byInputType: {},
      byEmissionFactor: new Map()
    };

    // Process each dataentry
    for (const entry of dataEntries) {
      const emissions = extractEmissionValues(entry.calculatedEmissions, metadataCache, entry);
      
      // Total emissions
      emissionSummary.totalEmissions.CO2e += emissions.CO2e;
      emissionSummary.totalEmissions.CO2 += emissions.CO2;
      emissionSummary.totalEmissions.CH4 += emissions.CH4;
      emissionSummary.totalEmissions.N2O += emissions.N2O;

      // By Scope
      const scopeType = emissions.scopeType;
      if (!emissionSummary.byScope[scopeType]) {
        emissionSummary.byScope[scopeType] = { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 };
      }
      emissionSummary.byScope[scopeType].CO2e += emissions.CO2e;
      emissionSummary.byScope[scopeType].CO2 += emissions.CO2;
      emissionSummary.byScope[scopeType].CH4 += emissions.CH4;
      emissionSummary.byScope[scopeType].N2O += emissions.N2O;
      emissionSummary.byScope[scopeType].dataPointCount++;

      // By Category
      const categoryKey = emissions.category;
      const categoryEntry = ensureMapEntry(emissionSummary.byCategory, categoryKey, {
        scopeType: emissions.scopeType,
        activities: new Map()
      });
      categoryEntry.CO2e += emissions.CO2e;
      categoryEntry.CO2 += emissions.CO2;
      categoryEntry.CH4 += emissions.CH4;
      categoryEntry.N2O += emissions.N2O;
      categoryEntry.dataPointCount++;

      // By Activity (within category)
      const activityEntry = ensureMapEntry(categoryEntry.activities, emissions.activity);
      activityEntry.CO2e += emissions.CO2e;
      activityEntry.CO2 += emissions.CO2;
      activityEntry.CH4 += emissions.CH4;
      activityEntry.N2O += emissions.N2O;
      activityEntry.dataPointCount++;

      // By Activity (top-level)
      const actEntry = ensureMapEntry(emissionSummary.byActivity, emissions.activity, {
        scopeType: emissions.scopeType,
        categoryName: emissions.category
      });
      actEntry.CO2e += emissions.CO2e;
      actEntry.CO2 += emissions.CO2;
      actEntry.CH4 += emissions.CH4;
      actEntry.N2O += emissions.N2O;
      actEntry.dataPointCount++;

      // By Department
      const deptEntry = ensureMapEntry(emissionSummary.byDepartment, emissions.department, { nodeCount: 0 });
      deptEntry.CO2e += emissions.CO2e;
      deptEntry.CO2 += emissions.CO2;
      deptEntry.CH4 += emissions.CH4;
      deptEntry.N2O += emissions.N2O;
      deptEntry.dataPointCount++;

      // By Location
      const locEntry = ensureMapEntry(emissionSummary.byLocation, emissions.location, { nodeCount: 0 });
      locEntry.CO2e += emissions.CO2e;
      locEntry.CO2 += emissions.CO2;
      locEntry.CH4 += emissions.CH4;
      locEntry.N2O += emissions.N2O;
      locEntry.dataPointCount++;

      // By Node
      const nodeEntry = ensureMapEntry(emissionSummary.byNode, emissions.nodeLabel, {
        department: emissions.department,
        location: emissions.location,
        byScope: {}
      });
      nodeEntry.CO2e += emissions.CO2e;
      nodeEntry.CO2 += emissions.CO2;
      nodeEntry.CH4 += emissions.CH4;
      nodeEntry.N2O += emissions.N2O;
      nodeEntry.dataPointCount++;

      // By Input Type
      const inputType = entry.inputType || 'manual';
      if (!emissionSummary.byInputType[inputType]) {
        emissionSummary.byInputType[inputType] = { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 };
      }
      emissionSummary.byInputType[inputType].CO2e += emissions.CO2e;
      emissionSummary.byInputType[inputType].CO2 += emissions.CO2;
      emissionSummary.byInputType[inputType].CH4 += emissions.CH4;
      emissionSummary.byInputType[inputType].N2O += emissions.N2O;
      emissionSummary.byInputType[inputType].dataPointCount++;
    }

    // Convert Maps to Objects for MongoDB
    const finalSummary = {
      ...emissionSummary,
      byCategory: Object.fromEntries(
        [...emissionSummary.byCategory.entries()].map(([key, value]) => [
          key,
          {
            ...value,
            activities: Object.fromEntries(value.activities)
          }
        ])
      ),
      byActivity: Object.fromEntries(emissionSummary.byActivity),
      byNode: Object.fromEntries(emissionSummary.byNode),
      byDepartment: Object.fromEntries(emissionSummary.byDepartment),
      byLocation: Object.fromEntries(emissionSummary.byLocation),
      byEmissionFactor: Object.fromEntries(emissionSummary.byEmissionFactor),
      metadata: {
        version: (summary.emissionSummary?.metadata?.version || 0) + 1,
        lastCalculated: new Date(),
        recalculatedByMigration: true
      }
    };

    return {
      hasData: true,
      emissionSummary: finalSummary,
      entriesProcessed: dataEntries.length
    };

  } catch (error) {
    console.error(`\n❌ Error recalculating emission summary:`, error);
    throw error;
  }
}

// ============================================================================
// RECALCULATE REDUCTION SUMMARY FOR ONE PERIOD
// ============================================================================

async function recalculateReductionSummary(summary) {
  const { clientId, period } = summary;
  const { type, year, month, week, day } = period;

  try {
    const { from, to } = buildDateRange(type, year, month, week, day);

    // Get reduction entries for this period
    const entries = await NetReductionEntry.find({
      clientId,
      timestamp: { $gte: from, $lte: to }
    }).lean();

    if (entries.length === 0) {
      return { hasData: false };
    }

    // Get project metadata
    const projectIds = [...new Set(entries.map(e => e.projectId))];
    const projects = await Reduction.find({
      clientId,
      projectId: { $in: projectIds }
    }).select('projectId projectName projectActivity category scope location calculationMethodology').lean();

    const projectMeta = new Map();
    projects.forEach(p => projectMeta.set(p.projectId, p));

    // Initialize summary
    const reductionSummary = {
      totalNetReduction: 0,
      entriesCount: entries.length,
      byProject: [],
      byCategory: {},
      byScope: {},
      byLocation: {},
      byProjectActivity: {},
      byMethodology: {}
    };

    const projectMap = new Map();

    // Process each entry
    for (const e of entries) {
      const net = Number(e.netReduction || 0);
      reductionSummary.totalNetReduction += net;

      const meta = projectMeta.get(e.projectId) || {};
      const projectId = e.projectId;
      const projectName = meta.projectName || e.projectId;
      const projectActivity = meta.projectActivity || 'Unknown';
      const category = meta.category || 'Unknown';
      const scope = meta.scope || 'Unknown';
      const location = meta.location?.place || meta.location?.address || 'Unknown';
      const methodology = meta.calculationMethodology || 'unknown';

      // By Project
      if (!projectMap.has(projectId)) {
        projectMap.set(projectId, {
          projectId,
          projectName,
          projectActivity,
          category,
          scope,
          location,
          methodology,
          totalNetReduction: 0,
          entriesCount: 0
        });
      }
      const row = projectMap.get(projectId);
      row.totalNetReduction += net;
      row.entriesCount++;

      // By Category
      if (!reductionSummary.byCategory[category]) {
        reductionSummary.byCategory[category] = { totalNetReduction: 0, entriesCount: 0 };
      }
      reductionSummary.byCategory[category].totalNetReduction += net;
      reductionSummary.byCategory[category].entriesCount++;

      // By Scope
      if (!reductionSummary.byScope[scope]) {
        reductionSummary.byScope[scope] = { totalNetReduction: 0, entriesCount: 0 };
      }
      reductionSummary.byScope[scope].totalNetReduction += net;
      reductionSummary.byScope[scope].entriesCount++;

      // By Location
      if (!reductionSummary.byLocation[location]) {
        reductionSummary.byLocation[location] = { totalNetReduction: 0, entriesCount: 0 };
      }
      reductionSummary.byLocation[location].totalNetReduction += net;
      reductionSummary.byLocation[location].entriesCount++;

      // By Project Activity
      if (!reductionSummary.byProjectActivity[projectActivity]) {
        reductionSummary.byProjectActivity[projectActivity] = { totalNetReduction: 0, entriesCount: 0 };
      }
      reductionSummary.byProjectActivity[projectActivity].totalNetReduction += net;
      reductionSummary.byProjectActivity[projectActivity].entriesCount++;

      // By Methodology
      if (!reductionSummary.byMethodology[methodology]) {
        reductionSummary.byMethodology[methodology] = { totalNetReduction: 0, entriesCount: 0 };
      }
      reductionSummary.byMethodology[methodology].totalNetReduction += net;
      reductionSummary.byMethodology[methodology].entriesCount++;
    }

    reductionSummary.byProject = [...projectMap.values()];

    return {
      hasData: true,
      reductionSummary,
      entriesProcessed: entries.length
    };

  } catch (error) {
    console.error(`\n❌ Error recalculating reduction summary:`, error);
    throw error;
  }
}

// ============================================================================
// MAIN MIGRATION
// ============================================================================

async function runMigration() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║  COMPREHENSIVE EMISSION & REDUCTION SUMMARY MIGRATION          ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('📋 Configuration:');
  console.log(`   - DRY RUN: ${CONFIG.DRY_RUN ? 'YES (no changes will be saved)' : 'NO (changes will be saved)'}`);
  console.log(`   - Batch Size: ${CONFIG.BATCH_SIZE}`);
  console.log(`   - Target Client: ${CONFIG.TARGET_CLIENT}`);
  console.log('');

  try {
    // Connect to MongoDB
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');
    console.log('');

    // Load metadata cache
    const metadataCache = await buildMetadataCache(CONFIG.TARGET_CLIENT);
    console.log('');

    // Get all summaries
    const totalSummaries = await EmissionSummary.countDocuments({ clientId: CONFIG.TARGET_CLIENT });
    console.log(`📊 Total summaries to process: ${totalSummaries}`);
    console.log('');

    // Load checkpoint
    const checkpoint = loadCheckpoint();
    const processedIds = new Set(checkpoint.processedIds || []);
    const stats = checkpoint.stats || { updated: 0, skipped: 0, noData: 0, errors: 0 };

    let processedCount = processedIds.size;
    let totalEmissionsAdded = 0;
    let totalReductionsAdded = 0;

    // Process in batches
    let skip = 0;
    const startTime = Date.now();

    while (skip < totalSummaries) {
      const summaries = await EmissionSummary.find({ clientId: CONFIG.TARGET_CLIENT })
        .skip(skip)
        .limit(CONFIG.BATCH_SIZE)
        .lean();

      if (summaries.length === 0) break;

      console.log(`\n📦 Processing batch ${Math.floor(skip / CONFIG.BATCH_SIZE) + 1}...`);

      for (const summary of summaries) {
        if (processedIds.has(summary._id.toString())) {
          stats.skipped++;
          continue;
        }

        try {
          // Recalculate emission summary
          const emissionResult = await recalculateEmissionSummary(summary, metadataCache);
          
          // Recalculate reduction summary
          const reductionResult = await recalculateReductionSummary(summary);

          if (!emissionResult.hasData && !reductionResult.hasData) {
            stats.noData++;
            processedIds.add(summary._id.toString());
            continue;
          }

          // Prepare update
          const updateData = {};
          
          if (emissionResult.hasData) {
            updateData.emissionSummary = emissionResult.emissionSummary;
            totalEmissionsAdded += emissionResult.emissionSummary.totalEmissions.CO2e;
            
            const periodLabel = `${summary.period.type} ${summary.period.year || ''}${summary.period.month ? '-' + summary.period.month : ''}${summary.period.week ? '-W' + summary.period.week : ''}${summary.period.day ? '-' + summary.period.day : ''}`;
            console.log(`  ✅ Updated emission summary (${periodLabel})`);
            console.log(`     Total: ${emissionResult.emissionSummary.totalEmissions.CO2e.toFixed(2)} CO2e tonnes`);
            console.log(`     Processed ${emissionResult.entriesProcessed} entries`);
          }

          if (reductionResult.hasData) {
            updateData.reductionSummary = reductionResult.reductionSummary;
            updateData['metadata.hasReductionSummary'] = true;
            updateData['metadata.lastReductionSummaryCalculatedAt'] = new Date();
            totalReductionsAdded += reductionResult.reductionSummary.totalNetReduction;
            
            console.log(`     Reduction: ${reductionResult.reductionSummary.totalNetReduction.toFixed(2)} CO2e tonnes reduced`);
          }

          // Save to database
          if (!CONFIG.DRY_RUN && Object.keys(updateData).length > 0) {
            await EmissionSummary.findByIdAndUpdate(summary._id, { $set: updateData });
          }

          stats.updated++;
          processedIds.add(summary._id.toString());
          processedCount++;

        } catch (error) {
          stats.errors++;
          console.error(`  ❌ Error processing summary ${summary._id}: ${error.message}`);
        }
      }

      // Save checkpoint every batch
      saveCheckpoint({
        processedIds: [...processedIds],
        stats,
        lastProcessed: new Date().toISOString()
      });

      console.log(`\n📍 Checkpoint saved: ${processedCount} processed`);
      console.log(`   Updated: ${stats.updated}, Skipped: ${stats.skipped}, No Data: ${stats.noData}, Errors: ${stats.errors}`);

      skip += CONFIG.BATCH_SIZE;
    }

    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);

    // Final report
    console.log('\n');
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║  MIGRATION COMPLETE                                            ║');
    console.log('╚════════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('📊 Final Statistics:');
    console.log(`   - Total Processed: ${processedCount}`);
    console.log(`   - Updated: ${stats.updated}`);
    console.log(`   - Skipped (already done): ${stats.skipped}`);
    console.log(`   - No Data: ${stats.noData}`);
    console.log(`   - Errors: ${stats.errors}`);
    console.log(`   - Total Emissions Added: ${totalEmissionsAdded.toFixed(2)} CO2e tonnes`);
    console.log(`   - Total Reductions Added: ${totalReductionsAdded.toFixed(2)} CO2e tonnes`);
    console.log(`   - Duration: ${duration} minutes`);
    console.log(`   - Mode: ${CONFIG.DRY_RUN ? 'DRY RUN' : 'LIVE (changes saved)'}`);
    console.log('');

    // Cleanup checkpoint
    if (fs.existsSync(CONFIG.CHECKPOINT_FILE)) {
      fs.unlinkSync(CONFIG.CHECKPOINT_FILE);
      console.log('✅ Checkpoint file removed');
    }

  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
    console.log('✅ Migration script completed successfully');
  }
}

// Run migration
runMigration()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });