// ============================================================
// ENHANCED SYNC FUNCTION: Auto-determine Workflow Status
// Replace the existing syncClientReductionProjects in:
// utils/Workflow/syncReductionProjects.js
// ============================================================

const Reduction = require('../../models/Reduction/Reduction');
const Client = require('../../models/Client');

/**
 * Automatically determine the overall workflow status based on project statuses
 * Logic:
 * - If ALL projects are 'completed' → 'completed'
 * - If ANY project is 'on_going' → 'on_going'
 * - If ANY project is 'pending' and NONE are 'on_going' → 'pending'
 * - If ALL projects are 'not_started' → 'not_started'
 * - If mixed but no active work → 'pending'
 */
function determineWorkflowStatus(statusCounts) {
  const { not_started, on_going, pending, completed, totalCount } = statusCounts;

  // No projects at all
  if (totalCount === 0) {
    return 'not_started';
  }

  // All projects completed
  if (completed === totalCount) {
    return 'completed';
  }

  // Any project actively in progress
  if (on_going > 0) {
    return 'on_going';
  }

  // Some pending, but none in progress
  if (pending > 0) {
    return 'pending';
  }

  // All not started
  if (not_started === totalCount) {
    return 'not_started';
  }

  // Mixed state but no active work - default to pending
  return 'pending';
}

/**
 * Sync all reduction projects for a specific client
 * - Counts projects by status
 * - Counts projects by input type
 * - Auto-determines overall workflow status
 * - Updates Client.workflowTracking.reduction
 */
async function syncClientReductionProjects(clientId) {
  try {
    console.log(`[Sync] Starting reduction projects sync for client: ${clientId}`);

    // Find all active (non-deleted) reduction projects for this client
    const projects = await Reduction.find({
      clientId,
      isDeleted: false
    }).select('status reductionDataEntry.inputType createdAt updatedAt');

    // Initialize counts
    const statusCounts = {
      not_started: 0,
      on_going: 0,
      pending: 0,
      completed: 0,
      totalCount: 0
    };

    const inputTypeCounts = {
      manual: 0,
      API: 0,
      IOT: 0
    };

    let lastProjectCreatedAt = null;

    // Count projects by status and input type
    projects.forEach(project => {
      // Count by status
      const status = project.status || 'not_started';
      if (statusCounts.hasOwnProperty(status)) {
        statusCounts[status]++;
      }
      statusCounts.totalCount++;

      // Count by input type
      const inputType = project.reductionDataEntry?.inputType || 'manual';
      if (inputTypeCounts.hasOwnProperty(inputType)) {
        inputTypeCounts[inputType]++;
      }

      // Track last created
      if (!lastProjectCreatedAt || project.createdAt > lastProjectCreatedAt) {
        lastProjectCreatedAt = project.createdAt;
      }
    });

    // Auto-determine overall workflow status
    const autoWorkflowStatus = determineWorkflowStatus(statusCounts);

    // Update Client document
    const updateData = {
      'workflowTracking.reduction.projects.totalCount': statusCounts.totalCount,
      'workflowTracking.reduction.projects.activeCount': statusCounts.on_going,
      'workflowTracking.reduction.projects.completedCount': statusCounts.completed,
      'workflowTracking.reduction.projects.pendingCount': statusCounts.pending,
      'workflowTracking.reduction.projects.notStartedCount': statusCounts.not_started,
      'workflowTracking.reduction.projects.lastProjectCreatedAt': lastProjectCreatedAt,
      'workflowTracking.reduction.dataInputPoints.manual.totalCount': inputTypeCounts.manual,
      'workflowTracking.reduction.dataInputPoints.api.totalCount': inputTypeCounts.API,
      'workflowTracking.reduction.dataInputPoints.iot.totalCount': inputTypeCounts.IOT,
      'workflowTracking.reduction.dataInputPoints.totalDataPoints': statusCounts.totalCount,
      // Auto-update workflow status based on project statuses
      'workflowTracking.reduction.status': autoWorkflowStatus,
      'workflowTracking.reduction.lastUpdated': new Date()
    };

    const client = await Client.findOneAndUpdate(
      { clientId },
      { $set: updateData },
      { new: true, upsert: false }
    );

    if (!client) {
      console.error(`[Sync] Client not found: ${clientId}`);
      return {
        success: false,
        error: 'Client not found'
      };
    }

    console.log(`[Sync] ✅ Synced ${statusCounts.totalCount} projects for ${clientId}`);
    console.log(`[Sync] Auto-determined workflow status: ${autoWorkflowStatus}`);
    console.log(`[Sync] Status breakdown:`, statusCounts);

    return {
      success: true,
      clientId,
      totalProjects: statusCounts.totalCount,
      workflowStatus: autoWorkflowStatus,
      statusCounts: {
        not_started: statusCounts.not_started,
        on_going: statusCounts.on_going,
        pending: statusCounts.pending,
        completed: statusCounts.completed
      },
      dataInputTypes: inputTypeCounts,
      lastProjectCreatedAt
    };

  } catch (error) {
    console.error(`[Sync] Error syncing reduction projects for ${clientId}:`, error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Sync all clients' reduction projects (bulk operation)
 * Use sparingly - this can be resource-intensive
 */
async function syncAllClientsReductionProjects() {
  try {
    console.log('[Sync] Starting bulk sync for ALL clients...');

    // Get all clients
    const clients = await Client.find({}).select('clientId');
    
    const results = [];
    let successCount = 0;
    let failCount = 0;

    for (const client of clients) {
      const result = await syncClientReductionProjects(client.clientId);
      results.push({
        clientId: client.clientId,
        success: result.success,
        totalProjects: result.totalProjects,
        workflowStatus: result.workflowStatus
      });
      
      if (result.success) successCount++;
      else failCount++;
    }

    console.log(`[Sync] ✅ Bulk sync complete: ${successCount} success, ${failCount} failed`);

    return {
      success: true,
      totalClients: clients.length,
      successCount,
      failCount,
      results
    };

  } catch (error) {
    console.error('[Sync] Error in bulk sync:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  syncClientReductionProjects,
  syncAllClientsReductionProjects
};