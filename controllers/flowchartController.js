const Flowchart = require("../models/Flowchart");
const mongoose = require("mongoose"); 
// // Save Flowchart Data-
// const saveFlowchart = async (req, res) => {
//   const { userId, flowchartData } = req.body;
//   console.log("userIdflowchart:", userId);
//   // console.log("flowchartdata:", flowchartData);
//   try {
//     const existingFlowchart = await Flowchart.findOne({ userId });

//     if (existingFlowchart) {
//       // Update existing flowchart
//       existingFlowchart.nodes = flowchartData.nodes;
//       existingFlowchart.edges = flowchartData.edges;
//       await existingFlowchart.save();
//     } else {
//       // Create new flowchart
//       const newFlowchart = new Flowchart({ userId, ...flowchartData });
//       await newFlowchart.save();
//     }
//     console.log("flwchart saved successfully");
//     res.status(200).json({ message: "Flowchart saved successfully" });
//   } catch (error) {
//     console.error("Error saving flowchart:", error);
//     res.status(500).json({ message: "Internal server error" });
//   }
// };

// Save Flowchart Data-testing
const saveFlowchart = async (req, res) => {
  const { userId, flowchartData } = req.body;

  // Validate required fields
  if (!userId || !flowchartData || !flowchartData.nodes || !flowchartData.edges) {
    return res.status(400).json({ message: "Missing required fields: userId or flowchart data" });
  }

  try {
    // Check if the user already has an existing flowchart
    const existingFlowchart = await Flowchart.findOne({ userId });

    if (existingFlowchart) {
      // Update existing flowchart – preserve details as an object
      existingFlowchart.nodes = flowchartData.nodes.map((node) => ({
        id: node.id,
        label: node.label,
        position: node.position,
        parentNode: node.parentNode || null,
        details: node.details || {}, // Use object as default
      }));
      existingFlowchart.edges = flowchartData.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
      }));

      await existingFlowchart.save();
      console.log("Flowchart updated successfully");
      return res.status(200).json({ message: "Flowchart updated successfully" });
    } else {
      // Create a new flowchart document
      const newFlowchart = new Flowchart({
        userId,
        nodes: flowchartData.nodes.map((node) => ({
          id: node.id,
          label: node.label,
          position: node.position,
          parentNode: node.parentNode || null,
          details: node.details || {},
        })),
        edges: flowchartData.edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
        })),
      });
      await newFlowchart.save();
      console.log("Flowchart saved successfully");
      return res.status(200).json({ message: "Flowchart saved successfully" });
    }
  } catch (error) {
    console.error("Error saving flowchart:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};






// Get Flowchart Data
const getFlowchart = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ message: "User ID is required." });
    }
    // Fetch the flowchart from the database
    const flowchart = await Flowchart.findOne({ userId });
    console.log("flowchartAdmin:",flowchart);
    if (!flowchart) {
      return res.status(404).json({ message: "Flowchart not found." });
    }

    res.status(200).json({
      nodes: flowchart.nodes.map((node) => ({
        id: node.id,
        data: {
          label: node.label,
          details: node.details || "",
        },
        position: node.position,
        ...(node.parentNode ? { parentNode: node.parentNode } : {}),
      })),
      edges: flowchart.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
      })),
    });
  } catch (error) { 
    console.error(error);
    res.status(500).json({ message: "Server error fetching flowchart." });
  }
};

// Function to get flowchart data for the logged-in user
const getFlowchartUser = async (req, res) => {
  try {
    // Retrieve the user's flowcharts from the database
    const flowchart = await Flowchart.findOne({ userId: req.user._id });
    console.log("flowchart:", flowchart);

     // If no flowchart found, return empty nodes and edges instead of a 404
     if (!flowchart) {
      return res.status(200).json({ nodes: [], edges: [] });
    }

    res.status(200).json({
      nodes: flowchart.nodes.map((node) => ({
        id: node.id,
        data: {
          label: node.label,
          details: node.details || "",
        },
        position: node.position,
        ...(node.parentNode ? { parentNode: node.parentNode } : {}),
      })),
      edges: flowchart.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
      })),
    });
  } catch (error) {
    console.error("Error fetching flowchart:", error);
    res.status(500).json({ message: "Server error" });
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




// const updateFlowchartAdmin = async (req, res) => {
//   try {
//     const { userId, nodes, edges } = req.body;

//     // Validate and convert userId to ObjectId
//     if (!mongoose.Types.ObjectId.isValid(userId)) {
//       return res.status(400).json({ message: "Invalid userId format" });
//     }
//     const userIdObject = new mongoose.Types.ObjectId(userId);

//     console.log("Admin side userId:", userIdObject);
//     console.log("Nodes, Edges:", nodes, edges);

//     // Find the flowchart for the user
//     const flowchart = await Flowchart.findOne({ userId: userIdObject });       

//     if (!flowchart) {
//       return res
//         .status(404)
//         .json({ message: "Flowchart not found for this user" });
//     }

//     // Update the flowchart nodes and edges
//     flowchart.nodes = nodes;
//     flowchart.edges = edges;

//     // Save the updated flowchart
//     await flowchart.save();

//     res.status(200).json({ message: "Flowchart updated successfully", flowchart });
//   } catch (error) {
//     console.error("Error updating flowchart:", error);
//     res.status(500).json({ message: "Failed to update flowchart", error: error.message });
//   }
// };

//updateflowchartadmin-testing
const updateFlowchartAdmin = async (req, res) => {
  try {
    const { userId, nodes, edges } = req.body;

    // Validate and convert userId to ObjectId
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid userId format" });
    }
    const userIdObject = new mongoose.Types.ObjectId(userId);

    console.log("Admin side userId:", userIdObject);
    console.log("Nodes, Edges:", nodes, edges);

    // Find the flowchart for the user
    const flowchart = await Flowchart.findOne({ userId: userIdObject });

    if (!flowchart) {
      return res.status(404).json({ message: "Flowchart not found for this user" });
    }

    // Update the flowchart nodes and edges
    const updatedNodes = nodes.map((node) => {
      const existingNode = flowchart.nodes.find((n) => n.id === node.id);

      if (existingNode) {
        // Update node details
        existingNode.data = node.data;
        existingNode.position = node.position;
        existingNode.parentNode = node.parentNode || null;
      }
      return existingNode || node;
    });

    flowchart.nodes = updatedNodes;
    flowchart.edges = edges;

    // Save the updated flowchart
    await flowchart.save();

    res.status(200).json({ message: "Flowchart updated successfully", flowchart });
  } catch (error) {
    console.error("Error updating flowchart:", error);
    res.status(500).json({ message: "Failed to update flowchart", error: error.message });
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
const deleteFlowchartAdmin=async(req,res,next)=>{
  const { userId, nodeId } = req.query; // Use query parametersconsole.log("nodeid:",nodeId)
console.log("userId:",userId)
  try {
    const userIdObject = new mongoose.Types.ObjectId(userId);

    // Find the flowchart for the user
    const flowchart = await Flowchart.findOne({ userId: userIdObject});

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

module.exports = {
  saveFlowchart,
  getFlowchart,
  getFlowchartUser,
  updateFlowchartUser,
  updateFlowchartAdmin,
  deleteFlowchartUser ,
  deleteFlowchartAdmin
};
