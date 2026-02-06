/**
 * ============================================================================
 * EMISSION SUMMARY METADATA FIX MIGRATION
 * ============================================================================
 * 
 * PURPOSE:
 * Fix EmissionSummary documents showing "Unknown Category", "Unknown Activity",
 * "Unknown" department/location by mapping scopeIdentifiers to actual flowchart data.
 * 
 * ROOT CAUSE:
 * - DataEntry records have old nodeIds (e.g., "codenestsolutio-node-b9308b")
 * - Flowcharts were updated with new nodeIds (e.g., "greon017-node-cdec7a")
 * - Emission calculation can't find nodes, defaults to "Unknown"
 * 
 * SOLUTION:
 * - Use scopeIdentifier as the common key
 * - Build metadata map from Flowchart + ProcessFlowchart
 * - Rebuild byCategory, byActivity, byDepartment, byLocation with correct names
 * - Preserve all emission values (CO2e, CO2, CH4, N2O, etc.)
 * 
 * SAFETY:
 * - Dry-run mode by default
 * - Comprehensive logging
 * - Checkpoint system for resuming
 * - No data loss - only metadata correction
 * 
 * ============================================================================
 */

const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // MongoDB connection
  MONGO_URI: process.env.MONGO_URI || 'mongodb+srv://zerocarbon:zerocarbon@zerocarbon.ujopg7s.mongodb.net/zeroCarbon',
  
  // Processing options
  DRY_RUN: true,  // Set to false to actually update database
  BATCH_SIZE: 50,  // Process summaries in batches
  
  // Checkpoint file for resuming
  CHECKPOINT_FILE: path.join(__dirname, '.emission_summary_migration_checkpoint.json'),
  
  // Logging
  LOG_FILE: path.join(__dirname, 'emission_summary_migration.log'),
  VERBOSE: true
};

// ============================================================================
// MODELS
// ============================================================================

const EmissionSummary = require('./models/CalculationEmission/EmissionSummary');
const Flowchart = require('./models/Organization/Flowchart');
const ProcessFlowchart = require('./models/Organization/ProcessFlowchart');

// ============================================================================
// LOGGING UTILITIES
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

  error(message) {
    this.log(message, 'ERROR');
  }

  warn(message) {
    this.log(message, 'WARN');
  }

  success(message) {
    this.log(message, 'SUCCESS');
  }

  info(message) {
    this.log(message, 'INFO');
  }

  close() {
    this.stream.end();
  }
}

// ============================================================================
// CHECKPOINT SYSTEM
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
      fs.writeFileSync(
        this.checkpointFile,
        JSON.stringify(this.checkpoint, null, 2),
        'utf8'
      );
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

/**
 * Extract scopeIdentifier metadata from a flowchart
 */
function extractFlowchartMetadata(flowchart, logger) {
  const metadataMap = new Map(); // scopeIdentifier -> metadata
  
  if (!flowchart || !Array.isArray(flowchart.nodes)) {
    return metadataMap;
  }

  for (const node of flowchart.nodes) {
    const nodeId = node.id;
    const nodeLabel = node.label || 'Unknown Node';
    const department = node.details?.department || null;
    const location = node.details?.location || null;
    
    const scopeDetails = node.details?.scopeDetails || [];
    
    for (const scope of scopeDetails) {
      if (scope.isDeleted) continue;
      
      const scopeIdentifier = scope.scopeIdentifier;
      if (!scopeIdentifier) continue;
      
      const metadata = {
        scopeIdentifier,
        scopeType: scope.scopeType,
        categoryName: scope.categoryName || null,
        activity: scope.activity || null,
        nodeId,
        nodeLabel,
        department,
        location,
        source: flowchart.constructor.modelName // 'Flowchart' or 'ProcessFlowchart'
      };
      
      // Prefer entries with more complete data
      if (!metadataMap.has(scopeIdentifier) || 
          (metadata.categoryName && metadata.activity)) {
        metadataMap.set(scopeIdentifier, metadata);
      }
    }
  }
  
  logger.info(`Extracted metadata for ${metadataMap.size} scopeIdentifiers from ${flowchart.constructor.modelName}`);
  
  return metadataMap;
}

