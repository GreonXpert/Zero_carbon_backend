const express = require("express");
const router = express.Router();
const { auth, checkRole, checkPermission } = require("../middleware/auth");
const { uploadUserImage } = require('../utils/uploads/userImageUploadS3');
const {
  login,
  verifyLoginOTP,
  resendLoginOTP,
  createConsultantAdmin,
  createConsultant,
  createEmployeeHead,
  createEmployee,
  createAuditor,
  createViewer,
  // 🆕 NEW SUPPORT FUNCTIONS
  createSupportManager,
  createSupport,
  getSupportTeam,
  changeSupportUserManager,
  getAllSupportManagers,
  getAllSupportUsers,
  // EXISTING FUNCTIONS
  getMyProfile,
  getUserById,
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
  removeAssignment,
  deleteSupportManager,
  deleteSupportUser,
} = require("../controllers/userController");

const User = require("../models/User");

// ===================================================================
// PUBLIC ROUTES (No authentication required)
// ===================================================================

router.post("/login", login);
router.post("/verify-otp", verifyLoginOTP);
router.post("/resend-otp", resendLoginOTP);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);
router.post("/verify-reset-token", verifyResetToken);

// ===================================================================
// PROTECTED ROUTES (Authentication required)
// ===================================================================

router.use(auth);

// ===================================================================
// CONSULTANT MANAGEMENT ROUTES
// ===================================================================

/**
 * Create Consultant Admin
 * POST /api/users/consultant-admin
 * Auth: super_admin only
 */
router.post(
  "/consultant-admin",
  uploadUserImage,
  checkRole('super_admin'),
  createConsultantAdmin
);

/**
 * Create Consultant
 * POST /api/users/consultant
 * Auth: consultant_admin only
 */
router.post(
  "/consultant",
  uploadUserImage,
  checkRole('consultant_admin'),
  createConsultant
);

// ===================================================================
// 🆕 SUPPORT MANAGEMENT ROUTES
// ===================================================================

/**
 * Create Support Manager
 * POST /api/users/create-support-manager
 * Body: {
 *   email, contactNumber, userName, password, address, companyName,
 *   supportTeamName, supportManagerType, assignedSupportClients, assignedConsultants
 * }
 * Auth: super_admin only
 */
router.post(
  "/create-support-manager",
  uploadUserImage,
  checkRole('super_admin'),
  createSupportManager
);

/**
 * Create Support User
 * POST /api/users/create-support
 * Body: {
 *   email, contactNumber, userName, password, address,
 *   supportEmployeeId, supportJobRole, supportBranch, supportSpecialization,
 *   supportManagerId (required for super_admin, automatic for supportManager)
 * }
 * Auth: supportManager (creates for own team) or super_admin
 */
router.post(
  "/create-support",
  uploadUserImage,
  createSupport
);

/**
 * Get Support Team Members
 * GET /api/users/support-team
 * Query: supportManagerId (required for super_admin, automatic for supportManager)
 * Auth: supportManager (own team) or super_admin (any team)
 */
router.get(
  "/support-team",
  getSupportTeam
);

/**
 * Change Support User's Manager (Transfer between teams)
 * PATCH /api/users/:supportUserId/change-support-manager
 * Body: { newSupportManagerId, reason }
 * Auth: supportManager (from current team) or super_admin
 */
router.patch(
  "/:supportUserId/change-support-manager",
  changeSupportUserManager
);

/**
 * Get All Support Managers
 * GET /api/users/support-managers
 * Query: supportManagerType, search, isActive, page, limit
 * Auth: super_admin or supportManager
 */
router.get(
  "/support-managers",
  getAllSupportManagers
);

/**
 * Get All Support Users
 * GET /api/users/support-users
 * Query: supportManagerId, specialization, search, isActive, page, limit
 * Auth: super_admin or supportManager
 */
router.get(
  "/support-users",
  getAllSupportUsers
);

// Delete Support Manager (super_admin only)
// DELETE /api/users/support-managers/:supportManagerId
router.delete(
  "/support-managers/:supportManagerId",
  checkRole("super_admin"),
  deleteSupportManager
);

// Delete Support User (supportManager owns them OR super_admin)
// DELETE /api/users/support-users/:supportUserId
router.delete(
  "/support-users/:supportUserId",
  checkRole("supportManager", "super_admin"),
  deleteSupportUser
);

