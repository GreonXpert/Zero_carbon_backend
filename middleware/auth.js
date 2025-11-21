const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Client = require('../models/Client');

/**
 * Generate JWT token with sandbox status
 */
const generateToken = (user) => {
  const payload = {
    id: user._id,
    email: user.email,
    userType: user.userType,
    clientId: user.clientId || null,
    sandbox: user.sandbox || false,  // Include sandbox status
    isActive: user.isActive
  };
  
  return jwt.sign(payload, process.env.JWT_SECRET || "your-secret-key", {
    expiresIn: "24h"
  });
};

const auth = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: "No token provided" });
    }
    
    const token = authHeader.slice(7); // Remove "Bearer " prefix
    
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      // Verify user still exists and is active
      const user = await User.findById(decoded.id).select('-password');
      
      if (!user) {
        return res.status(401).json({ message: "User not found" });
      }
      
      if (!user.isActive) {
        return res.status(403).json({ message: "User account is deactivated" });
      }
      
      // For client users, check if subscription is active
      if (user.clientId) {
        const client = await Client.findOne({ 
          clientId: user.clientId,
          "accountDetails.isActive": true
        });
        
        if (!client) {
          return res.status(403).json({ 
            message: "Your organization's subscription is not active" 
          });
        }
        
        // Check if subscription is in valid status
        if (!["active", "grace_period"].includes(client.accountDetails.subscriptionStatus)) {
          return res.status(403).json({ 
            message: "Your organization's subscription has expired" 
          });
        }
      }
      
      // For viewers, check expiry date
      if (user.userType === "viewer" && user.viewerExpiryDate) {
        if (new Date() > new Date(user.viewerExpiryDate)) {
          return res.status(403).json({ 
            message: "Your viewer access has expired" 
          });
        }
      }
      
      // Attach user info to request
      req.user = {
        id: user._id.toString(),
        email: user.email,
        userName: user.userName,
        userType: user.userType,
        clientId: user.clientId,
        permissions: user.permissions,
        companyName: user.companyName
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
      
      // Get user from database
      const user = await User.findById(decoded.userId).select('-password');
      
      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'Invalid token. User not found.'
        });
      }

      if (!user.isActive) {
        return res.status(401).json({
          success: false,
          message: 'Account is deactivated.'
        });
      }

      // Attach user to request object
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
        const user = await User.findById(decoded.userId).select('-password');
        
        if (user && user.isActive) {
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

/**
 * Verify client ownership or admin access
 */
const verifyClientAccess = async (req, res, next) => {
  try {
    const clientId = req.params.clientId || req.body.clientId;
    
    if (!clientId) {
      return res.status(400).json({ 
        message: "Client ID required" 
      });
    }
    
    // Super admin can access all
    if (req.user.userType === "super_admin") {
      return next();
    }
    
    // Check if user belongs to this client
    if (req.user.clientId === clientId) {
      // Additional check for sandbox users
      if (req.user.sandbox) {
        const Client = require("../models/Client");
        const client = await Client.findOne({ clientId });
        
        if (!client || !client.sandbox) {
          return res.status(403).json({ 
            message: "Sandbox users can only access sandbox client data",
            isSandbox: true
          });
        }
      }
      return next();
    }
    
    // Consultant admin can access their assigned clients
    if (req.user.userType === "consultant_admin") {
      const Client = require("../models/Client");
      const client = await Client.findOne({ 
        clientId,
        "leadInfo.consultantAdminId": req.user.id
      });
      
      if (client) {
        return next();
      }
    }
    
    // Consultant can access assigned clients
    if (req.user.userType === "consultant") {
      const Client = require("../models/Client");
      const client = await Client.findOne({
        clientId,
        $or: [
          { "leadInfo.assignedConsultantId": req.user.id },
          { "workflowTracking.assignedConsultantId": req.user.id }
        ]
      });
      
      if (client) {
        return next();
      }
    }
    
    return res.status(403).json({ 
      message: "Access denied to this client",
      isSandbox: req.user.sandbox
    });
    
  } catch (error) {
    console.error("Verify client access error:", error);
    res.status(500).json({ 
      message: "Error verifying client access" 
    });
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
  optionalAuth,
  verifyClientAccess,
  generateToken
};