const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Client = require('../models/Client');

const auth = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: "No token provided" });
    }

    const token = authHeader.slice(7); // Remove "Bearer " prefix

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Verify user still exists
      const user = await User.findById(decoded.id).select('-password');

      if (!user) {
        return res.status(401).json({ message: "User not found" });
      }

      const isSandboxUser = user.sandbox === true;

      // ✅ Allow sandbox users even if isActive is false
      if (!user.isActive && !isSandboxUser) {
        return res.status(403).json({ message: "User account is deactivated" });
      }

      // For client users, check if subscription is active
      if (user.clientId) {
        // Load client **without** forcing accountDetails.isActive here
        const client = await Client.findOne({ clientId: user.clientId });

        if (!client) {
          return res.status(403).json({
            message: "Your organization is not found"
          });
        }

        const isSandboxClient =
          client.sandbox === true ||
          isSandboxUser ||
          String(client.clientId || '').startsWith('Sandbox_');

        // ✅ Skip subscription checks for sandbox clients/users
        if (!isSandboxClient) {
          if (!client.accountDetails || client.accountDetails.isActive !== true) {
            return res.status(403).json({
              message: "Your organization's subscription is not active"
            });
          }

          if (
            !["active", "grace_period"].includes(
              client.accountDetails.subscriptionStatus
            )
          ) {
            return res.status(403).json({
              message: "Your organization's subscription has expired"
            });
          }
        }
      }

      // For viewers, check expiry date (sandbox viewers are unlikely, but keep same logic)
      if (user.userType === "viewer" && user.viewerExpiryDate) {
        if (new Date() > new Date(user.viewerExpiryDate)) {
          return res.status(403).json({
            message: "Your viewer access has expired"
          });
        }
      }

      // Attach user info to request (include sandbox + assessmentLevel for flowchart logic)
      req.user = {
        id: user._id.toString(),
        email: user.email,
        userName: user.userName,
        userType: user.userType,
        clientId: user.clientId,
        permissions: user.permissions,
        companyName: user.companyName,
        sandbox: user.sandbox === true,
        assessmentLevel: user.assessmentLevel || [],
        department: user.department,
        location: user.location
      };

      next();

    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ message: "Token expired" });
      }
      if (err.name === 'JsonWebTokenError') {
        return res.status(401).json({ message: "Invalid token" });
      }
      throw err;
    }

  } catch (error) {
    console.error("Auth middleware error:", error);
    return res.status(500).json({
      message: "Authentication error",
      error: error.message
    });
  }
};

// Role-based middleware
const checkRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    if (!allowedRoles.includes(req.user.userType)) {
      return res.status(403).json({
        message: `Access denied. Required roles: ${allowedRoles.join(', ')}`
      });
    }

    next();
  };
};

// Permission-based middleware
const checkPermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    if (!req.user.permissions || !req.user.permissions[permission]) {
      return res.status(403).json({
        message: `Access denied. Missing permission: ${permission}`
      });
    }

    next();
  };
};

/**
 * Authentication middleware
 * Verifies JWT token and attaches user to request object
 */
const authenticate = async (req, res, next) => {
  try {
    // Get token from header
    const authHeader = req.header('Authorization');
    const token = authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.substring(7)
      : authHeader;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.'
      });
    }

    try {
      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Support either decoded.userId or decoded.id
      const userId = decoded.userId || decoded.id;

      // Get user from database
      const user = await User.findById(userId).select('-password');

      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'Invalid token. User not found.'
        });
      }

      const isSandboxUser = user.sandbox === true;

      // ✅ Allow sandbox users even if isActive is false
      if (!user.isActive && !isSandboxUser) {
        return res.status(401).json({
          success: false,
          message: 'Account is deactivated.'
        });
      }

      // Attach full user doc; controllers can read sandbox and assessmentLevel
      req.user = user;
      next();

    } catch (jwtError) {
      console.error('JWT verification error:', jwtError.message);
      return res.status(401).json({
        success: false,
        message: 'Invalid token.'
      });
    }

  } catch (error) {
    console.error('Authentication middleware error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error during authentication.'
    });
  }
};

/**
 * Authorization middleware factory
 * Creates middleware to check if user has required role
 */
const authorize = (roles = []) => {
  // roles can be a single role string or an array of roles
  if (typeof roles === 'string') {
    roles = [roles];
  }

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required.'
      });
    }

    if (roles.length && !roles.includes(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Insufficient permissions.',
        requiredRoles: roles,
        userRole: req.user.userType
      });
    }

    next();
  };
};

/**
 * Client isolation middleware
 * Ensures users can only access their own client's data
 */
const enforceClientAccess = (req, res, next) => {
  const { clientId } = req.params;
  const user = req.user;

  // Super admin can access all clients
  if (user.userType === 'super_admin') {
    return next();
  }

  // Consultant admin and consultant access based on assignments
  if (['consultant_admin', 'consultant'].includes(user.userType)) {
    // Additional logic would be needed to check client assignments
    // For now, allowing access - implement based on your client assignment model
    return next();
  }

  // Client users can only access their own organization's data
  if (['client_admin', 'client_employee_head', 'employee', 'auditor'].includes(user.userType)) {
    if (user.clientId !== clientId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only access data from your own organization.',
        yourClientId: user.clientId,
        requestedClientId: clientId
      });
    }
  }

  next();
};

/**
 * Admin only middleware
 * Allows only super_admin and client_admin
 */
const adminOnly = (req, res, next) => {
  const allowedRoles = ['super_admin', 'client_admin'];

  if (!req.user || !allowedRoles.includes(req.user.userType)) {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Admin privileges required.'
    });
  }

  next();
};

/**
 * Super admin only middleware
 */
const superAdminOnly = (req, res, next) => {
  if (!req.user || req.user.userType !== 'super_admin') {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Super admin privileges required.'
    });
  }

  next();
};

/**
 * Optional authentication middleware
 * Attaches user if token is valid, but doesn't require authentication
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.header('Authorization');
    const token = authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.substring(7)
      : authHeader;

    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.userId || decoded.id;
        const user = await User.findById(userId).select('-password');

        const isSandboxUser = user && user.sandbox === true;

        if (user && (user.isActive || isSandboxUser)) {
          req.user = user;
        }
      } catch (jwtError) {
        // Invalid token, but we don't reject the request
        console.log('Optional auth: Invalid token provided');
      }
    }

    next();
  } catch (error) {
    console.error('Optional auth middleware error:', error);
    next(); // Continue without authentication
  }
};

module.exports = {
  auth,
  checkRole,
  checkPermission,
  authenticate,
  authorize,
  enforceClientAccess,
  adminOnly,
  superAdminOnly,
  optionalAuth
};
