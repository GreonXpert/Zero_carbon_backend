const express = require("express");
const router = express.Router();
const { auth, checkRole, checkPermission } = require("../middleware/auth"); // Using the comprehensive auth from middleware folder
const { uploadUserImage } = require('../utils/uploads/userImageUploadS3');
const {
  login,
  createConsultantAdmin,
  createConsultant,
  createEmployeeHead,
  createEmployee,
  createAuditor,
  createViewer,
  getUsers,
  updateUser,
  toggleUserStatus,
  changePassword,
  deleteUser,
  forgotPassword,
  resetPassword,
  verifyResetToken,
  assignHeadToNode,
  assignScope,
  getNodeAssignments,
  getMyAssignments,
  removeAssignment
} = require("../controllers/userController");

// Import User model for the inline routes
const User = require("../models/User");

// Public routes
router.post("/login", login);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);
router.post("/verify-reset-token", verifyResetToken); // Optional endpoint

// Protected routes - require authentication
router.use(auth); // Using the comprehensive auth middleware

// User creation routes (role-specific)
router.post("/consultant-admin", uploadUserImage, checkRole('super_admin'), createConsultantAdmin);
router.post("/consultant", uploadUserImage, checkRole('consultant_admin'), createConsultant);
 router.post("/employee-head", uploadUserImage, checkRole('client_admin'), createEmployeeHead);


router.post("/employee", uploadUserImage, checkRole('client_employee_head'), createEmployee);
router.post("/auditor", uploadUserImage, checkRole('client_admin'), createAuditor);
 router.post("/viewer", uploadUserImage, checkRole('client_admin'), createViewer);



/**
 * Remove assignments
 * DELETE /api/users/remove-assignment
 * Client Admin: can remove Employee Head from node
 * Employee Head: can remove employees from scopes
 * Body: { clientId, nodeId, scopeIdentifier?, employeeIds? }
 */
router.delete("/remove-assignment", removeAssignment);

// User management routes
router.get("/", getUsers); // Get users based on hierarchy
router.put("/:userId", uploadUserImage, updateUser);
router.delete("/:userId", deleteUser); // Delete user with hierarchy control and notifications
router.patch("/:userId/toggle-status", toggleUserStatus); // Activate/Deactivate user

// Profile routes
router.patch("/change-password", changePassword); // Change own password

// 🆕 ASSIGNMENT MANAGEMENT ROUTES

/**
 * Assign Employee Head to Node
 * POST /api/users/assign-head
 * Only Client Admin can assign Employee Heads to nodes
 * Body: { clientId, nodeId, headId }
 */
router.post("/assign-head", checkRole('client_admin'), assignHeadToNode);

/**
 * Assign Employees to Scope Details
 * POST /api/users/assign-scope
 * Only Employee Head assigned to that node can assign employees to scopes
 * Body: { clientId, nodeId, scopeIdentifier, employeeIds: [] }
 */
router.post("/assign-scope", checkRole('client_employee_head'), assignScope);

/**
 * Get all node assignments for a client
 * GET /api/users/node-assignments/:clientId
 * Only Client Admin can view all assignments in their organization
 */
router.get("/node-assignments/:clientId", checkRole('client_admin'), getNodeAssignments);

/**
 * Get current user's assignments
 * GET /api/users/my-assignments
 * Employee Head: sees nodes they manage
 * Employee: sees scopes they're assigned to
 */
router.get("/my-assignments", getMyAssignments);

/**
 * Get available Employee Heads for assignment
 * GET /api/users/available-heads/:clientId
 * Returns Employee Heads that can be assigned to nodes
 */
router.get("/available-heads/:clientId", checkRole('client_admin'), async (req, res) => {
  try {
    const { clientId } = req.params;

    // Additional validation - ensure client admin is accessing their own organization
    if (req.user.clientId !== clientId) {
      return res.status(403).json({ 
        message: 'You can only view Employee Heads in your own organization' 
      });
    }

    const availableHeads = await User.find({
      userType: 'client_employee_head',
      clientId: clientId,
      isActive: true
    }).select('_id userName email department location');

    res.status(200).json({
      message: 'Available Employee Heads retrieved successfully',
      heads: availableHeads
    });

  } catch (error) {
    console.error('Error getting available heads:', error);
    res.status(500).json({ 
      message: 'Error retrieving available Employee Heads', 
      error: error.message 
    });
  }
});

/**
 * Get available Employees under an Employee Head
 * GET /api/users/available-employees/:clientId
 * Returns Employees that can be assigned to scopes
 */
router.get("/available-employees/:clientId", checkRole('client_employee_head'), async (req, res) => {
  try {
    const { clientId } = req.params;

    // Additional validation - ensure employee head is accessing their own organization
    if (req.user.clientId !== clientId) {
      return res.status(403).json({ 
        message: 'You can only view employees in your own organization' 
      });
    }

    // Get employees created by this Employee Head or in same department
    const availableEmployees = await User.find({
      userType: 'employee',
      clientId: clientId,
      $or: [
        { createdBy: req.user._id },
        { employeeHeadId: req.user._id },
        { department: req.user.department }
      ],
      isActive: true
    }).select('_id userName email department assignedModules');

    res.status(200).json({
      message: 'Available Employees retrieved successfully',
      employees: availableEmployees
    });

  } catch (error) {
    console.error('Error getting available employees:', error);
    res.status(500).json({ 
      message: 'Error retrieving available employees', 
      error: error.message 
    });
  }
});

/**
 * Get scope details for a specific node
 * GET /api/users/node-scopes/:clientId/:nodeId
 * Returns scope details for assignment
 */
router.get("/node-scopes/:clientId/:nodeId", checkRole('client_employee_head'), async (req, res) => {
  try {
    const { clientId, nodeId } = req.params;

    // Additional validation - ensure employee head is accessing their own organization
    if (req.user.clientId !== clientId) {
      return res.status(403).json({ 
        message: 'You can only view scopes in your own organization' 
      });
    }

    const Flowchart = require('../models/Organization/Flowchart');
    const flowchart = await Flowchart.findOne(
      { clientId, 'nodes.id': nodeId },
      { 'nodes.$': 1 }
    ).populate('nodes.details.scopeDetails.assignedEmployees', 'userName email');

    if (!flowchart || !flowchart.nodes[0]) {
      return res.status(404).json({ message: 'Node not found' });
    }

    const node = flowchart.nodes[0];

    // Verify this Employee Head is assigned to this node
    if (!node.details.employeeHeadId || 
        node.details.employeeHeadId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ 
        message: 'You are not assigned to manage this node' 
      });
    }

    const scopes = node.details.scopeDetails.map(scope => ({
      scopeIdentifier: scope.scopeIdentifier,
      scopeType: scope.scopeType,
      inputType: scope.inputType,
      description: scope.description,
      collectionFrequency: scope.collectionFrequency,
      assignedEmployees: scope.assignedEmployees || [],
      assignedEmployeeCount: scope.assignedEmployees?.length || 0
    }));

    res.status(200).json({
      message: 'Node scopes retrieved successfully',
      node: {
        id: node.id,
        label: node.label,
        nodeType: node.details.nodeType,
        department: node.details.department,
        location: node.details.location
      },
      scopes
    });

  } catch (error) {
    console.error('Error getting node scopes:', error);
    res.status(500).json({ 
      message: 'Error retrieving node scopes', 
      error: error.message 
    });
  }
});

module.exports = router;