/**
 * Build complete metadata map for a client
 */
async function buildClientMetadataMap(clientId, logger) {
  logger.info(`Building metadata map for client: ${clientId}`);
  
  const metadataMap = new Map();
  
  // Load Flowchart
  const flowchart = await Flowchart.findOne({ 
    clientId, 
    isActive: true 
  }).lean();
  
  if (flowchart) {
    const flowchartMetadata = extractFlowchartMetadata(flowchart, logger);
    for (const [key, value] of flowchartMetadata) {
      metadataMap.set(key, value);
    }
  } else {
    logger.warn(`No active Flowchart found for ${clientId}`);
  }
  
  // Load ProcessFlowchart
  const processFlowchart = await ProcessFlowchart.findOne({ 
    clientId, 
    isDeleted: false 
  }).lean();
  
  if (processFlowchart) {
    const processMetadata = extractFlowchartMetadata(processFlowchart, logger);
    // ProcessFlowchart data takes precedence if it has more complete info
    for (const [key, value] of processMetadata) {
      const existing = metadataMap.get(key);
      if (!existing || (value.categoryName && value.activity)) {
        metadataMap.set(key, value);
      }
    }
  } else {
    logger.warn(`No ProcessFlowchart found for ${clientId}`);
  }
  
  logger.success(`Built metadata map with ${metadataMap.size} scopeIdentifiers for ${clientId}`);
  
  return metadataMap;
}

// ============================================================================
// EMISSION SUMMARY REBUILDING
// ============================================================================

/**
 * Helper to ensure default emission structure
 */
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

/**
 * Rebuild byCategory with correct names
 */
function rebuildByCategory(oldByCategory, metadataMap, logger) {
  const newByCategory = {};
  
  // Handle both Map and Object formats
  const entries = oldByCategory instanceof Map 
    ? Array.from(oldByCategory.entries())
    : Object.entries(oldByCategory || {});
  
  for (const [oldKey, categoryData] of entries) {
    // Skip if no data
    if (!categoryData || typeof categoryData !== 'object') continue;
    
    // Try to find correct category name from activities
    let correctCategoryName = oldKey;
    let foundMetadata = false;
    
    // Check activities to find scopeIdentifier
    const activities = categoryData.activities instanceof Map
      ? Array.from(categoryData.activities.entries())
      : Object.entries(categoryData.activities || {});
    
    for (const [activityKey, activityData] of activities) {
      // The activity key might be a scopeIdentifier or activity name
      // Try both as keys in metadataMap
      let metadata = metadataMap.get(activityKey);
      
      if (metadata && metadata.categoryName) {
        correctCategoryName = metadata.categoryName;
        foundMetadata = true;
        break;
      }
    }
    
    // Initialize category entry
    if (!newByCategory[correctCategoryName]) {
      newByCategory[correctCategoryName] = {
        ...createEmissionStructure(),
        scopeType: categoryData.scopeType,
        activities: {}
      };
    }
    
    // Add emission values
    const category = newByCategory[correctCategoryName];
    category.CO2e += categoryData.CO2e || 0;
    category.CO2 += categoryData.CO2 || 0;
    category.CH4 += categoryData.CH4 || 0;
    category.N2O += categoryData.N2O || 0;
    category.uncertainty += categoryData.uncertainty || 0;
    category.dataPointCount += categoryData.dataPointCount || 0;
    
    // Rebuild activities
    for (const [activityKey, activityData] of activities) {
      if (!activityData || typeof activityData !== 'object') continue;
      
      let correctActivityName = activityKey;
      const metadata = metadataMap.get(activityKey);
      
      if (metadata && metadata.activity) {
        correctActivityName = metadata.activity;
      }
      
      if (!category.activities[correctActivityName]) {
        category.activities[correctActivityName] = createEmissionStructure();
      }
      
      const activity = category.activities[correctActivityName];
      activity.CO2e += activityData.CO2e || 0;
      activity.CO2 += activityData.CO2 || 0;
      activity.CH4 += activityData.CH4 || 0;
      activity.N2O += activityData.N2O || 0;
      activity.uncertainty += activityData.uncertainty || 0;
      activity.dataPointCount += activityData.dataPointCount || 0;
    }
  }
  
  return newByCategory;
}

