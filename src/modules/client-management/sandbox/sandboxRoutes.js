// routes/sandboxRoutes.js
const express = require('express');
const router = express.Router();
const { auth, checkRole } = require('../../../common/middleware/auth');
const { attachSandboxStatus } = require('./sandboxAuth');
const {
  approveSandboxClient,
  rejectSandboxClient,
  resetSandboxClient,
} = require('./sandboxController');

// All routes require authentication
router.use(auth);
router.use(attachSandboxStatus);

// Admin routes (super_admin and consultant_admin only)

// ✅ pass roles as separate arguments
router.post(
  '/approve/:clientId',
  checkRole('super_admin', 'consultant_admin'),
  approveSandboxClient
);

router.post(
  '/reject/:clientId',
  checkRole('super_admin', 'consultant_admin'),
  rejectSandboxClient
);

router.post(
  '/reset/:clientId',
  checkRole('super_admin', 'consultant_admin'),
  resetSandboxClient
);

module.exports = router;

