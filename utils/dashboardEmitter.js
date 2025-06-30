// Helper functions to emit real-time dashboard updates
// Add these to your existing controller functions where data changes occur

// Example: In updateFlowchartStatus function after saving
const emitFlowchartStatusUpdate = async (client, userId) => {
  if (global.io) {
    // Get affected users
    const affectedUsers = [];
    
    // Add assigned consultant
    if (client.workflowTracking.assignedConsultantId) {
      affectedUsers.push(client.workflowTracking.assignedConsultantId.toString());
    }
    
    // Add consultant admin
    if (client.leadInfo.consultantAdminId) {
      affectedUsers.push(client.leadInfo.consultantAdminId.toString());
      
      // Also notify all consultants under this admin
      const consultants = await User.find({
        consultantAdminId: client.leadInfo.consultantAdminId,
        userType: 'consultant'
      }).select('_id');
      
      consultants.forEach(c => affectedUsers.push(c._id.toString()));
    }
    
    // Prepare update data
    const updateData = {
      clientId: client.clientId,
      workflowStatus: {
        flowchart: client.workflowTracking.flowchartStatus,
        processFlowchart: client.workflowTracking.processFlowchartStatus
      },
      updatedBy: userId,
      timestamp: new Date().toISOString()
    };
    
    // Emit to affected users
    affectedUsers.forEach(userId => {
      global.io.to(`user_${userId}`).emit('dashboard_update', {
        type: 'workflow_status_change',
        data: updateData
      });
    });
    
    // Also emit to super admins
    global.io.to('userType_super_admin').emit('dashboard_update', {
      type: 'workflow_status_change',
      data: updateData
    });
  }
};

// Example: In updateManualInputStatus function after saving
const emitDataInputPointUpdate = async (client, inputType, pointId, userId) => {
  if (global.io) {
    const updateData = {
      clientId: client.clientId,
      inputType: inputType,
      pointId: pointId,
      dataInputPoints: {
        manual: {
          total: client.workflowTracking.dataInputPoints.manual.totalCount,
          completed: client.workflowTracking.dataInputPoints.manual.completedCount,
          pending: client.workflowTracking.dataInputPoints.manual.pendingCount,
          onGoing: client.workflowTracking.dataInputPoints.manual.onGoingCount,
          notStarted: client.workflowTracking.dataInputPoints.manual.notStartedCount
        },
        api: {
          total: client.workflowTracking.dataInputPoints.api.totalCount,
          completed: client.workflowTracking.dataInputPoints.api.completedCount,
          pending: client.workflowTracking.dataInputPoints.api.pendingCount,
          onGoing: client.workflowTracking.dataInputPoints.api.onGoingCount,
          notStarted: client.workflowTracking.dataInputPoints.api.notStartedCount
        },
        iot: {
          total: client.workflowTracking.dataInputPoints.iot.totalCount,
          completed: client.workflowTracking.dataInputPoints.iot.completedCount,
          pending: client.workflowTracking.dataInputPoints.iot.pendingCount,
          onGoing: client.workflowTracking.dataInputPoints.iot.onGoingCount,
          notStarted: client.workflowTracking.dataInputPoints.iot.notStartedCount
        }
      },
      updatedBy: userId,
      timestamp: new Date().toISOString()
    };
    
    // Emit to assigned consultant
    if (client.workflowTracking.assignedConsultantId) {
      global.io.to(`user_${client.workflowTracking.assignedConsultantId}`).emit('dashboard_update', {
        type: 'data_input_point_update',
        data: updateData
      });
    }
    
    // Emit to consultant admin
    if (client.leadInfo.consultantAdminId) {
      global.io.to(`user_${client.leadInfo.consultantAdminId}`).emit('dashboard_update', {
        type: 'data_input_point_update',
        data: updateData
      });
    }
    
    // Emit to super admins
    global.io.to('userType_super_admin').emit('dashboard_update', {
      type: 'data_input_point_update',
      data: updateData
    });
  }
};

