// ============================================================================
// 6. BACKGROUND JOB FOR SUMMARY MAINTENANCE
// ============================================================================
// jobs/summaryMaintenanceJob.js
const cron = require('node-cron');
const ReductionSummary = require('../models/Reduction/ReductionSummary');

// Import directly from controller instead of trigger file
const { calculateFullSummary } = require('../controllers/Reduction/reductionSummaryController');

// Run every hour to process pending recalculations
cron.schedule('0 * * * *', async () => {
  console.log('Starting summary maintenance job...');
  
  try {
    // Find summaries that need recalculation
    const pendingSummaries = await ReductionSummary.find({
      pendingRecalculation: true
    }).select('clientId').limit(50); // Process 50 at a time
    
    console.log(`Found ${pendingSummaries.length} summaries needing recalculation`);
    
    for (const summary of pendingSummaries) {
      try {
        const updated = await calculateFullSummary(summary.clientId);
        
        await ReductionSummary.findOneAndUpdate(
          { 
            clientId: summary.clientId, 
            period: 'lifetime',
            periodStart: null
          },
          updated,
          { 
            upsert: true, 
            new: true, 
            setDefaultsOnInsert: true 
          }
        );
        
        console.log(`Recalculated summary for client ${summary.clientId}`);
      } catch (error) {
        console.error(`Error recalculating summary for client ${summary.clientId}:`, error);
      }
    }
    
    console.log('Summary maintenance job completed');
  } catch (error) {
    console.error('Error in summary maintenance job:', error);
  }
});

// Run daily at 2 AM to clean up old summary data
cron.schedule('0 2 * * *', async () => {
  console.log('Starting summary cleanup job...');
  
  try {
    // Remove summaries older than 90 days for non-lifetime periods
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    
    const result = await ReductionSummary.deleteMany({
      period: { $ne: 'lifetime' },
      periodStart: { $lt: ninetyDaysAgo }
    });
    
    console.log(`Cleaned up ${result.deletedCount} old summary records`);
  } catch (error) {
    console.error('Error in summary cleanup job:', error);
  }
});

module.exports = {
  // Export for manual triggering if needed
  runMaintenanceJob: async () => {
    // Manual trigger logic here
  }
};