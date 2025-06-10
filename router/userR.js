const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");

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
  verifyResetToken
} = require("../controllers/userController");

// Public routes
router.post("/login", login);

router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);
router.post("/verify-reset-token", verifyResetToken); // Optional endpoint

// Protected routes - require authentication
router.use(auth); // Apply auth middleware to all routes below

// User creation routes (role-specific)
router.post("/consultant-admin", createConsultantAdmin); // Super Admin only
router.post("/consultant", createConsultant); // Consultant Admin only
router.post("/employee-head", createEmployeeHead); // Client Admin only
router.post("/employee", createEmployee); // Employee Head only
router.post("/auditor", createAuditor); // Client Admin only
router.post("/viewer", createViewer); // Client Admin only

// User management routes
router.get("/", getUsers); // Get users based on hierarchy
router.put("/:userId", updateUser); // Update user details
router.delete("/:userId", deleteUser); // Delete user with hierarchy control and notifications
router.patch("/:userId/toggle-status", toggleUserStatus); // Activate/Deactivate user

// Profile routes
router.patch("/change-password", changePassword); // Change own password

module.exports = router;