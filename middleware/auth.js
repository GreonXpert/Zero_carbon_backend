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

module.exports = {
  auth,
  checkRole,
  checkPermission
};