// ===================================================================
// CLIENT USER MANAGEMENT ROUTES
// ===================================================================

/**
 * Create Employee Head
 * POST /api/users/employee-head
 * Auth: client_admin only
 */
router.post(
  "/employee-head",
  uploadUserImage,
  checkRole('client_admin'),
  createEmployeeHead
);

/**
 * Create Employee
 * POST /api/users/employee
 * Auth: client_employee_head only
 */
router.post(
  "/employee",
  uploadUserImage,
  checkRole('client_employee_head'),
  createEmployee
);

/**
 * Create Auditor
 * POST /api/users/auditor
 * Auth: client_admin only
 */
router.post(
  "/auditor",
  uploadUserImage,
  checkRole('client_admin'),
  createAuditor
);

/**
 * Create Viewer
 * POST /api/users/viewer
 * Auth: client_admin only
 */
router.post(
  "/viewer",
  uploadUserImage,
  checkRole('client_admin'),
  createViewer
);

// ===================================================================
// ASSIGNMENT MANAGEMENT ROUTES
// ===================================================================

/**
 * Assign Employee Head to Node
 * POST /api/users/assign-head
 * Body: { clientId, nodeId, headId }
 * Auth: client_admin only
 */
router.post(
  "/assign-head",
  checkRole('client_admin'),
  assignHeadToNode
);

/**
 * Assign Employees to Scope
 * POST /api/users/assign-scope
 * Body: { clientId, nodeId, scopeIdentifier, employeeIds: [] }
 * Auth: client_employee_head only
 */
router.post(
  "/assign-scope",
  checkRole('client_employee_head'),
  assignScope
);

/**
 * Get Node Assignments
 * GET /api/users/node-assignments/:clientId
 * Auth: client_admin only
 */
router.get(
  "/node-assignments/:clientId",
  checkRole('client_admin'),
  getNodeAssignments
);

/**
 * Get My Assignments
 * GET /api/users/my-assignments
 * Auth: client_employee_head or employee
 */
router.get(
  "/my-assignments",
  getMyAssignments
);

/**
 * Remove Assignments
 * DELETE /api/users/remove-assignment
 * Body: { clientId, nodeId, scopeIdentifier?, employeeIds? }
 * Auth: client_admin or client_employee_head
 */
router.delete(
  "/remove-assignment",
  removeAssignment
);

// ===================================================================
// PROFILE & USER MANAGEMENT ROUTES
// ===================================================================

/**
 * Get My Profile
 * GET /api/users/me
 */
router.get("/me", getMyProfile);

/**
 * Get User by ID
 * GET /api/users/:userId
 */
router.get("/:userId", getUserById);

/**
 * Get Users (filtered by role and hierarchy)
 * GET /api/users
 * Query: userType (optional filter)
 */
router.get("/", getUsers);

/**
 * Update User
 * PUT /api/users/:userId
 */
router.put(
  "/:userId",
  uploadUserImage,
  updateUser
);

/**
 * Delete User
 * DELETE /api/users/:userId
 */
router.delete("/:userId", deleteUser);

/**
 * Toggle User Status (Activate/Deactivate)
 * PATCH /api/users/:userId/toggle-status
 */
router.patch("/:userId/toggle-status", toggleUserStatus);

/**
 * Change Password
 * PATCH /api/users/change-password
 */
router.patch("/change-password", changePassword);

// ===================================================================
// HELPER ROUTES
// ===================================================================

/**
 * Get Available Employee Heads
 * GET /api/users/available-heads/:clientId
 * Auth: client_admin only
 */
router.get(
  "/available-heads/:clientId",
  checkRole('client_admin'),
  async (req, res) => {
    try {
      const { clientId } = req.params;

      if (req.user.clientId !== clientId) {
        return res.status(403).json({
          success: false,
          message: 'You can only view Employee Heads in your own organization'
        });
      }

      const availableHeads = await User.find({
        userType: 'client_employee_head',
        clientId: clientId,
        isActive: true
      }).select('_id userName email department location');

      res.status(200).json({
        success: true,
        message: 'Available Employee Heads retrieved successfully',
        heads: availableHeads
      });
    } catch (error) {
      console.error('[USER ROUTES] Error getting available heads:', error);
      res.status(500).json({
        success: false,
        message: 'Error retrieving available Employee Heads',
        error: error.message
      });
    }
  }
);

