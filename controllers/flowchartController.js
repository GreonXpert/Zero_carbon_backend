// controllers/flowchartController.js (UPDATED)
const Flowchart = require('../models/Flowchart');
const mongoose = require('mongoose');

// Save or update entire flowchart
const saveFlowchart = async (req, res) => {
  const { userId, flowchartData } = req.body;

  // Validate incoming payload
  if (!userId || !flowchartData || !Array.isArray(flowchartData.nodes) || !Array.isArray(flowchartData.edges)) {
    return res.status(400).json({ message: 'Missing required fields: userId, flowchartData.nodes or flowchartData.edges' });
  }

  try {
    // Default flags for API and IoT
    const defaultDetailFields = {
      apiStatus: false,
      apiEndpoint: '',
      iotStatus: false,
    };

    // Find existing or create new
    const existing = await Flowchart.findOne({ userId });

    // Normalize nodes
    const normalizedNodes = flowchartData.nodes.map((node) => {
      // ensure details is an object
      const details = typeof node.details === 'object' && node.details !== null ? node.details : {};
      return {
        id: node.id,
        label: node.label,
        position: node.position,
        parentNode: node.parentNode || null,
        details: {
          ...defaultDetailFields,
          ...details,
        },
      };
    });

    // Normalize edges
    const normalizedEdges = flowchartData.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
    }));

    if (existing) {
      existing.nodes = normalizedNodes;
      existing.edges = normalizedEdges;
      await existing.save();
      return res.status(200).json({ message: 'Flowchart updated successfully' });
    } else {
      const created = new Flowchart({
        userId,
        nodes: normalizedNodes,
        edges: normalizedEdges,
      });
      await created.save();
      return res.status(200).json({ message: 'Flowchart saved successfully' });
    }
  } catch (err) {
    console.error('Error saving flowchart:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};







// Get by admin: all nodes & edges
const getFlowchart = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'Valid userId is required.' });
    }
    const fc = await Flowchart.findOne({ userId });
    if (!fc) return res.status(404).json({ message: 'Flowchart not found.' });

    res.status(200).json({
      nodes: fc.nodes.map((n) => ({
        id: n.id,
        data: { label: n.label, details: n.details || {} },
        position: n.position,
        ...(n.parentNode ? { parentNode: n.parentNode } : {}),
      })),
      edges: fc.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    });
  } catch (err) {
    console.error('Error fetching flowchart:', err);
    res.status(500).json({ message: 'Server error fetching flowchart.' });
  }
};

// Get for authenticated user
const getFlowchartUser = async (req, res) => {
  try {
    const uid = req.user._id;
    const fc = await Flowchart.findOne({ userId: uid });
    if (!fc) return res.status(200).json({ nodes: [], edges: [] });

    res.status(200).json({
      nodes: fc.nodes.map((n) => ({
        id: n.id,
        data: { label: n.label, details: n.details || {} },
        position: n.position,
        ...(n.parentNode ? { parentNode: n.parentNode } : {}),
      })),
      edges: fc.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    });
  } catch (err) {
    console.error('Error fetching flowchart user:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Update Flowchart for a specific user
const updateFlowchartUser = async (req, res) => {
  try {
    const userId = req.user._id; // The userId should be extracted from the authenticated user's token
    const { nodes, edges } = req.body; // Flowchart data (nodes and edges) from the request body
    console.log("update UseriD:", userId);
    console.log(" nodes, edges:", nodes, edges);
    // Find the flowchart for the user
    const flowchart = await Flowchart.findOne({ userId });

    if (!flowchart) {
      return res
        .status(404)
        .json({ message: "Flowchart not found for this user" });
    }

    // Update the flowchart nodes and edges
    flowchart.nodes = nodes;
    flowchart.edges = edges;     

    // Save the updated flowchart
    await flowchart.save();

    res
      .status(200)
      .json({ message: "Flowchart updated successfully", flowchart });
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ message: "Failed to update flowchart", error: error.message });
  }
}; 




// Admin: update single node or entire flowchart
const updateFlowchartAdmin = async (req, res) => {
  try {
    const { userId, nodeId, updatedData, nodes, edges } = req.body;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid userId format" });
    }
    const uid = new mongoose.Types.ObjectId(userId);
    const fc = await Flowchart.findOne({ userId: uid });
    if (!fc) return res.status(404).json({ message: "Flowchart not found for this user" });

    // Single‑node update
    if (nodeId && updatedData) {
      const node = fc.nodes.find(n => n.id === nodeId);
      if (!node) {
        return res.status(404).json({ message: "Node not found" });
      }
      node.label = updatedData.label ?? node.label;
      node.details = updatedData.details ?? node.details;
      if (updatedData.position) node.position = updatedData.position;
      await fc.save();
      return res.status(200).json({ message: "Node updated successfully", node });
    }

    // Bulk update: replace all nodes & edges
    if (Array.isArray(nodes) && Array.isArray(edges)) {
      fc.nodes = nodes;
      fc.edges = edges;
      await fc.save();
      return res.status(200).json({ message: "Flowchart updated successfully", flowchart: fc });
    }

    return res.status(400).json({ message: "Missing parameters for update" });
  } catch (err) {
    console.error("Error updating flowchart:", err);
    return res.status(500).json({ message: "Failed to update flowchart", error: err.message });
  }
};




