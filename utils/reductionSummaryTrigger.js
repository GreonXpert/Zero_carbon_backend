// ============================================================================
// 3. AUTO-UPDATE TRIGGER FUNCTION
// ============================================================================
// utils/reductionSummaryTrigger.js

const ReductionSummary = require('../models/Reduction/ReductionSummary');

// Import the required functions from the controller
const { 
  calculateFullSummary, 
  canAccessClient, 
  getAllowedClientIds 
} = require('../controllers/Reduction/reductionSummaryController');

/**
 * Trigger function to update summary when net reduction data changes
 * This should be called after any CRUD operation on NetReductionEntry
 */
async function triggerSummaryUpdate(clientId, operation = 'update', additionalData = {}) {
  try {
    console.log(`Triggering summary update for client ${clientId} due to ${operation}`);
    
    // Mark as pending recalculation
    await ReductionSummary.updateMany(
      { clientId },
      { 
        pendingRecalculation: true,
        lastDataUpdate: new Date()
      }
    );

    // For critical operations, recalculate immediately
    if (['delete', 'bulk_update'].includes(operation)) {
      const summary = await calculateFullSummary(clientId);
      
      await ReductionSummary.findOneAndUpdate(
        { 
          clientId, 
          period: 'lifetime',
          periodStart: null
        },
        summary,
        { 
          upsert: true, 
          new: true, 
          setDefaultsOnInsert: true 
        }
      );
    }

    console.log(`Summary update triggered successfully for client ${clientId}`);
    return true;
  } catch (error) {
    console.error(`Error triggering summary update for client ${clientId}:`, error);
    return false;
  }
}

module.exports = {
  triggerSummaryUpdate,
  calculateFullSummary,
  canAccessClient,
  getAllowedClientIds
};