// utils/Workflow/syncReductionProjects.js
const Client = require('../../models/Client');
const Reduction = require('../../models/Reduction/Reduction');

/**
 * Sync all Reduction projects for a specific client
 * Updates Client.workflowTracking.reduction.projects with current counts
 */
async function syncClientReductionProjects(clientId) {
  try {
    // Find the client
    const client = await Client.findOne({ clientId });
    if (!client) {
      console.warn(`[syncClientReductionProjects] Client ${clientId} not found`);
      return { success: false, message: 'Client not found' };
    }

    // Count all projects for this client (excluding deleted)
    const allProjects = await Reduction.countDocuments({
      clientId,
      $or: [
        { isDeleted: { $exists: false } },
        { isDeleted: false }
      ]
    });

    // Count by status
    const statusCounts = await Reduction.aggregate([
      {
        $match: {
          clientId,
          $or: [
            { isDeleted: { $exists: false } },
            { isDeleted: false }
          ]
        }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);

    // Extract counts
    const statusMap = {};
    statusCounts.forEach(item => {
      statusMap[item._id] = item.count;
    });

    // Get the most recent project creation date
    const latestProject = await Reduction.findOne({
      clientId,
      $or: [
        { isDeleted: { $exists: false } },
        { isDeleted: false }
      ]
    })
    .sort({ createdAt: -1 })
    .select('createdAt')
    .lean();

    // Count data input points by type
    const dataInputCounts = await Reduction.aggregate([
      {
        $match: {
          clientId,
          $or: [
            { isDeleted: { $exists: false } },
            { isDeleted: false }
          ]
        }
      },
      {
        $group: {
          _id: '$reductionDataEntry.inputType',
          count: { $sum: 1 }
        }
      }
    ]);

    const inputTypeMap = {
      manual: 0,
      API: 0,
      IOT: 0
    };

    dataInputCounts.forEach(item => {
      const type = item._id;
      if (type === 'manual') inputTypeMap.manual = item.count;
      else if (type === 'API') inputTypeMap.API = item.count;
      else if (type === 'IOT') inputTypeMap.IOT = item.count;
    });

    // Update client's reduction tracking
    if (!client.workflowTracking) {
      client.workflowTracking = {};
    }
    if (!client.workflowTracking.reduction) {
      client.workflowTracking.reduction = {
        status: 'not_started',
        projects: {},
        dataInputPoints: {}
      };
    }

    // Update project counts
    client.workflowTracking.reduction.projects = {
      totalCount: allProjects,
      activeCount: statusMap['on_going'] || 0,
      completedCount: statusMap['completed'] || 0,
      pendingCount: statusMap['pending'] || 0,
      notStartedCount: statusMap['not_started'] || 0,
      lastProjectCreatedAt: latestProject?.createdAt || null
    };

    // Update data input points counts
    client.workflowTracking.reduction.dataInputPoints = {
      manual: { totalCount: inputTypeMap.manual },
      api: { totalCount: inputTypeMap.API },
      iot: { totalCount: inputTypeMap.IOT },
      totalDataPoints: inputTypeMap.manual + inputTypeMap.API + inputTypeMap.IOT
    };

    // Update reduction status based on project counts
    if (allProjects === 0) {
      client.workflowTracking.reduction.status = 'not_started';
    } else if (statusMap['completed'] === allProjects && allProjects > 0) {
      client.workflowTracking.reduction.status = 'completed';
      if (!client.workflowTracking.reduction.completedAt) {
        client.workflowTracking.reduction.completedAt = new Date();
      }
    } else if (statusMap['on_going'] > 0 || statusMap['pending'] > 0) {
      client.workflowTracking.reduction.status = 'on_going';
      if (!client.workflowTracking.reduction.startedAt) {
        client.workflowTracking.reduction.startedAt = new Date();
      }
    } else {
      client.workflowTracking.reduction.status = 'not_started';
    }

    // Save the client
    await client.save();

    console.log(`[syncClientReductionProjects] Successfully synced ${allProjects} projects for client ${clientId}`);

    return {
      success: true,
      clientId,
      totalProjects: allProjects,
      statusCounts: {
        not_started: statusMap['not_started'] || 0,
        on_going: statusMap['on_going'] || 0,
        pending: statusMap['pending'] || 0,
        completed: statusMap['completed'] || 0
      },
      dataInputTypes: inputTypeMap
    };

  } catch (error) {
    console.error(`[syncClientReductionProjects] Error for client ${clientId}:`, error);
    return { success: false, message: error.message };
  }
}

/**
 * Sync all clients - useful for bulk operations or migrations
 */
async function syncAllClientsReductionProjects() {
  try {
    // Get all unique clientIds from Reduction collection
    const clientIds = await Reduction.distinct('clientId', {
      $or: [
        { isDeleted: { $exists: false } },
        { isDeleted: false }
      ]
    });

    console.log(`[syncAllClientsReductionProjects] Syncing ${clientIds.length} clients...`);

    const results = [];
    for (const clientId of clientIds) {
      const result = await syncClientReductionProjects(clientId);
      results.push(result);
    }

    const successCount = results.filter(r => r.success).length;
    console.log(`[syncAllClientsReductionProjects] Completed: ${successCount}/${clientIds.length} successful`);

    return {
      success: true,
      totalClients: clientIds.length,
      successCount,
      results
    };

  } catch (error) {
    console.error('[syncAllClientsReductionProjects] Error:', error);
    return { success: false, message: error.message };
  }
}

module.exports = {
  syncClientReductionProjects,
  syncAllClientsReductionProjects
};