/**
 * Rebuild byActivity with correct names
 */
function rebuildByActivity(oldByActivity, metadataMap, logger) {
  const newByActivity = {};
  
  const entries = oldByActivity instanceof Map
    ? Array.from(oldByActivity.entries())
    : Object.entries(oldByActivity || {});
  
  for (const [oldKey, activityData] of entries) {
    if (!activityData || typeof activityData !== 'object') continue;
    
    let correctActivityName = oldKey;
    let correctCategoryName = activityData.categoryName || 'Unknown Category';
    
    // Try to find metadata
    const metadata = metadataMap.get(oldKey);
    if (metadata) {
      if (metadata.activity) correctActivityName = metadata.activity;
      if (metadata.categoryName) correctCategoryName = metadata.categoryName;
    }
    
    if (!newByActivity[correctActivityName]) {
      newByActivity[correctActivityName] = {
        ...createEmissionStructure(),
        scopeType: activityData.scopeType,
        categoryName: correctCategoryName
      };
    }
    
    const activity = newByActivity[correctActivityName];
    activity.CO2e += activityData.CO2e || 0;
    activity.CO2 += activityData.CO2 || 0;
    activity.CH4 += activityData.CH4 || 0;
    activity.N2O += activityData.N2O || 0;
    activity.uncertainty += activityData.uncertainty || 0;
    activity.dataPointCount += activityData.dataPointCount || 0;
  }
  
  return newByActivity;
}

/**
 * Rebuild byNode with correct metadata
 */
function rebuildByNode(oldByNode, metadataMap, logger) {
  const newByNode = {};
  
  const entries = oldByNode instanceof Map
    ? Array.from(oldByNode.entries())
    : Object.entries(oldByNode || {});
  
  for (const [nodeId, nodeData] of entries) {
    if (!nodeData || typeof nodeData !== 'object') continue;
    
    let correctNodeLabel = nodeData.nodeLabel || nodeId;
    let correctDepartment = nodeData.department || 'Unknown';
    let correctLocation = nodeData.location || 'Unknown';
    
    // Try to find metadata from any scopeIdentifier in this node
    // We don't have scopeIdentifier at node level, so use existing data
    // unless we can infer from department/location patterns
    
    if (!newByNode[nodeId]) {
      newByNode[nodeId] = {
        ...createEmissionStructure(),
        nodeLabel: correctNodeLabel,
        department: correctDepartment,
        location: correctLocation,
        byScope: {
          'Scope 1': createEmissionStructure(),
          'Scope 2': createEmissionStructure(),
          'Scope 3': createEmissionStructure()
        }
      };
    }
    
    const node = newByNode[nodeId];
    node.CO2e += nodeData.CO2e || 0;
    node.CO2 += nodeData.CO2 || 0;
    node.CH4 += nodeData.CH4 || 0;
    node.N2O += nodeData.N2O || 0;
    node.uncertainty += nodeData.uncertainty || 0;
    node.dataPointCount += nodeData.dataPointCount || 0;
    
    // Update byScope
    const byScope = nodeData.byScope || {};
    for (const scopeType of ['Scope 1', 'Scope 2', 'Scope 3']) {
      const scopeData = byScope[scopeType];
      if (scopeData && typeof scopeData === 'object') {
        node.byScope[scopeType].CO2e += scopeData.CO2e || 0;
        node.byScope[scopeType].CO2 += scopeData.CO2 || 0;
        node.byScope[scopeType].CH4 += scopeData.CH4 || 0;
        node.byScope[scopeType].N2O += scopeData.N2O || 0;
        node.byScope[scopeType].uncertainty += scopeData.uncertainty || 0;
        node.byScope[scopeType].dataPointCount += scopeData.dataPointCount || 0;
      }
    }
  }
  
  return newByNode;
}

