const Client = require("../../models/Client");



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
    autoUpdateFlowchartStatus
}