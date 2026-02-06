/**
 * ============================================================================
 * ENHANCED EMISSION SUMMARY METADATA FIX (STANDALONE VERSION)
 * ============================================================================
 * 
 * This script fixes "Unknown" values in EmissionSummary by mapping
 * scopeIdentifiers from DataEntry to Flowchart metadata
 * ============================================================================
 */

const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// ============================================================================
// MODELS
// ============================================================================

const EmissionSummary = require('./models/CalculationEmission/EmissionSummary');
const Flowchart = require('./models/Organization/Flowchart');
const ProcessFlowchart = require('./models/Organization/ProcessFlowchart');
const DataEntry = require('./models/Organization/DataEntry');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  MONGO_URI: process.env.MONGO_URI || 'mongodb+srv://zerocarbon:zerocarbon@zerocarbon.ujopg7s.mongodb.net/zeroCarbon',
  DRY_RUN: true,
  BATCH_SIZE: 50,
  CHECKPOINT_FILE: path.join(__dirname, '.emission_summary_enhanced_checkpoint.json'),
  LOG_FILE: path.join(__dirname, 'emission_summary_enhanced_migration.log'),
  VERBOSE: true
};

// ============================================================================
// LOGGER CLASS
// ============================================================================

class Logger {
  constructor(logFile, verbose = true) {
    this.logFile = logFile;
    this.verbose = verbose;
    this.stream = fs.createWriteStream(logFile, { flags: 'a' });
  }

  log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    this.stream.write(logMessage);
    if (this.verbose) {
      console.log(logMessage.trim());
    }
  }

  error(message) { this.log(message, 'ERROR'); }
  warn(message) { this.log(message, 'WARN'); }
  success(message) { this.log(message, 'SUCCESS'); }
  info(message) { this.log(message, 'INFO'); }
  
  close() {
    this.stream.end();
  }
}

// ============================================================================
// CHECKPOINT MANAGER CLASS
// ============================================================================

class CheckpointManager {
  constructor(checkpointFile) {
    this.checkpointFile = checkpointFile;
    this.checkpoint = this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.checkpointFile)) {
        const data = fs.readFileSync(this.checkpointFile, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('Error loading checkpoint:', error.message);
    }
    return {
      processedClients: [],
      lastProcessedClient: null,
      processedSummaries: [],
      startTime: new Date().toISOString(),
      totalProcessed: 0
    };
  }

  save() {
    try {
      fs.writeFileSync(this.checkpointFile, JSON.stringify(this.checkpoint, null, 2), 'utf8');
    } catch (error) {
      console.error('Error saving checkpoint:', error.message);
    }
  }

  markClientProcessed(clientId) {
    if (!this.checkpoint.processedClients.includes(clientId)) {
      this.checkpoint.processedClients.push(clientId);
    }
    this.checkpoint.lastProcessedClient = clientId;
    this.save();
  }

  markSummaryProcessed(summaryId) {
    this.checkpoint.processedSummaries.push(summaryId);
    this.checkpoint.totalProcessed++;
    this.save();
  }

  isClientProcessed(clientId) {
    return this.checkpoint.processedClients.includes(clientId);
  }

  isSummaryProcessed(summaryId) {
    return this.checkpoint.processedSummaries.includes(summaryId);
  }

  clear() {
    if (fs.existsSync(this.checkpointFile)) {
      fs.unlinkSync(this.checkpointFile);
    }
    this.checkpoint = {
      processedClients: [],
      lastProcessedClient: null,
      processedSummaries: [],
      startTime: new Date().toISOString(),
      totalProcessed: 0
    };
  }
}

// ============================================================================
// METADATA EXTRACTION
// ============================================================================

