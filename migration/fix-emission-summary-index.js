// migrations/fix-emission-summary-index.js
// Run this migration to fix the unique index issue

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const connectDB = require('../config/db'); // Use the centralized DB connection

// Load environment variables from .env file, just like in your main app
dotenv.config();

async function migrateEmissionSummaryIndexes() {
 try {
  console.log('🔄 Starting EmissionSummary index migration...');
  
  const db = mongoose.connection.db;
  const collection = db.collection('emissionsummaries');
  
  // Step 1: Get all existing indexes
  const indexes = await collection.indexes();
  console.log('📋 Current indexes:', indexes.map(idx => ({ 
   name: idx.name, 
   key: idx.key,
      unique: !!idx.unique
  })));
  
  // Step 2: Drop the problematic unique index on clientId
  const clientIdIndex = indexes.find(idx => 
   idx.key.clientId === 1 && idx.unique && Object.keys(idx.key).length === 1
  );
  
  if (clientIdIndex) {
   console.log(`🗑️ Dropping unique index on clientId ('${clientIdIndex.name}')...`);
   await collection.dropIndex(clientIdIndex.name);
   console.log('✅ Unique index on clientId dropped');
  } else {
   console.log('ℹ️ No standalone unique index on clientId found to drop.');
  }
  
  // Step 3: Create the correct compound unique index
  console.log('🔨 Creating compound unique index...');
  try {
      await collection.createIndex(
       {
        clientId: 1,
        'period.type': 1,
        'period.year': 1,
        'period.month': 1,
        'period.week': 1,
        'period.day': 1
       },
       { 
        unique: true,
        name: 'clientId_period_unique',
            // This helps avoid errors if some documents are missing these fields
            partialFilterExpression: { 
              'period.type': { $exists: true } 
            }
       }
      );
      console.log('✅ Compound unique index created successfully.');
    } catch (indexError) {
        if (indexError.codeName === 'IndexAlreadyExists') {
            console.log('ℹ️ Compound unique index already exists.');
        } else {
            throw indexError; // Re-throw other errors
        }
    }
  
  // Step 4: Create performance indexes if they don't exist
  const performanceIndexes = [
   {
    key: { clientId: 1, 'metadata.lastCalculated': -1 },
    name: 'clientId_lastCalculated'
   },
   {
    key: { 'period.from': 1, 'period.to': 1 },
    name: 'period_range'
   }
  ];
  
    const currentIndexes = await collection.indexes();
  for (const indexDef of performanceIndexes) {
   const exists = currentIndexes.some(idx => idx.name === indexDef.name);
   
   if (!exists) {
    console.log(`🔨 Creating performance index: ${indexDef.name}...`);
    await collection.createIndex(indexDef.key, { name: indexDef.name });
    console.log(`✅ Index ${indexDef.name} created`);
   } else {
        console.log(`ℹ️ Performance index '${indexDef.name}' already exists.`);
      }
  }
  
  // Step 5: Verify the indexes
  const newIndexes = await collection.indexes();
  console.log('📋 Updated indexes:', newIndexes.map(idx => ({ 
   name: idx.name, 
   key: idx.key,
   unique: idx.unique || false
  })));
  
  console.log('✅ Migration completed successfully!');
  
 } catch (error) {
  console.error('❌ Migration failed:', error);
  throw error;
 }
}

// If running this file directly
if (require.main === module) {
  connectDB() // Use the centralized connection function from config/db.js
  .then(() => {
  // The connection is already logged in connectDB, so we can proceed
  return migrateEmissionSummaryIndexes();
 })
 .then(() => {
  console.log('🔌 Disconnecting from MongoDB...');
  return mongoose.disconnect();
 })
 .catch(error => {
  console.error('❌ Error during migration script execution:', error);
  process.exit(1);
 });
}

module.exports = migrateEmissionSummaryIndexes;
