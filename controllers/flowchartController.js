// controllers/flowchartController.js (UPDATED WITH VALIDATION INTEGRATION)
const Flowchart = require('../models/Flowchart');
const mongoose = require('mongoose');

// ============================================================================
// VALIDATION FUNCTIONS - These will be used in multiple places
// ============================================================================

// Enhanced validation function for flowchart scope details
// Supports multiple scopes of the same type within a single node
function validateScopeDetails(scopeDetails) {
  if (!Array.isArray(scopeDetails)) {
    throw new Error("scopeDetails must be an array");
  }

  // Track scope types for reporting
  const scopeCounts = {};

  scopeDetails.forEach((scope, index) => {
    const { scopeType } = scope;
    
    if (!scopeType) {
      throw new Error(`Scope at index ${index} must have a scopeType`);
    }

    // Count scope types
    scopeCounts[scopeType] = (scopeCounts[scopeType] || 0) + 1;

    switch (scopeType) {
      case "Scope 1":
        // Validate Scope 1 required fields
        if (!scope.emissionFactor || !scope.activity || !scope.fuel || !scope.units) {
          throw new Error(`Scope 1 at index ${index} requires: emissionFactor, activity, fuel, units`);
        }
        
        if (!["IPCC", "DEFRA"].includes(scope.emissionFactor)) {
          throw new Error(`Scope 1 emissionFactor must be "IPCC" or "DEFRA"`);
        }
        break;

      case "Scope 2":
        // Validate Scope 2 required fields
        if (!scope.country || !scope.regionGrid) {
          throw new Error(`Scope 2 at index ${index} requires: country, regionGrid`);
        }
        
        if (!scope.units || !["kWh", "MWh", "kwh", "mwh"].includes(scope.units.toLowerCase())) {
          console.warn(`Scope 2 should typically use kWh or MWh units, got: ${scope.units}`);
        }
        break;

      case "Scope 3":
        // Validate Scope 3 required fields
        if (!scope.category || !scope.activityDescription || !scope.itemName || !scope.units) {
          throw new Error(`Scope 3 at index ${index} requires: category, activityDescription, itemName, units`);
        }
        break;

      default:
        throw new Error(`Unsupported scopeType: ${scopeType}. Supported: Scope 1, Scope 2, Scope 3`);
    }
  });

  // Log scope distribution for debugging
  console.log(`📊 Scope distribution:`, scopeCounts);
  
  return scopeCounts;
}

// Helper function to get scope summary for a node
function getScopeSummary(scopeDetails) {
  const summary = {
    total: scopeDetails.length,
    byType: {},
    details: []
  };

  scopeDetails.forEach((scope, index) => {
    const type = scope.scopeType;
    if (!summary.byType[type]) {
      summary.byType[type] = [];
    }
    
    summary.byType[type].push({
      index,
      description: `${type} - ${scope.emissionFactor || scope.country || scope.category || 'Unknown'}`
    });
    
    summary.details.push({
      index,
      scopeType: type,
      identifier: scope.emissionFactor || `${scope.country}-${scope.regionGrid}` || scope.category,
      activity: scope.activity || scope.activityDescription || 'N/A'
    });
  });

  return summary;
}

// ============================================================================
// MAIN FLOWCHART FUNCTIONS - Now using validation
// ============================================================================

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

    // Normalize nodes WITH VALIDATION
    const normalizedNodes = flowchartData.nodes.map((node) => {
      const details = typeof node.details === 'object' && node.details !== null ? node.details : {};
      
      // 🔥 USE VALIDATION HERE - Validate scopeDetails if present
      if (details.scopeDetails && Array.isArray(details.scopeDetails) && details.scopeDetails.length > 0) {
        try {
          console.log(`🔍 Validating scopes for node ${node.id} (${node.label})`);
          const scopeCounts = validateScopeDetails(details.scopeDetails);
          console.log(`✅ Node ${node.id} validation passed. Scope counts:`, scopeCounts);
        } catch (error) {
          console.error(`❌ Node ${node.id} validation failed:`, error.message);
          throw new Error(`Node ${node.id} (${node.label}) validation failed: ${error.message}`);
        }
      }

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
      console.log(`✅ Flowchart updated for user ${userId}`);
      return res.status(200).json({ message: 'Flowchart updated successfully' });
    } else {
      const created = new Flowchart({
        userId,
        nodes: normalizedNodes,
        edges: normalizedEdges,
      });
      await created.save();
      console.log(`✅ New flowchart created for user ${userId}`);
      return res.status(200).json({ message: 'Flowchart saved successfully' });
    }
  } catch (err) {
    console.error('❌ Error saving flowchart:', err);
    return res.status(500).json({ 
      message: 'Flowchart validation failed', 
      error: err.message 
    });
  }
};

