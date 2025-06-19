const cron = require('node-cron');
const DataEntry = require('../models/DataEntry');
const Client = require('../models/Client');
const Flowchart = require('../models/Flowchart');
const moment = require('moment');
const DataCollectionConfig = require('./models/DataCollectionConfig');


// Function to create monthly summaries for a specific client, node, and scope
const createMonthlySummaryForScope = async (clientId, nodeId, scopeIdentifier, month, year) => {
  try {
    console.log(`Creating monthly summary for ${clientId}/${nodeId}/${scopeIdentifier} - ${month}/${year}`);
    
    const summary = await DataEntry.createMonthlySummary(clientId, nodeId, scopeIdentifier, month, year);
    
    if (summary) {
      console.log(`Monthly summary created successfully for ${scopeIdentifier}. Deleted individual entries.`);
      return summary;
    } else {
      console.log(`No data found for ${scopeIdentifier} in ${month}/${year}`);
      return null;
    }
  } catch (error) {
    console.error(`Error creating monthly summary for ${scopeIdentifier}:`, error);
    return null;
  }
};

// Function to process all manual scopes for monthly aggregation
const processMonthlyAggregation = async () => {
  try {
    console.log('Starting monthly aggregation process...');
    
    // Get current month and year
    const now = new Date();
    const lastMonth = moment().subtract(1, 'month');
    const month = lastMonth.month() + 1; // moment months are 0-indexed
    const year = lastMonth.year();
    
    console.log(`Processing data for ${month}/${year}`);
    
    // Get all active clients
    const clients = await Client.find({ status: { $ne: 'inactive' } }).select('clientId');
    
    let totalSummaries = 0;
    let totalErrors = 0;
    
    for (const client of clients) {
      try {
        // Get active flowchart for this client
        const flowchart = await Flowchart.findOne({ 
          clientId: client.clientId, 
          isActive: true 
        });
        
        if (!flowchart) continue;
        
        // Process each node and scope
        for (const node of flowchart.nodes) {
          for (const scope of node.details.scopeDetails) {
            // Only process manual input types
            if (scope.inputType === 'manual') {
              try {
                const summary = await createMonthlySummaryForScope(
                  client.clientId,
                  node.id,
                  scope.scopeIdentifier,
                  month,
                  year
                );
                
                if (summary) {
                  totalSummaries++;
                }
              } catch (error) {
                console.error(`Error processing scope ${scope.scopeIdentifier}:`, error);
                totalErrors++;
              }
            }
          }
        }
      } catch (error) {
        console.error(`Error processing client ${client.clientId}:`, error);
        totalErrors++;
      }
    }
    
    console.log(`Monthly aggregation completed. Summaries created: ${totalSummaries}, Errors: ${totalErrors}`);
    
    // Send notification to admins about completion
    // You can implement email/notification logic here
    
  } catch (error) {
    console.error('Fatal error in monthly aggregation process:', error);
  }
};

// Function to check for overdue collections
const checkOverdueCollections = async () => {
  try {
    console.log('Checking for overdue data collections...');
    
    const DataCollectionConfig = require('../models/DataCollectionConfig');
    const overdueConfigs = await DataCollectionConfig.findOverdueCollections();
    
    for (const config of overdueConfigs) {
      // Mark as overdue
      config.collectionStatus.isOverdue = true;
      await config.save();
      
      // Send alerts if configured
      if (config.alertConfig.enableAlerts && config.alertConfig.alertOnMissedCollection) {
        // Implement alert logic here (email, in-app notifications, etc.)
        console.log(`Alert: Overdue collection for ${config.clientId}/${config.nodeId}/${config.scopeIdentifier}`);
      }
    }
    
    console.log(`Found ${overdueConfigs.length} overdue collections`);
    
  } catch (error) {
    console.error('Error checking overdue collections:', error);
  }
};