async function buildEnhancedMetadataMap(clientId, logger) {
  logger.info(`Building enhanced metadata map for client: ${clientId}`);
  
  const metadataMap = new Map();
  
  // Step 1: Get unique scopeIdentifiers from DataEntry
  const scopeIdentifiers = await DataEntry.distinct('scopeIdentifier', { 
    clientId,
    processingStatus: 'processed'
  });
  
  logger.info(`Found ${scopeIdentifiers.length} unique scopeIdentifiers in DataEntry`);
  
  // Step 2: Load flowcharts
  const flowchart = await Flowchart.findOne({ clientId, isActive: true }).lean();
  const processFlowchart = await ProcessFlowchart.findOne({ clientId, isDeleted: false }).lean();
  
  // Step 3: Build lookup by scopeIdentifier
  const scopeLookup = new Map();
  
  const processChart = (chart, chartType) => {
    if (!chart || !Array.isArray(chart.nodes)) return;
    
    for (const node of chart.nodes) {
      const scopeDetails = node.details?.scopeDetails || [];
      
      for (const scope of scopeDetails) {
        if (scope.isDeleted) continue;
        
        const sid = scope.scopeIdentifier;
        if (!sid) continue;
        
        const metadata = {
          scopeIdentifier: sid,
          scopeType: scope.scopeType,
          categoryName: scope.categoryName || null,
          activity: scope.activity || null,
          nodeId: node.id,
          nodeLabel: node.label || 'Unknown Node',
          department: node.details?.department || null,
          location: node.details?.location || null,
          source: chartType
        };
        
        const existing = scopeLookup.get(sid);
        if (!existing || (metadata.categoryName && metadata.activity && metadata.department && metadata.location)) {
          scopeLookup.set(sid, metadata);
        }
      }
    }
  };
  
  if (flowchart) {
    processChart(flowchart, 'Flowchart');
    logger.info(`Processed Flowchart`);
  }
  
  if (processFlowchart) {
    processChart(processFlowchart, 'ProcessFlowchart');
    logger.info(`Processed ProcessFlowchart`);
  }
  
  // Step 4: Match scopeIdentifiers to metadata
  for (const sid of scopeIdentifiers) {
    const metadata = scopeLookup.get(sid);
    
    if (metadata) {
      metadataMap.set(sid, metadata);
    } else {
      logger.warn(`No flowchart metadata found for scopeIdentifier: ${sid}`);
      
      const sample = await DataEntry.findOne({ clientId, scopeIdentifier: sid }).lean();
      
      if (sample) {
        metadataMap.set(sid, {
          scopeIdentifier: sid,
          scopeType: sample.scopeType,
          categoryName: sample.categoryName || null,
          activity: sample.activity || null,
          nodeId: sample.nodeId,
          nodeLabel: sample.nodeId,
          department: sample.department || null,
          location: sample.location || null,
          source: 'DataEntry'
        });
      }
    }
  }
  
  logger.success(`Built enhanced metadata map with ${metadataMap.size} scopeIdentifiers`);
  
  const bySource = {};
  for (const meta of metadataMap.values()) {
    bySource[meta.source] = (bySource[meta.source] || 0) + 1;
  }
  logger.info(`Metadata sources: ${JSON.stringify(bySource)}`);
  
  return metadataMap;
}

// ============================================================================
// EMISSION SUMMARY REBUILDING
// ============================================================================

function createEmissionStructure() {
  return {
    CO2e: 0,
    CO2: 0,
    CH4: 0,
    N2O: 0,
    uncertainty: 0,
    dataPointCount: 0
  };
}

function rebuildByCategory(summary, metadataMap, logger) {
  const emissionSummary = summary.emissionSummary || summary;
  const newByCategory = {};
  
  const allScopeIds = new Set();
  
  const activityEntries = emissionSummary.byActivity instanceof Map
    ? Array.from(emissionSummary.byActivity.entries())
    : Object.entries(emissionSummary.byActivity || {});
  
  for (const [key, data] of activityEntries) {
    if (metadataMap.has(key)) {
      allScopeIds.add(key);
    }
  }
  
  for (const sid of allScopeIds) {
    const metadata = metadataMap.get(sid);
    if (!metadata) continue;
    
    const categoryName = metadata.categoryName || 'Unknown Category';
    const activityName = metadata.activity || sid;
    
    const activityData = emissionSummary.byActivity instanceof Map
      ? emissionSummary.byActivity.get(sid)
      : emissionSummary.byActivity?.[sid];
    
    if (!activityData) continue;
    
    if (!newByCategory[categoryName]) {
      newByCategory[categoryName] = {
        ...createEmissionStructure(),
        scopeType: metadata.scopeType,
        activities: {}
      };
    }
    
    const category = newByCategory[categoryName];
    category.CO2e += activityData.CO2e || 0;
    category.CO2 += activityData.CO2 || 0;
    category.CH4 += activityData.CH4 || 0;
    category.N2O += activityData.N2O || 0;
    category.uncertainty += activityData.uncertainty || 0;
    category.dataPointCount += activityData.dataPointCount || 0;
    
    if (!category.activities[activityName]) {
      category.activities[activityName] = createEmissionStructure();
    }
    
    const activity = category.activities[activityName];
    activity.CO2e += activityData.CO2e || 0;
    activity.CO2 += activityData.CO2 || 0;
    activity.CH4 += activityData.CH4 || 0;
    activity.N2O += activityData.N2O || 0;
    activity.uncertainty += activityData.uncertainty || 0;
    activity.dataPointCount += activityData.dataPointCount || 0;
  }
  
  return newByCategory;
}