/**
 * Rebuild byDepartment/byLocation with correct names
 */
function rebuildByDimension(oldByDimension, dimensionKey, metadataMap, logger) {
  const newByDimension = {};
  
  const entries = oldByDimension instanceof Map
    ? Array.from(oldByDimension.entries())
    : Object.entries(oldByDimension || {});
  
  for (const [oldKey, dimensionData] of entries) {
    if (!dimensionData || typeof dimensionData !== 'object') continue;
    
    let correctKey = oldKey;
    
    // Try to find correct name from metadata
    // Since we don't have direct scopeIdentifier mapping here,
    // we'll use the existing key unless it's "Unknown"
    if (oldKey === 'Unknown') {
      // Try to find first non-null value from metadataMap
      for (const metadata of metadataMap.values()) {
        if (metadata[dimensionKey] && metadata[dimensionKey] !== 'Unknown') {
          correctKey = metadata[dimensionKey];
          break;
        }
      }
    }
    
    if (!newByDimension[correctKey]) {
      newByDimension[correctKey] = {
        ...createEmissionStructure(),
        nodeCount: dimensionData.nodeCount || 0
      };
    }
    
    const dimension = newByDimension[correctKey];
    dimension.CO2e += dimensionData.CO2e || 0;
    dimension.CO2 += dimensionData.CO2 || 0;
    dimension.CH4 += dimensionData.CH4 || 0;
    dimension.N2O += dimensionData.N2O || 0;
    dimension.uncertainty += dimensionData.uncertainty || 0;
    dimension.dataPointCount += dimensionData.dataPointCount || 0;
  }
  
  return newByDimension;
}

/**
 * Rebuild emission summary with correct metadata
 */
function rebuildEmissionSummary(summary, metadataMap, logger) {
  const emissionSummary = summary.emissionSummary || summary;
  
  const rebuilt = {
    byCategory: rebuildByCategory(emissionSummary.byCategory, metadataMap, logger),
    byActivity: rebuildByActivity(emissionSummary.byActivity, metadataMap, logger),
    byNode: rebuildByNode(emissionSummary.byNode, metadataMap, logger),
    byDepartment: rebuildByDimension(emissionSummary.byDepartment, 'department', metadataMap, logger),
    byLocation: rebuildByDimension(emissionSummary.byLocation, 'location', metadataMap, logger)
  };
  
  return rebuilt;
}

// ============================================================================
// MIGRATION MAIN LOGIC
// ============================================================================

/**
 * Process a single emission summary
 */