// Initialize cron jobs
const initializeCronJobs = () => {
  // Run monthly aggregation on the 1st of every month at 00:30
  cron.schedule('30 0 1 * *', async () => {
    console.log('Running monthly aggregation cron job...');
    await processMonthlyAggregation();
  }, {
    scheduled: true,
    timezone: "UTC"
  });
  
  // Check for overdue collections daily at 09:00
  cron.schedule('0 9 * * *', async () => {
    console.log('Running overdue collections check...');
    await checkOverdueCollections();
  }, {
    scheduled: true,
    timezone: "UTC"
  });
  
  // Optional: Test cron that runs every minute (comment out in production)
  // cron.schedule('* * * * *', () => {
  //   console.log('Cron jobs are running - test ping');
  // });
  
  console.log('Cron jobs initialized successfully');
};

// Function to manually trigger monthly aggregation (for testing or manual runs)
const manualMonthlyAggregation = async (month, year) => {
  try {
    console.log(`Manually triggering monthly aggregation for ${month}/${year}`);
    
    // Get all active clients
    const clients = await Client.find({ status: { $ne: 'inactive' } }).select('clientId');
    
    let totalSummaries = 0;
    let totalErrors = 0;
    
    for (const client of clients) {
      try {
        // Get active flowchart for this client
        const flowchart = await Flowchart.findOne({ 
          clientId: client.clientId, 
          isActive: true 
        });
        
        if (!flowchart) continue;
        
        // Process each node and scope
        for (const node of flowchart.nodes) {
          for (const scope of node.details.scopeDetails) {
            // Only process manual input types
            if (scope.inputType === 'manual') {
              try {
                const summary = await createMonthlySummaryForScope(
                  client.clientId,
                  node.id,
                  scope.scopeIdentifier,
                  month,
                  year
                );
                
                if (summary) {
                  totalSummaries++;
                }
              } catch (error) {
                console.error(`Error processing scope ${scope.scopeIdentifier}:`, error);
                totalErrors++;
              }
            }
          }
        }
      } catch (error) {
        console.error(`Error processing client ${client.clientId}:`, error);
        totalErrors++;
      }
    }
    
    return {
      success: true,
      summariesCreated: totalSummaries,
      errors: totalErrors,
      message: `Monthly aggregation completed for ${month}/${year}`
    };
    
  } catch (error) {
    console.error('Error in manual monthly aggregation:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// Function to create summaries for all manual scopes
const createMonthlySummaries = async () => {
  console.log('Starting monthly summary creation process...');
  
  try {
    // Get the previous month details
    const now = moment();
    const lastMonth = now.clone().subtract(1, 'month');
    const month = lastMonth.month() + 1; // moment months are 0-indexed
    const year = lastMonth.year();
    
    console.log(`Creating summaries for ${month}/${year}`);
    
    // Find all unique combinations of clientId, nodeId, scopeIdentifier for manual entries
    const configs = await DataCollectionConfig.find({
      inputType: 'manual'
    }).lean();
    
    const summaryResults = {
      successful: 0,
      failed: 0,
      errors: []
    };
    
    for (const config of configs) {
      try {
        const { clientId, nodeId, scopeIdentifier } = config;
        
        console.log(`Processing summary for ${clientId}/${nodeId}/${scopeIdentifier}`);
        
        // Create monthly summary (this will also delete individual entries)
        const summary = await DataEntry.createMonthlySummary(
          clientId,
          nodeId,
          scopeIdentifier,
          month,
          year
        );
        
        if (summary) {
          console.log(`Summary created successfully for ${clientId}/${nodeId}/${scopeIdentifier}`);
          summaryResults.successful++;
          
          // Update collection config to reflect the summary
          config.lastSummaryCreated = {
            month,
            year,
            createdAt: new Date(),
            summaryId: summary._id
          };
          
          await DataCollectionConfig.updateOne(
            { _id: config._id },
            { 
              $set: { 
                lastSummaryCreated: config.lastSummaryCreated 
              }
            }
          );
        } else {
          console.log(`No data found for ${clientId}/${nodeId}/${scopeIdentifier} in ${month}/${year}`);
        }
        
      } catch (error) {
        console.error(`Error creating summary for config ${config._id}:`, error);
        summaryResults.failed++;
        summaryResults.errors.push({
          configId: config._id,
          clientId: config.clientId,
          nodeId: config.nodeId,
          scopeIdentifier: config.scopeIdentifier,
          error: error.message
        });
      }
    }
    
    console.log('Monthly summary creation completed:', summaryResults);
    
    // Optional: Send notification email/alert about summary completion
    // await sendSummaryCompletionNotification(summaryResults);
    
    return summaryResults;
    
  } catch (error) {
    console.error('Critical error in monthly summary creation:', error);
    throw error;
  }
};

// Function to manually trigger summary for a specific month
const createSummaryForSpecificMonth = async (clientId, nodeId, scopeIdentifier, month, year) => {
  try {
    console.log(`Creating manual summary for ${clientId}/${nodeId}/${scopeIdentifier} - ${month}/${year}`);
    
    const summary = await DataEntry.createMonthlySummary(
      clientId,
      nodeId,
      scopeIdentifier,
      month,
      year
    );
    
    if (summary) {
      console.log('Summary created successfully:', summary._id);
      return {
        success: true,
        summaryId: summary._id,
        data: {
          cumulativeValues: Object.fromEntries(summary.cumulativeValues),
          highData: Object.fromEntries(summary.highData),
          lowData: Object.fromEntries(summary.lowData),
          lastEnteredData: Object.fromEntries(summary.lastEnteredData),
          monthlyTotals: Object.fromEntries(summary.dataValues)
        }
      };
    } else {
      return {
        success: false,
        message: 'No data found for the specified month'
      };
    }
    
  } catch (error) {
    console.error('Error creating manual summary:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// Schedule cron job to run on the 1st of every month at 2 AM
const scheduleMonthlySummary = () => {
  // Run at 2:00 AM on the 1st of every month
  cron.schedule('0 2 1 * *', async () => {
    console.log('Starting scheduled monthly summary creation...');
    try {
      await createMonthlySummaries();
    } catch (error) {
      console.error('Scheduled monthly summary failed:', error);
      // Send alert to administrators
      // await sendAdminAlert('Monthly summary creation failed', error);
    }
  }, {
    scheduled: true,
    timezone: "UTC" // Adjust timezone as needed
  });
  
  console.log('Monthly summary cron job scheduled');
};

// Function to check if summaries need to be created (for missed months)
const checkAndCreateMissedSummaries = async () => {
  try {
    const configs = await DataCollectionConfig.find({
      inputType: 'manual'
    }).lean();
    
    const now = moment();
    const currentMonth = now.month() + 1;
    const currentYear = now.year();
    
    for (const config of configs) {
      const { clientId, nodeId, scopeIdentifier, lastSummaryCreated } = config;
      
      // Find the oldest non-summarized entry
      const oldestEntry = await DataEntry.findOne({
        clientId,
        nodeId,
        scopeIdentifier,
        inputType: 'manual',
        isSummary: false
      }).sort({ timestamp: 1 });
      
      if (!oldestEntry) continue;
      
      const entryDate = moment(oldestEntry.timestamp);
      let checkMonth = entryDate.month() + 1;
      let checkYear = entryDate.year();
      
      // Create summaries for all complete months
      while (checkYear < currentYear || (checkYear === currentYear && checkMonth < currentMonth)) {
        // Check if summary already exists
        const existingSummary = await DataEntry.findOne({
          clientId,
          nodeId,
          scopeIdentifier,
          isSummary: true,
          'summaryPeriod.month': checkMonth,
          'summaryPeriod.year': checkYear
        });
        
        if (!existingSummary) {
          console.log(`Creating missed summary for ${clientId}/${nodeId}/${scopeIdentifier} - ${checkMonth}/${checkYear}`);
          await DataEntry.createMonthlySummary(
            clientId,
            nodeId,
            scopeIdentifier,
            checkMonth,
            checkYear
          );
        }
        
        // Move to next month
        checkMonth++;
        if (checkMonth > 12) {
          checkMonth = 1;
          checkYear++;
        }
      }
    }
    
    console.log('Missed summaries check completed');
    
  } catch (error) {
    console.error('Error checking for missed summaries:', error);
  }
};
module.exports = {
  initializeCronJobs,
  processMonthlyAggregation,
  checkOverdueCollections,
  manualMonthlyAggregation,
  createMonthlySummaryForScope,
   createMonthlySummaries,
  createSummaryForSpecificMonth,
  scheduleMonthlySummary,
  checkAndCreateMissedSummaries
};