// migration/addSandboxFields.js
// Migration script to add sandbox fields to existing clients and users

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Import models
const Client = require('../models/Client');
const User = require('../models/User');

// Migration statistics
let stats = {
  clientsUpdated: 0,
  clientsSkipped: 0,
  usersUpdated: 0,
  usersSkipped: 0,
  errors: []
};

async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/your-database', {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('✅ Connected to MongoDB for migration');
  } catch (error) {
    console.error('❌ Failed to connect to MongoDB:', error);
    process.exit(1);
  }
}

async function addSandboxToClients() {
  console.log('\n📋 Starting Client migration...');
  
  try {
    // Find all clients without sandbox field
    const clientsToUpdate = await Client.find({ 
      sandbox: { $exists: false } 
    });
    
    console.log(`Found ${clientsToUpdate.length} clients to update`);
    
    for (const client of clientsToUpdate) {
      try {
        // Determine sandbox value based on existing data
        // Default all existing clients to non-sandbox (production)
        const sandboxValue = false;
        
        // Update the client
        await Client.updateOne(
          { _id: client._id },
          { 
            $set: { 
              sandbox: sandboxValue,
              // Ensure isActive is properly set for production clients
              isActive: client.isActive !== false ? true : false
            } 
          }
        );
        
        stats.clientsUpdated++;
        console.log(`✅ Updated client ${client.clientId} - sandbox: ${sandboxValue}`);
        
      } catch (error) {
        stats.errors.push({
          type: 'client',
          id: client.clientId,
          error: error.message
        });
        console.error(`❌ Failed to update client ${client.clientId}:`, error.message);
      }
    }
    
    // Check for clients that already have sandbox field
    const existingCount = await Client.countDocuments({ 
      sandbox: { $exists: true } 
    });
    stats.clientsSkipped = existingCount - stats.clientsUpdated;
    
    console.log(`✅ Client migration completed: ${stats.clientsUpdated} updated, ${stats.clientsSkipped} skipped`);
    
  } catch (error) {
    console.error('❌ Client migration failed:', error);
    throw error;
  }
}

async function addSandboxToUsers() {
  console.log('\n👤 Starting User migration...');
  
  try {
    // Find all users without sandbox field
    const usersToUpdate = await User.find({ 
      sandbox: { $exists: false } 
    });
    
    console.log(`Found ${usersToUpdate.length} users to update`);
    
    for (const user of usersToUpdate) {
      try {
        // Default all existing users to non-sandbox (production)
        const sandboxValue = false;
        
        // Update the user
        await User.updateOne(
          { _id: user._id },
          { 
            $set: { 
              sandbox: sandboxValue,
              // Ensure isActive is properly set
              isActive: user.isActive !== false ? true : false
            } 
          }
        );
        
        stats.usersUpdated++;
        console.log(`✅ Updated user ${user.email} - sandbox: ${sandboxValue}`);
        
      } catch (error) {
        stats.errors.push({
          type: 'user',
          id: user.email,
          error: error.message
        });
        console.error(`❌ Failed to update user ${user.email}:`, error.message);
      }
    }
    
    // Check for users that already have sandbox field
    const existingCount = await User.countDocuments({ 
      sandbox: { $exists: true } 
    });
    stats.usersSkipped = existingCount - stats.usersUpdated;
    
    console.log(`✅ User migration completed: ${stats.usersUpdated} updated, ${stats.usersSkipped} skipped`);
    
  } catch (error) {
    console.error('❌ User migration failed:', error);
    throw error;
  }
}

async function createSandboxIndexes() {
  console.log('\n🔍 Creating indexes...');
  
  try {
    // Add indexes for efficient sandbox queries
    await Client.collection.createIndex({ sandbox: 1 });
    await Client.collection.createIndex({ sandbox: 1, isActive: 1 });
    await Client.collection.createIndex({ clientId: 1, sandbox: 1 });
    
    await User.collection.createIndex({ sandbox: 1 });
    await User.collection.createIndex({ sandbox: 1, isActive: 1 });
    await User.collection.createIndex({ clientId: 1, sandbox: 1 });
    
    console.log('✅ Indexes created successfully');
  } catch (error) {
    console.error('❌ Index creation failed:', error);
    // Non-critical error, continue
  }
}