// Example: In createClient function after saving
const emitNewClientCreated = async (client, creatorId) => {
  if (global.io) {
    const updateData = {
      clientId: client.clientId,
      companyName: client.leadInfo.companyName,
      stage: client.stage,
      status: client.status,
      createdBy: creatorId,
      timestamp: new Date().toISOString()
    };
    
    // Emit to creator
    global.io.to(`user_${creatorId}`).emit('dashboard_update', {
      type: 'new_client_created',
      data: updateData
    });
    
    // If assigned to a consultant, notify them
    if (client.leadInfo.assignedConsultantId && 
        client.leadInfo.assignedConsultantId.toString() !== creatorId) {
      global.io.to(`user_${client.leadInfo.assignedConsultantId}`).emit('dashboard_update', {
        type: 'new_client_assigned',
        data: updateData
      });
    }
    
    // Notify super admins
    global.io.to('userType_super_admin').emit('dashboard_update', {
      type: 'new_client_created',
      data: updateData
    });
  }
};

// Example: In moveClientStage function after stage change
const emitClientStageChange = async (client, previousStage, userId) => {
  if (global.io) {
    const updateData = {
      clientId: client.clientId,
      companyName: client.leadInfo.companyName,
      previousStage: previousStage,
      newStage: client.stage,
      status: client.status,
      changedBy: userId,
      timestamp: new Date().toISOString()
    };
    
    // Notify all relevant users
    const affectedUsers = new Set();
    
    // Add consultant admin
    if (client.leadInfo.consultantAdminId) {
      affectedUsers.add(client.leadInfo.consultantAdminId.toString());
    }
    
    // Add assigned consultant
    if (client.leadInfo.assignedConsultantId) {
      affectedUsers.add(client.leadInfo.assignedConsultantId.toString());
    }
    
    // Add workflow assigned consultant
    if (client.workflowTracking.assignedConsultantId) {
      affectedUsers.add(client.workflowTracking.assignedConsultantId.toString());
    }
    
    // Emit to affected users
    affectedUsers.forEach(userId => {
      global.io.to(`user_${userId}`).emit('dashboard_update', {
        type: 'client_stage_change',
        data: updateData
      });
    });
    
    // Notify super admins
    global.io.to('userType_super_admin').emit('dashboard_update', {
      type: 'client_stage_change',
      data: updateData
    });
  }
};

// Generic function to emit dashboard refresh
const emitDashboardRefresh = async (userIds = [], dashboardTypes = ['metrics', 'workflow']) => {
  if (global.io) {
    const refreshData = {
      dashboardTypes: dashboardTypes,
      timestamp: new Date().toISOString()
    };
    
    if (userIds.length > 0) {
      // Emit to specific users
      userIds.forEach(userId => {
        global.io.to(`user_${userId}`).emit('dashboard_refresh', refreshData);
      });
    } else {
      // Emit to all admin users
      global.io.to('userType_super_admin').emit('dashboard_refresh', refreshData);
      global.io.to('userType_consultant_admin').emit('dashboard_refresh', refreshData);
      global.io.to('userType_consultant').emit('dashboard_refresh', refreshData);
    }
  }
};
// Add this function to handle real-time client updates after any client modification
// NEW: Enhanced client list update function
const emitClientListUpdate = async (client, action, userId) => {
  if (!global.io) return;
  
  try {
    // Determine affected users based on client data
    const affectedUserIds = new Set();
    
    // Add the user who made the change
    affectedUserIds.add(userId);
    
    // Add consultant admin
    if (client.leadInfo.consultantAdminId) {
      affectedUserIds.add(client.leadInfo.consultantAdminId.toString());
      
      // Get all consultants under this admin
      const consultants = await User.find({
        consultantAdminId: client.leadInfo.consultantAdminId,
        userType: 'consultant'
      }).select('_id');
      
      consultants.forEach(c => affectedUserIds.add(c._id.toString()));
    }
    
    // Add assigned consultants
    if (client.leadInfo.assignedConsultantId) {
      affectedUserIds.add(client.leadInfo.assignedConsultantId.toString());
    }
    
    if (client.workflowTracking?.assignedConsultantId) {
      affectedUserIds.add(client.workflowTracking.assignedConsultantId.toString());
    }
    
    // Add client users if client is active
    if (client.stage === 'active' && client.clientId) {
      const clientUsers = await User.find({
        clientId: client.clientId,
        isActive: true
      }).select('_id');
      
      clientUsers.forEach(u => affectedUserIds.add(u._id.toString()));
    }
    
    // Get all super admins
    const superAdmins = await User.find({
      userType: 'super_admin',
      isActive: true
    }).select('_id');
    
    superAdmins.forEach(sa => affectedUserIds.add(sa._id.toString()));
    
    // Prepare client data for emission
    const clientData = {
      _id: client._id,
      clientId: client.clientId,
      stage: client.stage,
      status: client.status,
      leadInfo: {
        companyName: client.leadInfo.companyName,
        contactPersonName: client.leadInfo.contactPersonName,
        email: client.leadInfo.email,
        mobileNumber: client.leadInfo.mobileNumber
      },
      workflowTracking: client.stage === 'active' ? {
        flowchartStatus: client.workflowTracking?.flowchartStatus,
        processFlowchartStatus: client.workflowTracking?.processFlowchartStatus
      } : undefined,
      accountDetails: client.stage === 'active' ? {
        subscriptionStatus: client.accountDetails?.subscriptionStatus,
        subscriptionEndDate: client.accountDetails?.subscriptionEndDate,
        activeUsers: client.accountDetails?.activeUsers
      } : undefined,
      updatedAt: client.updatedAt
    };
    
    // Emit to each affected user
    for (const affectedUserId of affectedUserIds) {
      global.io.to(`user_${affectedUserId}`).emit('client_list_update', {
        action: action, // 'created', 'updated', 'deleted', 'stage_changed'
        client: clientData,
        timestamp: new Date().toISOString()
      });
    }
    
    // Also emit to user type rooms
    global.io.to('userType_super_admin').emit('client_list_update', {
      action: action,
      client: clientData,
      timestamp: new Date().toISOString()
    });
    
    if (client.leadInfo.consultantAdminId) {
      global.io.to('userType_consultant_admin').emit('client_list_update', {
        action: action,
        client: clientData,
        timestamp: new Date().toISOString()
      });
    }
    
  } catch (error) {
    console.error('Error emitting client list update:', error);
  }
};

