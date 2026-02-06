/**
 * ============================================================================
 * EMISSION SUMMARY BACKUP SCRIPT
 * ============================================================================
 * 
 * PURPOSE: Create periodic backups of EmissionSummary collection to prevent
 *          data loss in case of accidental deletion
 * 
 * USAGE:
 *   node backup-emission-summaries.js
 * 
 * FEATURES:
 *   - Creates timestamped backup files
 *   - Compresses data to save space
 *   - Supports full and incremental backups
 *   - Includes restoration function
 * 
 * ============================================================================
 */

require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const EmissionSummary = require('../models/CalculationEmission/EmissionSummary');

// ============================================================================
// CONFIGURATION
// ============================================================================

const BACKUP_CONFIG = {
  BACKUP_DIR: './backups/emission-summaries',
  COMPRESS: true,
  INCLUDE_METADATA: true,
  MAX_BACKUPS_TO_KEEP: 10, // Keep last 10 backups
  BACKUP_NAME_PREFIX: 'emission-summaries-backup'
};

// ============================================================================
// BACKUP FUNCTIONS
// ============================================================================

/**
 * Ensure backup directory exists
 */
function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_CONFIG.BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_CONFIG.BACKUP_DIR, { recursive: true });
    console.log(`✅ Created backup directory: ${BACKUP_CONFIG.BACKUP_DIR}`);
  }
}

/**
 * Generate backup filename
 */
function getBackupFilename(type = 'full') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ext = BACKUP_CONFIG.COMPRESS ? '.json.gz' : '.json';
  return `${BACKUP_CONFIG.BACKUP_NAME_PREFIX}-${type}-${timestamp}${ext}`;
}

/**
 * Create full backup
 */
async function createFullBackup() {
  console.log('\n📦 CREATING FULL BACKUP...\n');
  
  try {
    await mongoose.connect("mongodb+srv://zerocarbon:zerocarbon@zerocarbon.ujopg7s.mongodb.net/zeroCarbon");
    
    // Fetch all emission summaries
    console.log('📊 Fetching all emission summaries...');
    const summaries = await EmissionSummary.find().lean();
    
    console.log(`✅ Found ${summaries.length} summaries`);
    
    // Prepare backup data
    const backupData = {
      type: 'full',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      count: summaries.length,
      data: summaries
    };
    
    // Add metadata
    if (BACKUP_CONFIG.INCLUDE_METADATA) {
      const clients = await EmissionSummary.distinct('clientId');
      const periodTypes = await EmissionSummary.distinct('period.type');
      
      backupData.metadata = {
        totalClients: clients.length,
        clientIds: clients,
        periodTypes: periodTypes,
        totalDataPoints: summaries.reduce((sum, s) => 
          sum + (s.emissionSummary?.metadata?.totalDataPoints || 0), 0
        ),
        totalCO2e: summaries
          .filter(s => s.period?.type === 'all-time')
          .reduce((sum, s) => 
            sum + (s.emissionSummary?.totalEmissions?.CO2e || 0), 0
          )
      };
    }
    
    // Save backup
    const filename = getBackupFilename('full');
    const filepath = path.join(BACKUP_CONFIG.BACKUP_DIR, filename);
    
    console.log(`\n💾 Saving backup to: ${filepath}`);
    
    const jsonData = JSON.stringify(backupData, null, 2);
    
    if (BACKUP_CONFIG.COMPRESS) {
      const compressed = zlib.gzipSync(jsonData);
      fs.writeFileSync(filepath, compressed);
      
      const originalSize = Buffer.byteLength(jsonData);
      const compressedSize = compressed.length;
      const ratio = ((1 - compressedSize / originalSize) * 100).toFixed(2);
      
      console.log(`✅ Backup saved (compressed)`);
      console.log(`   Original size: ${(originalSize / 1024 / 1024).toFixed(2)} MB`);
      console.log(`   Compressed size: ${(compressedSize / 1024 / 1024).toFixed(2)} MB`);
      console.log(`   Compression ratio: ${ratio}%`);
    } else {
      fs.writeFileSync(filepath, jsonData);
      const size = Buffer.byteLength(jsonData);
      console.log(`✅ Backup saved`);
      console.log(`   Size: ${(size / 1024 / 1024).toFixed(2)} MB`);
    }
    
    // Cleanup old backups
    await cleanupOldBackups();
    
    await mongoose.connection.close();
    
    console.log('\n✅ BACKUP COMPLETE');
    
    return {
      success: true,
      filename,
      filepath,
      count: summaries.length
    };
    
  } catch (error) {
    console.error('❌ Error creating backup:', error);
    await mongoose.connection.close();
    throw error;
  }
}