function rebuildByActivity(summary, metadataMap, logger) {
  const emissionSummary = summary.emissionSummary || summary;
  const newByActivity = {};
  
  const entries = emissionSummary.byActivity instanceof Map
    ? Array.from(emissionSummary.byActivity.entries())
    : Object.entries(emissionSummary.byActivity || {});
  
  for (const [key, data] of entries) {
    if (!data) continue;
    
    const metadata = metadataMap.get(key);
    const activityName = metadata?.activity || key;
    const categoryName = metadata?.categoryName || data.categoryName || 'Unknown Category';
    const scopeType = metadata?.scopeType || data.scopeType;
    
    if (!newByActivity[activityName]) {
      newByActivity[activityName] = {
        ...createEmissionStructure(),
        scopeType,
        categoryName
      };
    }
    
    const activity = newByActivity[activityName];
    activity.CO2e += data.CO2e || 0;
    activity.CO2 += data.CO2 || 0;
    activity.CH4 += data.CH4 || 0;
    activity.N2O += data.N2O || 0;
    activity.uncertainty += data.uncertainty || 0;
    activity.dataPointCount += data.dataPointCount || 0;
  }
  
  return newByActivity;
}

function rebuildByDimension(summary, metadataMap, dimensionKey, logger) {
  const emissionSummary = summary.emissionSummary || summary;
  const newByDimension = {};
  
  const dimensionGroups = new Map();
  
  for (const metadata of metadataMap.values()) {
    const dimensionValue = metadata[dimensionKey];
    if (!dimensionValue || dimensionValue === 'Unknown') continue;
    
    if (!dimensionGroups.has(dimensionValue)) {
      dimensionGroups.set(dimensionValue, {
        ...createEmissionStructure(),
        nodeCount: 0,
        nodes: new Set()
      });
    }
  }
  
  const byNode = emissionSummary.byNode instanceof Map
    ? emissionSummary.byNode
    : new Map(Object.entries(emissionSummary.byNode || {}));
  
  for (const [nodeId, nodeData] of byNode) {
    if (!nodeData) continue;
    
    let dimensionValue = null;
    
    for (const metadata of metadataMap.values()) {
      if (metadata.nodeId === nodeId) {
        dimensionValue = metadata[dimensionKey];
        break;
      }
    }
    
    if (!dimensionValue || dimensionValue === 'Unknown') {
      dimensionValue = nodeData[dimensionKey] || 'Unknown';
    }
    
    if (!dimensionGroups.has(dimensionValue)) {
      dimensionGroups.set(dimensionValue, {
        ...createEmissionStructure(),
        nodeCount: 0,
        nodes: new Set()
      });
    }
    
    const group = dimensionGroups.get(dimensionValue);
    group.CO2e += nodeData.CO2e || 0;
    group.CO2 += nodeData.CO2 || 0;
    group.CH4 += nodeData.CH4 || 0;
    group.N2O += nodeData.N2O || 0;
    group.uncertainty += nodeData.uncertainty || 0;
    group.dataPointCount += nodeData.dataPointCount || 0;
    group.nodes.add(nodeId);
  }
  
  for (const [dimensionValue, data] of dimensionGroups) {
    newByDimension[dimensionValue] = {
      CO2e: data.CO2e,
      CO2: data.CO2,
      CH4: data.CH4,
      N2O: data.N2O,
      uncertainty: data.uncertainty,
      dataPointCount: data.dataPointCount,
      nodeCount: data.nodes.size
    };
  }
  
  return newByDimension;
}

function enhancedRebuildEmissionSummary(summary, metadataMap, logger) {
  const rebuilt = {
    byCategory: rebuildByCategory(summary, metadataMap, logger),
    byActivity: rebuildByActivity(summary, metadataMap, logger),
    byDepartment: rebuildByDimension(summary, metadataMap, 'department', logger),
    byLocation: rebuildByDimension(summary, metadataMap, 'location', logger)
  };
  
  const emissionSummary = summary.emissionSummary || summary;
  rebuilt.byNode = emissionSummary.byNode;
  
  return rebuilt;
}