/**
 * Get Available Employees
 * GET /api/users/available-employees/:clientId
 * Auth: client_employee_head only
 */
router.get(
  "/available-employees/:clientId",
  checkRole('client_employee_head'),
  async (req, res) => {
    try {
      const { clientId } = req.params;

      if (req.user.clientId !== clientId) {
        return res.status(403).json({
          success: false,
          message: 'You can only view employees in your own organization'
        });
      }

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
        success: true,
        message: 'Available Employees retrieved successfully',
        employees: availableEmployees
      });
    } catch (error) {
      console.error('[USER ROUTES] Error getting available employees:', error);
      res.status(500).json({
        success: false,
        message: 'Error retrieving available employees',
        error: error.message
      });
    }
  }
);

/**
 * Get Node Scopes
 * GET /api/users/node-scopes/:clientId/:nodeId
 * Auth: client_employee_head only
 */
router.get(
  "/node-scopes/:clientId/:nodeId",
  checkRole('client_employee_head'),
  async (req, res) => {
    try {
      const { clientId, nodeId } = req.params;

      console.log('\n📋 Get Node Scopes Request');
      console.log(`   Client ID: ${clientId}`);
      console.log(`   Node ID: ${nodeId}`);
      console.log(`   Requested by: ${req.user?.userName} (${req.user?.userType})`);

      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }

      const currentUserId = req.user._id || req.user.id;

      if (req.user.clientId !== clientId) {
        return res.status(403).json({
          success: false,
          message: 'You can only access nodes in your own organization'
        });
      }

      const Flowchart = require('../models/Organization/Flowchart');

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
        return res.status(404).json({
          success: false,
          message: 'Flowchart not found for this organization',
          clientId: clientId
        });
      }

      if (!flowchart.nodes || !Array.isArray(flowchart.nodes) || flowchart.nodes.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Node not found in flowchart',
          nodeId: nodeId
        });
      }

      const node = flowchart.nodes[0];

      if (!node.details) {
        return res.status(500).json({
          success: false,
          message: 'Invalid node structure: missing details',
          nodeId: nodeId
        });
      }

      const nodeEmployeeHeadId = node.details.employeeHeadId;

      if (!nodeEmployeeHeadId) {
        return res.status(403).json({
          success: false,
          message: 'No Employee Head is assigned to manage this node yet',
          nodeId: nodeId,
          nodeName: node.label
        });
      }

      if (nodeEmployeeHeadId.toString() !== currentUserId.toString()) {
        return res.status(403).json({
          success: false,
          message: 'You are not assigned to manage this node',
          nodeId: nodeId,
          nodeName: node.label
        });
      }

      const scopeDetails = node.details.scopeDetails || [];

      const employeeIds = [];
      scopeDetails.forEach(scope => {
        if (scope.assignedEmployees && Array.isArray(scope.assignedEmployees)) {
          employeeIds.push(...scope.assignedEmployees);
        }
      });

      let employeeMap = {};
      if (employeeIds.length > 0) {
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
      }

      const scopes = scopeDetails.map((scope, index) => {
        const assignedEmployeeIds = scope.assignedEmployees || [];
        const assignedEmployeeDetails = assignedEmployeeIds
          .map(empId => employeeMap[empId.toString()] || null)
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

      const nodeInfo = {
        id: node.id,
        label: node.label || 'Unnamed Node',
        nodeType: node.details.nodeType || 'process',
        department: node.details.department || req.user.department,
        location: node.details.location || req.user.location,
        description: node.details.description || '',
        employeeHeadId: nodeEmployeeHeadId.toString(),
        totalScopes: scopes.length,
        assignedScopes: scopes.filter(s => s.assignedEmployeeCount > 0).length,
        unassignedScopes: scopes.filter(s => s.assignedEmployeeCount === 0).length
      };

      res.status(200).json({
        success: true,
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
      console.error('\n❌ Error getting node scopes:', error);
      res.status(500).json({
        success: false,
        message: 'Error retrieving node scopes',
        error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
      });
    }
  }
);

module.exports = router;