async function validateInvariants() {
  console.log('\n✔️ Validating invariants...');
  
  try {
    // Check for any violations of sandbox/active invariant
    const violatingClients = await Client.find({
      sandbox: true,
      isActive: true
    });
    
    if (violatingClients.length > 0) {
      console.warn(`⚠️ Found ${violatingClients.length} clients violating invariant (sandbox=true AND isActive=true)`);
      
      // Fix violations
      for (const client of violatingClients) {
        await Client.updateOne(
          { _id: client._id },
          { $set: { isActive: false } }
        );
        console.log(`🔧 Fixed client ${client.clientId} - set isActive to false`);
      }
    }
    
    const violatingUsers = await User.find({
      sandbox: true,
      isActive: true
    });
    
    if (violatingUsers.length > 0) {
      console.warn(`⚠️ Found ${violatingUsers.length} users violating invariant (sandbox=true AND isActive=true)`);
      
      // Fix violations
      for (const user of violatingUsers) {
        await User.updateOne(
          { _id: user._id },
          { $set: { isActive: false } }
        );
        console.log(`🔧 Fixed user ${user.email} - set isActive to false`);
      }
    }
    
    console.log('✅ Invariant validation completed');
    
  } catch (error) {
    console.error('❌ Invariant validation failed:', error);
    throw error;
  }
}

async function generateReport() {
  console.log('\n📊 Migration Report');
  console.log('==================');
  console.log(`Clients Updated: ${stats.clientsUpdated}`);
  console.log(`Clients Skipped: ${stats.clientsSkipped}`);
  console.log(`Users Updated: ${stats.usersUpdated}`);
  console.log(`Users Skipped: ${stats.usersSkipped}`);
  
  if (stats.errors.length > 0) {
    console.log(`\n⚠️ Errors encountered: ${stats.errors.length}`);
    stats.errors.forEach(err => {
      console.log(`  - ${err.type} ${err.id}: ${err.error}`);
    });
  }
  
  // Get final counts
  const totalClients = await Client.countDocuments({});
  const sandboxClients = await Client.countDocuments({ sandbox: true });
  const productionClients = await Client.countDocuments({ sandbox: false });
  
  const totalUsers = await User.countDocuments({});
  const sandboxUsers = await User.countDocuments({ sandbox: true });
  const productionUsers = await User.countDocuments({ sandbox: false });
  
  console.log('\n📈 Final Statistics');
  console.log('==================');
  console.log(`Total Clients: ${totalClients}`);
  console.log(`  - Production: ${productionClients}`);
  console.log(`  - Sandbox: ${sandboxClients}`);
  console.log(`Total Users: ${totalUsers}`);
  console.log(`  - Production: ${productionUsers}`);
  console.log(`  - Sandbox: ${sandboxUsers}`);
}

async function runMigration() {
  console.log('🚀 Starting Sandbox Fields Migration');
  console.log('====================================');
  
  try {
    await connectDB();
    await addSandboxToClients();
    await addSandboxToUsers();
    await createSandboxIndexes();
    await validateInvariants();
    await generateReport();
    
    console.log('\n✅ Migration completed successfully!');
    
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    await generateReport();
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n⚠️ Migration interrupted by user');
  await generateReport();
  await mongoose.connection.close();
  process.exit(0);
});

// Run migration if executed directly
if (require.main === module) {
  runMigration()
    .then(() => {
      mongoose.connection.close();
      process.exit(0);
    })
    .catch(error => {
      console.error('Fatal error:', error);
      mongoose.connection.close();
      process.exit(1);
    });
}

module.exports = { runMigration };