// Update Flowchart for a specific user
const updateFlowchartUser = async (req, res) => {
  try {
    const userId = req.user._id;
    const { nodes, edges } = req.body;
    
    console.log("🔄 Updating flowchart for user:", userId);

    // Find the flowchart for the user
    const flowchart = await Flowchart.findOne({ userId });

    if (!flowchart) {
      return res.status(404).json({ message: "Flowchart not found for this user" });
    }

    // 🔥 VALIDATE NODES BEFORE UPDATING
    if (Array.isArray(nodes)) {
      for (const node of nodes) {
        if (node.details?.scopeDetails && Array.isArray(node.details.scopeDetails) && node.details.scopeDetails.length > 0) {
          try {
            console.log(`🔍 Validating scopes for node ${node.id} during update`);
            validateScopeDetails(node.details.scopeDetails);
            console.log(`✅ Node ${node.id} validation passed during update`);
          } catch (error) {
            console.error(`❌ Node ${node.id} validation failed during update:`, error.message);
            return res.status(400).json({
              message: `Node ${node.id} validation failed: ${error.message}`,
              nodeLabel: node.label || 'Unknown'
            });
          }
        }
      }
    }

    // Update the flowchart nodes and edges
    flowchart.nodes = nodes;
    flowchart.edges = edges;

    // Save the updated flowchart
    await flowchart.save();

    console.log(`✅ Flowchart updated successfully for user ${userId}`);
    res.status(200).json({ message: "Flowchart updated successfully", flowchart });
  } catch (error) {
    console.error("❌ Error updating flowchart:", error);
    res.status(500).json({ message: "Failed to update flowchart", error: error.message });
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

    // Single-node update
    if (nodeId && updatedData) {
      const nodeIndex = fc.nodes.findIndex(n => n.id === nodeId);
      if (nodeIndex === -1) {
        return res.status(404).json({ message: "Node not found" });
      }

      // 🔥 VALIDATE SCOPE DETAILS IF UPDATING THEM
      if (updatedData.details?.scopeDetails && Array.isArray(updatedData.details.scopeDetails)) {
        try {
          console.log(`🔍 Admin validating scopes for node ${nodeId}`);
          validateScopeDetails(updatedData.details.scopeDetails);
          console.log(`✅ Admin validation passed for node ${nodeId}`);
        } catch (error) {
          console.error(`❌ Admin validation failed for node ${nodeId}:`, error.message);
          return res.status(400).json({
            message: `Node ${nodeId} validation failed: ${error.message}`
          });
        }
      }

      const node = fc.nodes[nodeIndex];
      node.label = updatedData.label ?? node.label;
      node.details = updatedData.details ?? node.details;
      if (updatedData.position) node.position = updatedData.position;
      
      await fc.save();
      return res.status(200).json({ message: "Node updated successfully", node });
    }

    // Bulk update: replace all nodes & edges
    if (Array.isArray(nodes) && Array.isArray(edges)) {
      // 🔥 VALIDATE ALL NODES BEFORE BULK UPDATE
      for (const node of nodes) {
        if (node.details?.scopeDetails && Array.isArray(node.details.scopeDetails) && node.details.scopeDetails.length > 0) {
          try {
            console.log(`🔍 Admin bulk validating scopes for node ${node.id}`);
            validateScopeDetails(node.details.scopeDetails);
          } catch (error) {
            console.error(`❌ Admin bulk validation failed for node ${node.id}:`, error.message);
            return res.status(400).json({
              message: `Bulk update validation failed for node ${node.id}: ${error.message}`,
              nodeLabel: node.label || 'Unknown'
            });
          }
        }
      }

      fc.nodes = nodes;
      fc.edges = edges;
      await fc.save();
      return res.status(200).json({ message: "Flowchart updated successfully", flowchart: fc });
    }

    return res.status(400).json({ message: "Missing parameters for update" });
  } catch (err) {
    console.error("❌ Error updating flowchart:", err);
    return res.status(500).json({ message: "Failed to update flowchart", error: err.message });
  }
};