async function processSummary(summary, metadataMap, logger, dryRun) {
  try {
    const summaryId = summary._id.toString();
    
    // Rebuild metadata
    const rebuilt = rebuildEmissionSummary(summary, metadataMap, logger);
    
    // Determine if changes are needed
    const hasChanges = 
      JSON.stringify(rebuilt.byCategory) !== JSON.stringify(summary.emissionSummary?.byCategory || summary.byCategory) ||
      JSON.stringify(rebuilt.byActivity) !== JSON.stringify(summary.emissionSummary?.byActivity || summary.byActivity) ||
      JSON.stringify(rebuilt.byDepartment) !== JSON.stringify(summary.emissionSummary?.byDepartment || summary.byDepartment) ||
      JSON.stringify(rebuilt.byLocation) !== JSON.stringify(summary.emissionSummary?.byLocation || summary.byLocation);
    
    if (!hasChanges) {
      logger.info(`Summary ${summaryId} - No changes needed`);
      return { updated: false, summaryId };
    }
    
    if (dryRun) {
      logger.info(`[DRY RUN] Would update summary ${summaryId}`);
      return { updated: false, summaryId, dryRun: true };
    }
    
    // Update the summary
    const updateData = {};
    
    // Update nested emissionSummary if it exists
    if (summary.emissionSummary) {
      updateData['emissionSummary.byCategory'] = rebuilt.byCategory;
      updateData['emissionSummary.byActivity'] = rebuilt.byActivity;
      updateData['emissionSummary.byNode'] = rebuilt.byNode;
      updateData['emissionSummary.byDepartment'] = rebuilt.byDepartment;
      updateData['emissionSummary.byLocation'] = rebuilt.byLocation;
      updateData['emissionSummary.metadata.migratedData'] = true;
      updateData['emissionSummary.metadata.preventAutoRecalculation'] = true;
    } else {
      // Update root-level fields for backward compatibility
      updateData.byCategory = rebuilt.byCategory;
      updateData.byActivity = rebuilt.byActivity;
      updateData.byNode = rebuilt.byNode;
      updateData.byDepartment = rebuilt.byDepartment;
      updateData.byLocation = rebuilt.byLocation;
      updateData['metadata.migratedData'] = true;
      updateData['metadata.preventAutoRecalculation'] = true;
    }
    
    await EmissionSummary.findByIdAndUpdate(
      summary._id,
      { $set: updateData },
      { new: false }
    );
    
    logger.success(`Updated summary ${summaryId}`);
    
    return { updated: true, summaryId };
    
  } catch (error) {
    logger.error(`Error processing summary ${summary._id}: ${error.message}`);
    return { updated: false, summaryId: summary._id.toString(), error: error.message };
  }
}

/**
 * Process all summaries for a client
 */
async function processClient(clientId, checkpointMgr, logger, config) {
  logger.info(`\n${'='.repeat(80)}`);
  logger.info(`Processing client: ${clientId}`);
  logger.info(`${'='.repeat(80)}\n`);
  
  // Build metadata map
  const metadataMap = await buildClientMetadataMap(clientId, logger);
  
  if (metadataMap.size === 0) {
    logger.warn(`No metadata found for client ${clientId} - skipping`);
    return { clientId, processed: 0, updated: 0, errors: 0 };
  }
  
  // Find all summaries for this client
  const summaries = await EmissionSummary.find({ clientId }).lean();
  
  logger.info(`Found ${summaries.length} summaries for ${clientId}`);
  
  let processed = 0;
  let updated = 0;
  let errors = 0;
  
  // Process in batches
  for (let i = 0; i < summaries.length; i += config.BATCH_SIZE) {
    const batch = summaries.slice(i, i + config.BATCH_SIZE);
    
    logger.info(`Processing batch ${Math.floor(i / config.BATCH_SIZE) + 1}/${Math.ceil(summaries.length / config.BATCH_SIZE)}`);
    
    for (const summary of batch) {
      const summaryId = summary._id.toString();
      
      // Skip if already processed
      if (checkpointMgr.isSummaryProcessed(summaryId)) {
        logger.info(`Summary ${summaryId} already processed - skipping`);
        continue;
      }
      
      const result = await processSummary(summary, metadataMap, logger, config.DRY_RUN);
      
      processed++;
      if (result.updated) updated++;
      if (result.error) errors++;
      
      checkpointMgr.markSummaryProcessed(summaryId);
      
      // Progress log every 10 summaries
      if (processed % 10 === 0) {
        logger.info(`Progress: ${processed}/${summaries.length} summaries processed`);
      }
    }
  }
  
  checkpointMgr.markClientProcessed(clientId);
  
  logger.success(`\nClient ${clientId} complete: ${processed} processed, ${updated} updated, ${errors} errors\n`);
  
  return { clientId, processed, updated, errors };
}

