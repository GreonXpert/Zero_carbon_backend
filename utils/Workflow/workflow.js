const Client = require("../../models/CMS/Client");
const Reduction = require("../../models/Reduction/Reduction");



// Compute and persist Reduction workflow status + counters
const syncReductionWorkflow = async (clientId, userId) => {
  try {
    const client = await Client.findOne({ clientId });
    if (!client) return;

    // If this client hasn't opted into reduction, we still keep counters, but we won't force statuses.
    const reductions = await Reduction.find({
      clientId,
      $or: [{ isDeleted: false }, { isDeleted: { $exists: false } }]
    }).select("commissioningDate endDate createdAt reductionDataEntry.inputType").lean();

    const now = new Date();
    const total = reductions.length;

    let pending = 0, active = 0, completed = 0;
    for (const r of reductions) {
      const start = r.commissioningDate ? new Date(r.commissioningDate) : null;
      const end   = r.endDate ? new Date(r.endDate) : null;

      if (start && start > now) {
        pending++;
      } else if (end && end < now) {
        completed++;
      } else if (start && (!end || end >= now)) {
        active++;
      } else {
        // no valid dates: treat as pending
        pending++;
      }
    }

    const lastCreatedAt = reductions.length
   ? new Date(Math.max(...reductions.map(r => new Date(r.createdAt || 0).getTime())))
   : undefined;

    // Ensure block exists
    if (!client.workflowTracking.reduction) {
      client.workflowTracking.reduction = { status: 'not_started' };
    }

    // Counters
    client.workflowTracking.reduction.projects = {
      totalCount: total,
      activeCount: active,
      completedCount: completed,
      pendingCount: pending,
      lastProjectCreatedAt: lastCreatedAt
    };


    // Count reduction data entry by input type
let manualCount = 0, apiCount = 0, iotCount = 0;

for (const r of reductions) {
  // In the model, inputType is normalized to 'manual', 'API', or 'IOT'
  const t = String(r?.reductionDataEntry?.inputType || 'manual').toUpperCase();
  if (t === 'API') {
    apiCount++;
  } else if (t === 'IOT') {
    iotCount++;
  } else {
    manualCount++;
  }
}

// Ensure block exists
if (!client.workflowTracking.reduction) {
  client.workflowTracking.reduction = { status: 'not_started' };
}

// ✅ Persist the new totals
client.workflowTracking.reduction.dataInputPoints = {
  manual: { totalCount: manualCount },
  api:    { totalCount: apiCount },
  iot:    { totalCount: iotCount },
  totalDataPoints: manualCount + apiCount + iotCount
};


    // Status machine
    const prevStatus = client.workflowTracking.reduction.status || 'not_started';
    let nextStatus = 'not_started';
    if (total === 0) {
      nextStatus = 'not_started';
    } else if (active > 0) {
      nextStatus = 'on_going';
    } else if (pending === total) {
      nextStatus = 'pending';
    } else if (completed === total) {
      nextStatus = 'completed';
    } else {
      nextStatus = 'on_going';
    }

    client.workflowTracking.reduction.status = nextStatus;

    // Timestamps + timeline (only on transitions)
    if (prevStatus === 'not_started' && nextStatus !== 'not_started') {
      client.workflowTracking.reduction.startedAt = now;
      client.timeline.push({
        stage: client.stage,
        status: client.status,
        action: "Reduction module started",
        performedBy: userId,
        notes: `First reduction project created (total=${total}).`
      });
    }

    if (prevStatus !== 'completed' && nextStatus === 'completed') {
      client.workflowTracking.reduction.completedAt = now;
      client.timeline.push({
        stage: client.stage,
        status: client.status,
        action: "Reduction module completed",
        performedBy: userId,
        notes: `All ${total} reduction projects have ended.`
      });
    }

    if (prevStatus !== nextStatus && !['not_started', 'completed'].includes(nextStatus)) {
      client.timeline.push({
        stage: client.stage,
        status: client.status,
        action: `Reduction module status → ${nextStatus}`,
        performedBy: userId
      });
    }

    await client.save();
  } catch (err) {
    console.error("syncReductionWorkflow error:", err);
    // non-fatal
  }
};


// Auto-update process flowchart status when consultant starts creating
const autoUpdateProcessFlowchartStatus = async (clientId, userId) => {
  try {
    const client = await Client.findOne({ clientId });
    if (!client) return;
    
    // Only update if status is not_started
    if (client.workflowTracking.processFlowchartStatus === 'not_started') {
      client.workflowTracking.processFlowchartStatus = 'on_going';
      client.workflowTracking.processFlowchartStartedAt = new Date();
      
      client.timeline.push({
        stage: client.stage,
        status: client.status,
        action: "Process flowchart creation started",
        performedBy: userId,
        notes: "Status automatically updated to on-going"
      });
      
      await client.save();
      console.log(`Auto-updated process flowchart status to on-going for client ${clientId}`);
    }
  } catch (error) {
    console.error("Auto update process flowchart status error:", error);
    // Don't throw error to prevent disrupting the main flow
  }
};

// Auto-update flowchart status when consultant starts creating
const autoUpdateFlowchartStatus = async (clientId, userId) => {
  try {
    const client = await Client.findOne({ clientId });
    if (!client) return;
    
    // Only update if status is not_started
    if (client.workflowTracking.flowchartStatus === 'not_started') {
      client.workflowTracking.flowchartStatus = 'on_going';
      client.workflowTracking.flowchartStartedAt = new Date();
      
      client.timeline.push({
        stage: client.stage,
        status: client.status,
        action: "Flowchart creation started",
        performedBy: userId,
        notes: "Status automatically updated to on-going"
      });
      
      await client.save();
      console.log(`Auto-updated flowchart status to on-going for client ${clientId}`);
    }
  } catch (error) {
    console.error("Auto update flowchart status error:", error);
    // Don't throw error to prevent disrupting the main flow
  }
};

module.exports = {
    autoUpdateProcessFlowchartStatus,
    autoUpdateFlowchartStatus,
    syncReductionWorkflow
}