// NEW: Batch update for multiple clients
const emitBatchClientUpdate = async (clientIds, action, userId) => {
  if (!global.io || !clientIds.length) return;
  
  try {
    const clients = await Client.find({
      _id: { $in: clientIds },
      isDeleted: false
    }).populate('leadInfo.consultantAdminId leadInfo.assignedConsultantId workflowTracking.assignedConsultantId', '_id');
    
    for (const client of clients) {
      await emitClientListUpdate(client, action, userId);
    }
  } catch (error) {
    console.error('Error emitting batch client update:', error);
  }
};

// NEW: Emit filtered client list update
const emitFilteredClientListUpdate = async (filters = {}, userIds = []) => {
  if (!global.io) return;
  
  try {
    const { stage, status, search } = filters;
    const updateData = {
      type: 'client_list_filter_update',
      filters: { stage, status, search },
      timestamp: new Date().toISOString()
    };
    
    if (userIds.length > 0) {
      userIds.forEach(userId => {
        global.io.to(`user_${userId}`).emit('client_filter_update', updateData);
      });
    } else {
      // Emit to all admin users
      global.io.to('userType_super_admin').emit('client_filter_update', updateData);
      global.io.to('userType_consultant_admin').emit('client_filter_update', updateData);
      global.io.to('userType_consultant').emit('client_filter_update', updateData);
    }
  } catch (error) {
    console.error('Error emitting filtered client list update:', error);
  }
};

// Usage Examples in your controller functions:

// In updateFlowchartStatus:
// await client.save();
// await emitFlowchartStatusUpdate(client, req.user.id);

// In updateManualInputStatus:
// await client.save();
// await emitDataInputPointUpdate(client, 'manual', pointId, req.user.id);

// In createClient:
// await newClient.save();
// await emitNewClientCreated(newClient, req.user.id);

// In moveClientStage:
// const previousStage = client.stage;
// await client.save();
// await emitClientStageChange(client, previousStage, req.user.id);

module.exports = {
  emitFlowchartStatusUpdate,
  emitDataInputPointUpdate,
  emitNewClientCreated,
  emitClientStageChange,
  emitDashboardRefresh,
  emitClientListUpdate,
  emitBatchClientUpdate,
  emitFilteredClientListUpdate
};