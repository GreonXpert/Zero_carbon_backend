const Flowchart = require ('../../models/Flowchart');
const ProcessFlowchart =require ('../../models/ProcessFlowchart');

// Helper function to get active flowchart (either Flowchart or ProcessFlowchart)
const getActiveFlowchart = async (clientId) => {
  try {
    // First check for regular Flowchart
    const flowchart = await Flowchart.findOne({ clientId, isActive: true });
    if (flowchart) {
      return { chart: flowchart, type: 'flowchart' };
    }
    
    // If not found, check for ProcessFlowchart
    const processFlowchart = await ProcessFlowchart.findOne({ clientId, isActive: true });
    if (processFlowchart) {
      return { chart: processFlowchart, type: 'processFlowchart' };
    }
    
    // Neither found
    return null;
  } catch (error) {
    console.error('Error fetching active flowchart:', error);
    return null;
  }
};

module.exports = {
    getActiveFlowchart
}