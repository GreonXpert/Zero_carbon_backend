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
  emitDashboardRefresh
};