/**
 * Create incremental backup (only recently updated summaries)
 */
async function createIncrementalBackup(sinceDate = null) {
  console.log('\n📦 CREATING INCREMENTAL BACKUP...\n');
  
  try {
    await mongoose.connect("mongodb+srv://zerocarbon:zerocarbon@zerocarbon.ujopg7s.mongodb.net/zeroCarbon");
    
    // Default to last 7 days if no date provided
    if (!sinceDate) {
      sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - 7);
    }
    
    console.log(`📊 Fetching summaries updated since: ${sinceDate.toISOString()}`);
    
    const summaries = await EmissionSummary.find({
      'metadata.lastCalculated': { $gte: sinceDate }
    }).lean();
    
    console.log(`✅ Found ${summaries.length} updated summaries`);
    
    if (summaries.length === 0) {
      console.log('⚠️  No summaries to backup');
      await mongoose.connection.close();
      return { success: true, count: 0 };
    }
    
    // Prepare backup data
    const backupData = {
      type: 'incremental',
      timestamp: new Date().toISOString(),
      sinceDate: sinceDate.toISOString(),
      version: '1.0.0',
      count: summaries.length,
      data: summaries
    };
    
    // Save backup
    const filename = getBackupFilename('incremental');
    const filepath = path.join(BACKUP_CONFIG.BACKUP_DIR, filename);
    
    console.log(`\n💾 Saving backup to: ${filepath}`);
    
    const jsonData = JSON.stringify(backupData, null, 2);
    
    if (BACKUP_CONFIG.COMPRESS) {
      const compressed = zlib.gzipSync(jsonData);
      fs.writeFileSync(filepath, compressed);
      console.log(`✅ Backup saved (compressed)`);
      console.log(`   Size: ${(compressed.length / 1024).toFixed(2)} KB`);
    } else {
      fs.writeFileSync(filepath, jsonData);
      console.log(`✅ Backup saved`);
      console.log(`   Size: ${(Buffer.byteLength(jsonData) / 1024).toFixed(2)} KB`);
    }
    
    await mongoose.connection.close();
    
    console.log('\n✅ INCREMENTAL BACKUP COMPLETE');
    
    return {
      success: true,
      filename,
      filepath,
      count: summaries.length
    };
    
  } catch (error) {
    console.error('❌ Error creating incremental backup:', error);
    await mongoose.connection.close();
    throw error;
  }
}

/**
 * Restore from backup
 */
async function restoreFromBackup(backupFilepath) {
  console.log('\n🔄 RESTORING FROM BACKUP...\n');
  console.log(`⚠️  WARNING: This will restore data from backup`);
  console.log(`   Backup file: ${backupFilepath}\n`);
  
  try {
    // Read backup file
    console.log('📖 Reading backup file...');
    let fileContent = fs.readFileSync(backupFilepath);
    
    // Decompress if needed
    if (backupFilepath.endsWith('.gz')) {
      console.log('📦 Decompressing...');
      fileContent = zlib.gunzipSync(fileContent);
    }
    
    const backupData = JSON.parse(fileContent);
    
    console.log(`✅ Backup loaded:`);
    console.log(`   Type: ${backupData.type}`);
    console.log(`   Created: ${backupData.timestamp}`);
    console.log(`   Count: ${backupData.count}`);
    
    if (backupData.metadata) {
      console.log(`   Clients: ${backupData.metadata.totalClients}`);
      console.log(`   Total CO2e: ${backupData.metadata.totalCO2e?.toFixed(2)} tonnes`);
    }
    
    // Connect to database
    await mongoose.connect("mongodb+srv://zerocarbon:zerocarbon@zerocarbon.ujopg7s.mongodb.net/zeroCarbon");
    
    // Restore summaries
    console.log(`\n🔄 Restoring ${backupData.count} summaries...`);
    
    let restored = 0;
    let errors = 0;
    
    for (const summaryData of backupData.data) {
      try {
        // Update or insert
        await EmissionSummary.findOneAndUpdate(
          { _id: summaryData._id },
          summaryData,
          { upsert: true, new: true }
        );
        restored++;
        
        if (restored % 100 === 0) {
          console.log(`   Progress: ${restored}/${backupData.count}`);
        }
      } catch (error) {
        errors++;
        console.error(`   ❌ Error restoring summary ${summaryData._id}: ${error.message}`);
      }
    }
    
    await mongoose.connection.close();
    
    console.log(`\n✅ RESTORATION COMPLETE`);
    console.log(`   Restored: ${restored}`);
    console.log(`   Errors: ${errors}`);
    
    return {
      success: true,
      restored,
      errors
    };
    
  } catch (error) {
    console.error('❌ Error restoring from backup:', error);
    await mongoose.connection.close();
    throw error;
  }
}

