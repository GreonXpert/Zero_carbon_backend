const express = require("express");
const router = express.Router();
const { auth, checkRole, checkPermission } = require("../middleware/auth"); // Using the comprehensive auth from middleware folder
const { uploadUserImage } = require('../utils/uploads/userImageUploadS3');
const {
  login,
  verifyLoginOTP,          // ← NEW: OTP verification
  resendLoginOTP,          // ← NEW: Resend OTP
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
router.post("/verify-otp", verifyLoginOTP);      // Step 2: Verify OTP, returns JWT token
router.post("/resend-otp", resendLoginOTP);      // Optional: Resend OTP if needed
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
 * Returns scope details for assignment by Employee Head
 * 
 * Access: client_employee_head only
 * 
 * FIXED: Handles both req.user.id and req.user._id
 */
router.get("/node-scopes/:clientId/:nodeId", checkRole('client_employee_head'), async (req, res) => {
  try {
    const { clientId, nodeId } = req.params;

    console.log(`\n📋 Get Node Scopes Request`);
    console.log(`   Client ID: ${clientId}`);
    console.log(`   Node ID: ${nodeId}`);
    console.log(`   Requested by: ${req.user?.userName} (${req.user?.userType})`);

    // ==========================================
    // 1. VALIDATE REQUEST USER
    // ==========================================
    if (!req.user) {
      console.error('❌ No authenticated user found');
      return res.status(401).json({ 
        message: 'Authentication required' 
      });
    }

    // DEBUG: Log what properties req.user has
    console.log('🔍 Debugging req.user properties:');
    console.log(`   Has _id: ${!!req.user._id}`);
    console.log(`   Has id: ${!!req.user.id}`);
    console.log(`   _id value: ${req.user._id}`);
    console.log(`   id value: ${req.user.id}`);

    // CRITICAL FIX: Handle both _id and id
    // Some auth middlewares use 'id', others use '_id'
    const currentUserId = req.user._id || req.user.id;

    if (!currentUserId) {
      console.error('❌ User ID not found in request');
      console.error('   req.user object:', JSON.stringify(req.user, null, 2));
      return res.status(500).json({ 
        message: 'Invalid user data: User ID not found',
        debug: process.env.NODE_ENV === 'development' ? {
          hasUser: !!req.user,
          has_id: !!req.user._id,
          hasId: !!req.user.id,
          userProperties: Object.keys(req.user)
        } : undefined
      });
    }

    console.log(`✅ Current User ID: ${currentUserId}`);

    if (!req.user.clientId) {
      console.error('❌ User has no clientId');
      return res.status(403).json({ 
        message: 'User is not associated with any client organization' 
      });
    }

    // ==========================================
    // 2. VALIDATE INPUT PARAMETERS
    // ==========================================
    if (!clientId || !nodeId) {
      return res.status(400).json({ 
        message: 'clientId and nodeId are required',
        provided: { clientId: !!clientId, nodeId: !!nodeId }
      });
    }

    // ==========================================
    // 3. CHECK CLIENTID AUTHORIZATION
    // ==========================================
    if (req.user.clientId !== clientId) {
      console.error(`❌ Authorization failed: User clientId (${req.user.clientId}) !== Requested clientId (${clientId})`);
      return res.status(403).json({ 
        message: 'You can only view scopes in your own organization',
        userClientId: req.user.clientId,
        requestedClientId: clientId
      });
    }

    console.log('✅ Authorization check passed');

    // ==========================================
    // 4. FETCH FLOWCHART AND NODE
    // ==========================================
    const Flowchart = require('../models/Organization/Flowchart');
    
    console.log('🔍 Querying flowchart...');
    
    const flowchart = await Flowchart.findOne(
      { 
        clientId: clientId, 
        'nodes.id': nodeId 
      },
      { 
        'nodes.$': 1,
        clientId: 1 
      }
    ).lean();

    if (!flowchart) {
      console.error(`❌ Flowchart not found for clientId: ${clientId}`);
      return res.status(404).json({ 
        message: 'Flowchart not found for this organization',
        clientId: clientId
      });
    }

    console.log('✅ Flowchart found');

    if (!flowchart.nodes || !Array.isArray(flowchart.nodes) || flowchart.nodes.length === 0) {
      console.error(`❌ Node not found with ID: ${nodeId}`);
      return res.status(404).json({ 
        message: 'Node not found in flowchart',
        nodeId: nodeId
      });
    }

    const node = flowchart.nodes[0];
    console.log(`✅ Node found: ${node.label || node.id}`);

    // ==========================================
    // 5. VALIDATE NODE STRUCTURE
    // ==========================================
    if (!node.details) {
      console.error('❌ Node details not found');
      return res.status(500).json({ 
        message: 'Invalid node structure: missing details',
        nodeId: nodeId
      });
    }

    // ==========================================
    // 6. CHECK EMPLOYEE HEAD ASSIGNMENT
    // ==========================================
    const nodeEmployeeHeadId = node.details.employeeHeadId;

    console.log(`🔍 Checking Employee Head assignment:`);
    console.log(`   Node employeeHeadId: ${nodeEmployeeHeadId}`);
    console.log(`   Current user ID: ${currentUserId}`);

    if (!nodeEmployeeHeadId) {
      console.warn('⚠️ No Employee Head assigned to this node');
      return res.status(403).json({ 
        message: 'No Employee Head is assigned to manage this node yet',
        nodeId: nodeId,
        nodeName: node.label
      });
    }

    // Convert both IDs to strings for comparison
    const nodeEmployeeHeadIdStr = nodeEmployeeHeadId.toString();
    const currentUserIdStr = currentUserId.toString();

    console.log(`   Comparing: ${nodeEmployeeHeadIdStr} === ${currentUserIdStr}`);

    if (nodeEmployeeHeadIdStr !== currentUserIdStr) {
      console.error(`❌ Access denied: User is not the assigned Employee Head for this node`);
      console.error(`   Expected: ${nodeEmployeeHeadIdStr}`);
      console.error(`   Got: ${currentUserIdStr}`);
      
      return res.status(403).json({ 
        message: 'You are not assigned to manage this node',
        nodeId: nodeId,
        nodeName: node.label,
        hint: 'Only the assigned Employee Head can view and manage scopes for this node'
      });
    }

    console.log('✅ Employee Head assignment verified');

    // ==========================================
    // 7. EXTRACT AND FORMAT SCOPE DETAILS
    // ==========================================
    const scopeDetails = node.details.scopeDetails || [];
    
    console.log(`📊 Processing ${scopeDetails.length} scope(s)`);

    const employeeIds = [];
    scopeDetails.forEach(scope => {
      if (scope.assignedEmployees && Array.isArray(scope.assignedEmployees)) {
        employeeIds.push(...scope.assignedEmployees);
      }
    });

    // Fetch employee details
    let employeeMap = {};
    if (employeeIds.length > 0) {
      console.log(`👥 Fetching ${employeeIds.length} assigned employee(s)...`);
      
      const User = require('../models/User');
      const employees = await User.find(
        { 
          _id: { $in: employeeIds },
          clientId: clientId,
          isActive: true
        },
        { 
          _id: 1, 
          userName: 1, 
          email: 1, 
          department: 1,
          contactNumber: 1 
        }
      ).lean();

      employees.forEach(emp => {
        employeeMap[emp._id.toString()] = {
          id: emp._id,
          userName: emp.userName,
          email: emp.email,
          department: emp.department,
          contactNumber: emp.contactNumber
        };
      });

      console.log(`✅ Fetched ${employees.length} employee(s)`);
    }

    // Format scopes
    const scopes = scopeDetails.map((scope, index) => {
      const assignedEmployeeIds = scope.assignedEmployees || [];
      const assignedEmployeeDetails = assignedEmployeeIds
        .map(empId => {
          const empIdStr = empId.toString();
          return employeeMap[empIdStr] || null;
        })
        .filter(emp => emp !== null);

      return {
        scopeIdentifier: scope.scopeIdentifier || `Scope-${index + 1}`,
        scopeType: scope.scopeType || 'Not specified',
        inputType: scope.inputType || 'manual',
        description: scope.description || '',
        collectionFrequency: scope.collectionFrequency || 'monthly',
        assignedEmployees: assignedEmployeeDetails,
        assignedEmployeeCount: assignedEmployeeDetails.length,
        assignedEmployeeIds: assignedEmployeeIds.map(id => id.toString()),
        emissionFactorSource: scope.emissionFactorSource || null,
        unit: scope.unit || null,
        calculationMethod: scope.calculationMethod || null
      };
    });

    // ==========================================
    // 8. FORMAT NODE INFORMATION
    // ==========================================
    const nodeInfo = {
      id: node.id,
      label: node.label || 'Unnamed Node',
      nodeType: node.details.nodeType || 'process',
      department: node.details.department || req.user.department,
      location: node.details.location || req.user.location,
      description: node.details.description || '',
      employeeHeadId: nodeEmployeeHeadIdStr,
      totalScopes: scopes.length,
      assignedScopes: scopes.filter(s => s.assignedEmployeeCount > 0).length,
      unassignedScopes: scopes.filter(s => s.assignedEmployeeCount === 0).length
    };

    // ==========================================
    // 9. SEND SUCCESS RESPONSE
    // ==========================================
    console.log('✅ Node scopes retrieved successfully');
    console.log(`   Total scopes: ${nodeInfo.totalScopes}`);
    console.log(`   Assigned: ${nodeInfo.assignedScopes}`);
    console.log(`   Unassigned: ${nodeInfo.unassignedScopes}`);

    res.status(200).json({
      message: 'Node scopes retrieved successfully',
      node: nodeInfo,
      scopes: scopes,
      statistics: {
        totalScopes: nodeInfo.totalScopes,
        assignedScopes: nodeInfo.assignedScopes,
        unassignedScopes: nodeInfo.unassignedScopes,
        totalAssignedEmployees: scopes.reduce((sum, s) => sum + s.assignedEmployeeCount, 0)
      }
    });

  } catch (error) {
    // ==========================================
    // 10. ERROR HANDLING
    // ==========================================
    console.error('\n❌ Error getting node scopes:', error);
    console.error('   Error name:', error.name);
    console.error('   Error message:', error.message);
    console.error('   Stack trace:', error.stack);

    if (error.name === 'CastError') {
      return res.status(400).json({ 
        message: 'Invalid ID format',
        error: 'The provided nodeId or clientId is not valid',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }

    if (error.name === 'ValidationError') {
      return res.status(400).json({ 
        message: 'Validation error',
        error: error.message 
      });
    }

    res.status(500).json({ 
      message: 'Error retrieving node scopes', 
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
      errorType: error.name
    });
  }
});

module.exports = router;