const deleteFlowchartUser=async(req,res,next)=>{
  const userId = req.user._id;
  const { nodeId } = req.body;
console.log("nodeid:",nodeId)
  try {
    // Find the flowchart for the user
    const flowchart = await Flowchart.findOne({ userId });

    if (!flowchart) {
      return res.status(404).json({ message: 'Flowchart not found' });
    }

    // Filter out the node to delete and its edges
    flowchart.nodes = flowchart.nodes.filter((node) => node.id !== nodeId);
    flowchart.edges = flowchart.edges.filter(
      (edge) => edge.source !== nodeId && edge.target !== nodeId
    );

    // Save updated flowchart
    await flowchart.save();

    res.status(200).json({ message: 'Node and associated edges deleted successfully', flowchart });
  } catch (error) {
    console.error('Error deleting node:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
}
// Admin: delete single node
const deleteFlowchartAdmin = async (req, res) => {
  try {
    const userId = req.body.userId || req.query.userId;
    const nodeId = req.body.nodeId || req.query.nodeId;
    if (!userId || !nodeId) {
      return res.status(400).json({ message: "Missing userId or nodeId" });
    }
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid userId format" });
    }
    const uid = new mongoose.Types.ObjectId(userId);
    const fc = await Flowchart.findOne({ userId: uid });
    if (!fc) return res.status(404).json({ message: "Flowchart not found" });

    fc.nodes = fc.nodes.filter(n => n.id !== nodeId);
    fc.edges = fc.edges.filter(e => e.source !== nodeId && e.target !== nodeId);
    await fc.save();

    return res.status(200).json({ message: "Node and associated edges deleted successfully", flowchart: fc });
  } catch (err) {
    console.error("Error deleting node:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};


/**
 * POST /api/flowchart/connect-api
 * Body: { userId, nodeId, endpoint }
 */
const connectApi = async (req, res) => {
  const { userId, nodeId, endpoint } = req.body;
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return res.status(400).json({ message: "Invalid userId." });
  }
  const fc = await Flowchart.findOne({ userId });
  if (!fc) return res.status(404).json({ message: "Flowchart not found." });

  // find the node index
  const idx = fc.nodes.findIndex(n => n.id === nodeId);
  if (idx < 0) return res.status(404).json({ message: "Node not found." });

  // mutate
  fc.nodes[idx].details.apiStatus   = true;
  fc.nodes[idx].details.apiEndpoint = endpoint;

  // **mark it modified** so Mongoose will persist your changes
  fc.markModified(`nodes.${idx}.details`);

  await fc.save();
  return res.status(200).json({ message: "API connected on node." });
};

/**
 * POST /api/flowchart/disconnect-api
 * Body: { userId, nodeId }
 */
const disconnectApi = async (req, res) => {
  const { userId, nodeId } = req.body;
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return res.status(400).json({ message: "Invalid userId." });
  }
  const fc = await Flowchart.findOne({ userId });
  if (!fc) return res.status(404).json({ message: "Flowchart not found." });

  const node = fc.nodes.find(n => n.id === nodeId);
  if (!node) return res.status(404).json({ message: "Node not found." });

  node.details.apiStatus   = false;
  node.details.apiEndpoint = "";
  await fc.save();
  return res.status(200).json({ message: "API disconnected on node." });
};


module.exports = {
  saveFlowchart,
  getFlowchart,
  getFlowchartUser,
  updateFlowchartUser,
  updateFlowchartAdmin,
  deleteFlowchartUser ,
  deleteFlowchartAdmin,
  connectApi,          // ← new
  disconnectApi       // ← new
};