// ============================================================================
// PROCESSING
// ============================================================================

async function processEnhancedSummary(summary, metadataMap, logger, dryRun) {
  try {
    const summaryId = summary._id.toString();
    const period = summary.period?.type || 'unknown';
    const periodStr = `${period}-${summary.period?.year || '?'}`;
    
    logger.info(`Processing summary ${summaryId} (${periodStr})`);
    
    const rebuilt = enhancedRebuildEmissionSummary(summary, metadataMap, logger);
    
    const categoriesFound = Object.keys(rebuilt.byCategory).filter(c => c !== 'Unknown Category');
    const activitiesFound = Object.keys(rebuilt.byActivity).filter(a => a !== 'Unknown Activity');
    const departmentsFound = Object.keys(rebuilt.byDepartment).filter(d => d !== 'Unknown');
    const locationsFound = Object.keys(rebuilt.byLocation).filter(l => l !== 'Unknown');
    
    logger.info(`  Categories: ${categoriesFound.length} (${categoriesFound.join(', ') || 'none'})`);
    logger.info(`  Activities: ${activitiesFound.length}`);
    logger.info(`  Departments: ${departmentsFound.length} (${departmentsFound.join(', ') || 'none'})`);
    logger.info(`  Locations: ${locationsFound.length} (${locationsFound.join(', ') || 'none'})`);
    
    const currentEmissionSummary = summary.emissionSummary || summary;
    const currentCategories = Object.keys(currentEmissionSummary.byCategory || {});
    const currentDepartments = Object.keys(currentEmissionSummary.byDepartment || {});
    
    const improved = 
      categoriesFound.length > currentCategories.filter(c => c !== 'Unknown Category').length ||
      departmentsFound.length > currentDepartments.filter(d => d !== 'Unknown').length;
    
    if (!improved) {
      logger.info(`  No improvements found - skipping`);
      return { updated: false, summaryId };
    }
    
    if (dryRun) {
      logger.info(`  [DRY RUN] Would update this summary`);
      return { updated: false, summaryId, dryRun: true, improved: true };
    }
    
    const updateData = {};
    
    if (summary.emissionSummary) {
      updateData['emissionSummary.byCategory'] = rebuilt.byCategory;
      updateData['emissionSummary.byActivity'] = rebuilt.byActivity;
      updateData['emissionSummary.byDepartment'] = rebuilt.byDepartment;
      updateData['emissionSummary.byLocation'] = rebuilt.byLocation;
      updateData['emissionSummary.metadata.migratedData'] = true;
      updateData['emissionSummary.metadata.preventAutoRecalculation'] = true;
    } else {
      updateData.byCategory = rebuilt.byCategory;
      updateData.byActivity = rebuilt.byActivity;
      updateData.byDepartment = rebuilt.byDepartment;
      updateData.byLocation = rebuilt.byLocation;
      updateData['metadata.migratedData'] = true;
      updateData['metadata.preventAutoRecalculation'] = true;
    }
    
    await EmissionSummary.findByIdAndUpdate(summary._id, { $set: updateData }, { new: false });
    
    logger.success(`  ✅ Updated summary ${summaryId}`);
    
    return { updated: true, summaryId, improved: true };
    
  } catch (error) {
    logger.error(`  ❌ Error processing summary: ${error.message}`);
    return { updated: false, summaryId: summary._id.toString(), error: error.message };
  }
}