/**
 * Main migration function
 */
async function runMigration(config) {
  const logger = new Logger(config.LOG_FILE, config.VERBOSE);
  const checkpointMgr = new CheckpointManager(config.CHECKPOINT_FILE);
  
  logger.info('\n' + '='.repeat(80));
  logger.info('EMISSION SUMMARY METADATA FIX MIGRATION');
  logger.info('='.repeat(80));
  logger.info(`Mode: ${config.DRY_RUN ? 'DRY RUN' : 'LIVE UPDATE'}`);
  logger.info(`Batch Size: ${config.BATCH_SIZE}`);
  logger.info(`Started: ${new Date().toISOString()}`);
  logger.info('='.repeat(80) + '\n');
  
  try {
    // Connect to MongoDB
    await mongoose.connect(config.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    
    logger.success('Connected to MongoDB\n');
    
    // Get all unique clientIds
    const clientIds = await EmissionSummary.distinct('clientId');
    
    logger.info(`Found ${clientIds.length} unique clients\n`);
    
    const results = {
      clients: [],
      totalProcessed: 0,
      totalUpdated: 0,
      totalErrors: 0
    };
    
    // Process each client
    for (const clientId of clientIds) {
      // Skip if already processed
      if (checkpointMgr.isClientProcessed(clientId)) {
        logger.info(`Client ${clientId} already processed - skipping\n`);
        continue;
      }
      
      const result = await processClient(clientId, checkpointMgr, logger, config);
      
      results.clients.push(result);
      results.totalProcessed += result.processed;
      results.totalUpdated += result.updated;
      results.totalErrors += result.errors;
    }
    
    // Final summary
    logger.info('\n' + '='.repeat(80));
    logger.info('MIGRATION COMPLETE');
    logger.info('='.repeat(80));
    logger.info(`Mode: ${config.DRY_RUN ? 'DRY RUN' : 'LIVE UPDATE'}`);
    logger.info(`Clients Processed: ${results.clients.length}`);
    logger.info(`Total Summaries Processed: ${results.totalProcessed}`);
    logger.info(`Total Summaries Updated: ${results.totalUpdated}`);
    logger.info(`Total Errors: ${results.totalErrors}`);
    logger.info(`Completed: ${new Date().toISOString()}`);
    logger.info('='.repeat(80) + '\n');
    
    // Save final results
    const resultsFile = path.join(__dirname, 'emission_summary_migration_results.json');
    fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2), 'utf8');
    logger.success(`Results saved to: ${resultsFile}`);
    
  } catch (error) {
    logger.error(`\nMigration failed: ${error.message}`);
    logger.error(error.stack);
    throw error;
  } finally {
    logger.close();
    await mongoose.connection.close();
    logger.info('Database connection closed');
  }
}

// ============================================================================
// COMMAND LINE INTERFACE
// ============================================================================

if (require.main === module) {
  const args = process.argv.slice(2);
  
  // Parse command line arguments
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
Emission Summary Metadata Fix Migration

Usage:
  node fixEmissionSummaryUnknowns.js [options]

Options:
  --live          Run in live mode (default is dry-run)
  --reset         Clear checkpoint and start fresh
  --help          Show this help message

Examples:
  # Dry run (safe, no changes)
  node fixEmissionSummaryUnknowns.js

  # Live update
  node fixEmissionSummaryUnknowns.js --live

  # Reset and start fresh
  node fixEmissionSummaryUnknowns.js --reset --live
`);
    process.exit(0);
  }
  
  // Run migration
  runMigration(CONFIG)
    .then(() => {
      console.log('\n✅ Migration completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Migration failed:', error);
      process.exit(1);
    });
}

module.exports = { runMigration, CONFIG };