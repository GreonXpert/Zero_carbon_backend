db.clients.updateMany(
  { workflowTracking: { $type: "string" } },
  {
    $set: {
      workflowTracking: {
        flowchartStatus: "not_started",
        processFlowchartStatus: "not_started",
        dataInputPoints: {
          manual: { inputs: [], totalCount: 0, completedCount: 0, pendingCount: 0, onGoingCount: 0, notStartedCount: 0 },
          api:    { inputs: [], totalCount: 0, completedCount: 0, pendingCount: 0, onGoingCount: 0, notStartedCount: 0 },
          iot:    { inputs: [], totalCount: 0, completedCount: 0, pendingCount: 0, onGoingCount: 0, notStartedCount: 0 },
          totalDataPoints: 0,
          lastSyncedWithFlowchart: null
        }
      }
    }
  }
);