async function processEnhancedClient(clientId, checkpointMgr, logger, config) {
  logger.info(`\n${'='.repeat(80)}`);
  logger.info(`Processing client (ENHANCED): ${clientId}`);
  logger.info(`${'='.repeat(80)}\n`);
  
  const metadataMap = await buildEnhancedMetadataMap(clientId, logger);
  
  if (metadataMap.size === 0) {
    logger.warn(`No metadata found for client ${clientId} - skipping`);
    return { clientId, processed: 0, updated: 0, errors: 0 };
  }
  
  const summaries = await EmissionSummary.find({ clientId }).lean();
  logger.info(`Found ${summaries.length} summaries for ${clientId}\n`);
  
  let processed = 0;
  let updated = 0;
  let errors = 0;
  
  for (const summary of summaries) {
    const summaryId = summary._id.toString();
    
    if (checkpointMgr.isSummaryProcessed(summaryId)) {
      logger.info(`Summary ${summaryId} already processed - skipping`);
      continue;
    }
    
    const result = await processEnhancedSummary(summary, metadataMap, logger, config.DRY_RUN);
    
    processed++;
    if (result.updated) updated++;
    if (result.error) errors++;
    
    checkpointMgr.markSummaryProcessed(summaryId);
    
    if (processed % 5 === 0) {
      logger.info(`\nProgress: ${processed}/${summaries.length} summaries processed\n`);
    }
  }
  
  checkpointMgr.markClientProcessed(clientId);
  
  logger.success(`\nClient ${clientId} complete: ${processed} processed, ${updated} updated, ${errors} errors\n`);
  
  return { clientId, processed, updated, errors };
}

async function runEnhancedMigration(config) {
  const logger = new Logger(config.LOG_FILE, config.VERBOSE);
  const checkpointMgr = new CheckpointManager(config.CHECKPOINT_FILE);
  
  logger.info('\n' + '='.repeat(80));
  logger.info('ENHANCED EMISSION SUMMARY METADATA FIX MIGRATION');
  logger.info('='.repeat(80));
  logger.info(`Mode: ${config.DRY_RUN ? 'DRY RUN' : 'LIVE UPDATE'}`);
  logger.info(`Started: ${new Date().toISOString()}`);
  logger.info('='.repeat(80) + '\n');
  
  try {
    await mongoose.connect(config.MONGO_URI);
    
    logger.success('Connected to MongoDB\n');
    
    const clientIds = await EmissionSummary.distinct('clientId');
    logger.info(`Found ${clientIds.length} unique clients\n`);
    
    const results = {
      clients: [],
      totalProcessed: 0,
      totalUpdated: 0,
      totalErrors: 0
    };
    
    for (const clientId of clientIds) {
      if (checkpointMgr.isClientProcessed(clientId)) {
        logger.info(`Client ${clientId} already processed - skipping\n`);
        continue;
      }
      
      const result = await processEnhancedClient(clientId, checkpointMgr, logger, config);
      
      results.clients.push(result);
      results.totalProcessed += result.processed;
      results.totalUpdated += result.updated;
      results.totalErrors += result.errors;
    }
    
    logger.info('\n' + '='.repeat(80));
    logger.info('ENHANCED MIGRATION COMPLETE');
    logger.info('='.repeat(80));
    logger.info(`Mode: ${config.DRY_RUN ? 'DRY RUN' : 'LIVE UPDATE'}`);
    logger.info(`Clients Processed: ${results.clients.length}`);
    logger.info(`Total Summaries: ${results.totalProcessed}`);
    logger.info(`Total Updated: ${results.totalUpdated}`);
    logger.info(`Total Errors: ${results.totalErrors}`);
    logger.info(`Completed: ${new Date().toISOString()}`);
    logger.info('='.repeat(80) + '\n');
    
    const resultsFile = path.join(__dirname, 'emission_summary_enhanced_results.json');
    fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2), 'utf8');
    logger.success(`Results saved to: ${resultsFile}`);
    
  } catch (error) {
    logger.error(`\nMigration failed: ${error.message}`);
    logger.error(error.stack);
    throw error;
  } finally {
    logger.close();
    await mongoose.connection.close();
  }
}

// ============================================================================
// CLI
// ============================================================================

if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.includes('--live')) {
    CONFIG.DRY_RUN = false;
  }
  
  if (args.includes('--reset')) {
    const checkpointMgr = new CheckpointManager(CONFIG.CHECKPOINT_FILE);
    checkpointMgr.clear();
    console.log('Checkpoint cleared');
  }
  
  if (args.includes('--help')) {
    console.log(`
Enhanced Emission Summary Metadata Fix Migration

Usage:
  node fixEmissionSummaryUnknowns_Enhanced_Standalone.js [options]

Options:
  --live          Run in live mode (default is dry-run)
  --reset         Clear checkpoint and start fresh
  --help          Show this help message
`);
    process.exit(0);
  }
  
  runEnhancedMigration(CONFIG)
    .then(() => {
      console.log('\n✅ Enhanced migration completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Enhanced migration failed:', error);
      process.exit(1);
    });
}

module.exports = { runEnhancedMigration, CONFIG };