/**
 * List available backups
 */
function listBackups() {
  console.log('\n📋 AVAILABLE BACKUPS\n');
  
  ensureBackupDir();
  
  const files = fs.readdirSync(BACKUP_CONFIG.BACKUP_DIR)
    .filter(f => f.startsWith(BACKUP_CONFIG.BACKUP_NAME_PREFIX))
    .sort()
    .reverse();
  
  if (files.length === 0) {
    console.log('⚠️  No backups found');
    return [];
  }
  
  console.log(`Found ${files.length} backups:\n`);
  
  const backups = files.map((file, index) => {
    const filepath = path.join(BACKUP_CONFIG.BACKUP_DIR, file);
    const stats = fs.statSync(filepath);
    const size = (stats.size / 1024 / 1024).toFixed(2);
    const created = stats.birthtime;
    
    console.log(`${index + 1}. ${file}`);
    console.log(`   Created: ${created.toISOString()}`);
    console.log(`   Size: ${size} MB\n`);
    
    return {
      index: index + 1,
      filename: file,
      filepath,
      size: stats.size,
      created
    };
  });
  
  return backups;
}

/**
 * Cleanup old backups (keep only MAX_BACKUPS_TO_KEEP most recent)
 */
async function cleanupOldBackups() {
  ensureBackupDir();
  
  const files = fs.readdirSync(BACKUP_CONFIG.BACKUP_DIR)
    .filter(f => f.startsWith(BACKUP_CONFIG.BACKUP_NAME_PREFIX))
    .map(f => ({
      name: f,
      path: path.join(BACKUP_CONFIG.BACKUP_DIR, f),
      time: fs.statSync(path.join(BACKUP_CONFIG.BACKUP_DIR, f)).birthtime
    }))
    .sort((a, b) => b.time - a.time); // Sort by newest first
  
  if (files.length <= BACKUP_CONFIG.MAX_BACKUPS_TO_KEEP) {
    return;
  }
  
  console.log(`\n🗑️  Cleaning up old backups...`);
  
  const toDelete = files.slice(BACKUP_CONFIG.MAX_BACKUPS_TO_KEEP);
  
  for (const file of toDelete) {
    fs.unlinkSync(file.path);
    console.log(`   Deleted: ${file.name}`);
  }
  
  console.log(`✅ Cleaned up ${toDelete.length} old backups`);
}

// ============================================================================
// CLI INTERFACE
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';
  
  ensureBackupDir();
  
  switch (command.toLowerCase()) {
    case 'full':
      await createFullBackup();
      break;
      
    case 'incremental':
      const days = parseInt(args[1]) || 7;
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - days);
      await createIncrementalBackup(sinceDate);
      break;
      
    case 'list':
      listBackups();
      break;
      
    case 'restore':
      if (!args[1]) {
        console.log('❌ Please specify backup file to restore');
        console.log('Usage: node backup-emission-summaries.js restore <backup-file>');
        process.exit(1);
      }
      await restoreFromBackup(args[1]);
      break;
      
    case 'cleanup':
      await cleanupOldBackups();
      break;
      
    case 'help':
    default:
      console.log('\n📦 EMISSION SUMMARY BACKUP TOOL\n');
      console.log('Commands:');
      console.log('  full              - Create full backup of all summaries');
      console.log('  incremental [N]   - Create incremental backup (default: last 7 days)');
      console.log('  list              - List available backups');
      console.log('  restore <file>    - Restore from backup file');
      console.log('  cleanup           - Remove old backups');
      console.log('  help              - Show this help\n');
      console.log('Examples:');
      console.log('  node backup-emission-summaries.js full');
      console.log('  node backup-emission-summaries.js incremental 14');
      console.log('  node backup-emission-summaries.js restore backups/emission-summaries/backup-file.json.gz');
      console.log('');
      break;
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });
}

module.exports = {
  createFullBackup,
  createIncrementalBackup,
  restoreFromBackup,
  listBackups,
  cleanupOldBackups
};