// Get flowchart with scope summary
const getFlowchartWithScopeSummary = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'Valid userId is required.' });
    }
    
    const fc = await Flowchart.findOne({ userId });
    if (!fc) return res.status(404).json({ message: 'Flowchart not found.' });

    // 🔥 USE getScopeSummary HERE
    const enhancedNodes = fc.nodes.map((node) => {
      const baseNode = {
        id: node.id,
        data: { label: node.label, details: node.details || {} },
        position: node.position,
        ...(node.parentNode ? { parentNode: node.parentNode } : {}),
      };

      // Add scope summary if scopeDetails exist
      if (node.details?.scopeDetails && Array.isArray(node.details.scopeDetails) && node.details.scopeDetails.length > 0) {
        try {
          const scopeSummary = getScopeSummary(node.details.scopeDetails);
          baseNode.scopeSummary = scopeSummary;
          console.log(`📊 Generated scope summary for node ${node.id}:`, scopeSummary);
        } catch (error) {
          console.warn(`⚠️ Could not generate scope summary for node ${node.id}:`, error.message);
          baseNode.scopeSummary = null;
        }
      }

      return baseNode;
    });

    res.status(200).json({
      nodes: enhancedNodes,
      edges: fc.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    });
  } catch (err) {
    console.error('❌ Error fetching flowchart with scope summary:', err);
    res.status(500).json({ message: 'Server error fetching flowchart.' });
  }
};

// ============================================================================
// EXISTING FUNCTIONS (unchanged)
// ============================================================================

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

const deleteFlowchartUser = async (req, res, next) => {
  const userId = req.user._id;
  const { nodeId } = req.body;
  console.log("nodeid:", nodeId);
  
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
};

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

const connectApi = async (req, res) => {
  const { userId, nodeId, endpoint } = req.body;
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return res.status(400).json({ message: "Invalid userId." });
  }
  const fc = await Flowchart.findOne({ userId });
  if (!fc) return res.status(404).json({ message: "Flowchart not found." });

  const idx = fc.nodes.findIndex(n => n.id === nodeId);
  if (idx < 0) return res.status(404).json({ message: "Node not found." });

  fc.nodes[idx].details.apiStatus = true;
  fc.nodes[idx].details.apiEndpoint = endpoint;
  fc.markModified(`nodes.${idx}.details`);

  await fc.save();
  return res.status(200).json({ message: "API connected on node." });
};

const disconnectApi = async (req, res) => {
  const { userId, nodeId } = req.body;
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return res.status(400).json({ message: "Invalid userId." });
  }
  const fc = await Flowchart.findOne({ userId });
  if (!fc) return res.status(404).json({ message: "Flowchart not found." });

  const node = fc.nodes.find(n => n.id === nodeId);
  if (!node) return res.status(404).json({ message: "Node not found." });

  node.details.apiStatus = false;
  node.details.apiEndpoint = "";
  await fc.save();
  return res.status(200).json({ message: "API disconnected on node." });
};

module.exports = {
  saveFlowchart,
  getFlowchart,
  getFlowchartUser,
  getFlowchartWithScopeSummary, // 🔥 NEW FUNCTION
  updateFlowchartUser,
  updateFlowchartAdmin,
  deleteFlowchartUser,
  deleteFlowchartAdmin,
  connectApi,
  disconnectApi,
  // Export utility functions for reuse
  validateScopeDetails,
  getScopeSummary
};