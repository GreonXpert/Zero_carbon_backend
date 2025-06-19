// migration/addWorkflowTracking.js
// Run this script to add workflow tracking fields to existing clients

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Import the Client model
const Client = require('../models/Client');

// MongoDB connection
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('MongoDB Connected for migration...');
  } catch (error) {
    console.error('Error connecting to MongoDB:', error);
    process.exit(1);
  }
};

// Migration function
const migrateWorkflowTracking = async () => {
  try {
    console.log('Starting workflow tracking migration...');
    
    // Find all clients
    const clients = await Client.find({});
    console.log(`Found ${clients.length} clients to migrate`);
    
    let migratedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    
    for (const client of clients) {
      try {
        // Check if workflowTracking already exists
        if (client.workflowTracking && 
            client.workflowTracking.flowchartStatus && 
            client.workflowTracking.dataInputPoints) {
          console.log(`Client ${client.clientId} already has workflow tracking - skipping`);
          skippedCount++;
          continue;
        }
        
        // Add workflow tracking structure
        client.workflowTracking = {
          // Flowchart status
          flowchartStatus: 'not_started',
          flowchartStartedAt: null,
          flowchartCompletedAt: null,
          
          // Process flowchart status
          processFlowchartStatus: 'not_started',
          processFlowchartStartedAt: null,
          processFlowchartCompletedAt: null,
          
          // Assigned consultant - check if already exists in leadInfo
          assignedConsultantId: client.leadInfo?.assignedConsultantId || null,
          consultantAssignedAt: client.leadInfo?.assignedConsultantId ? new Date() : null,
          
          // Data input points tracking
          dataInputPoints: {
            // Manual input points
            manual: {
              inputs: [],
              totalCount: 0,
              completedCount: 0,
              pendingCount: 0,
              onGoingCount: 0,
              notStartedCount: 0
            },
            
            // API input points
            api: {
              inputs: [],
              totalCount: 0,
              completedCount: 0,
              pendingCount: 0,
              onGoingCount: 0,
              notStartedCount: 0
            },
            
            // IoT input points
            iot: {
              inputs: [],
              totalCount: 0,
              completedCount: 0,
              pendingCount: 0,
              onGoingCount: 0,
              notStartedCount: 0
            },
            
            // Overall summary
            totalDataPoints: 0,
            lastSyncedWithFlowchart: null
          }
        };
        
        // Add timeline entry for migration
        client.timeline.push({
          stage: client.stage,
          status: client.status,
          action: "Workflow tracking added via migration",
          performedBy: null,
          notes: "System migration to add workflow tracking capabilities"
        });
        
        // Save the updated client
        await client.save();
        migratedCount++;
        console.log(`✓ Migrated client ${client.clientId}`);
        
      } catch (error) {
        errorCount++;
        console.error(`✗ Error migrating client ${client.clientId}:`, error.message);
      }
    }
    
    // Summary
    console.log('\n=== Migration Summary ===');
    console.log(`Total clients: ${clients.length}`);
    console.log(`Successfully migrated: ${migratedCount}`);
    console.log(`Skipped (already migrated): ${skippedCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log('========================\n');
    
  } catch (error) {
    console.error('Migration error:', error);
    throw error;
  }
};

// Rollback function (in case you need to remove workflow tracking)
const rollbackWorkflowTracking = async () => {
  try {
    console.log('Starting workflow tracking rollback...');
    
    const result = await Client.updateMany(
      {},
      { 
        $unset: { workflowTracking: 1 },
        $push: {
          timeline: {
            stage: "active",
            status: "active",
            action: "Workflow tracking removed via rollback",
            performedBy: null,
            notes: "System rollback to remove workflow tracking"
          }
        }
      }
    );
    
    console.log(`Rolled back workflow tracking from ${result.modifiedCount} clients`);
    
  } catch (error) {
    console.error('Rollback error:', error);
    throw error;
  }
};

// Main execution
const main = async () => {
  try {
    // Connect to database
    await connectDB();
    
    // Check command line arguments
    const command = process.argv[2];
    
    if (command === 'rollback') {
      // Confirm rollback
      console.log('\n⚠️  WARNING: This will remove workflow tracking from all clients!');
      console.log('Press Ctrl+C to cancel, or wait 5 seconds to continue...\n');
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      await rollbackWorkflowTracking();
    } else {
      // Run migration
      await migrateWorkflowTracking();
    }
    
    // Disconnect
    await mongoose.disconnect();
    console.log('Migration completed. Database connection closed.');
    process.exit(0);
    
  } catch (error) {
    console.error('Fatal error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
};

// Run the migration
main();

/*
 * Usage:
 * 
 * To run migration:
 * node migration/addWorkflowTracking.js
 * 
 * To rollback:
 * node migration/addWorkflowTracking.js rollback
 */