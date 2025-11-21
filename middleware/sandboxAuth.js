// middleware/sandboxAuth.js
// Middleware to control sandbox user access

/**
 * Middleware to check if user is sandbox and restrict access
 */
const checkSandboxAccess = (allowedForSandbox = false) => {
  return async (req, res, next) => {
    try {
      // Skip check if route is explicitly allowed for sandbox
      if (allowedForSandbox) {
        return next();
      }
      
      // Check if user is a sandbox user
      if (req.user && req.user.sandbox === true) {
        // Define routes that sandbox users can access
        const sandboxAllowedPaths = [
          // Dashboard and profile
          '/api/dashboard',
          '/api/users/profile',
          '/api/users/change-password',
          
          // View own client data
          '/api/clients/own',
          '/api/clients/details',
          
          // Submission and proposal viewing
          '/api/submission/view',
          '/api/submission/status',
          '/api/proposal/view',
          
          // Flowchart viewing only
          '/api/flowchart/view',
          '/api/flowchart/nodes',
          '/api/process-flowchart/view',
          
          // Basic reports
          '/api/reports/basic',
          '/api/reports/export/pdf',
          
          // Data entry (limited)
          '/api/data-entry/view',
          '/api/data-entry/list',
          
          // Sandbox specific routes
          '/api/sandbox/my-status',
          '/api/sandbox/request-approval'
        ];
        
        // Check if current path is allowed
        const currentPath = req.path;
        const isAllowed = sandboxAllowedPaths.some(allowedPath => 
          currentPath.startsWith(allowedPath)
        );
        
        if (!isAllowed) {
          return res.status(403).json({
            success: false,
            message: 'Access denied. Your sandbox account has limited permissions.',
            isSandbox: true,
            suggestion: 'Please contact your administrator to request full access approval.'
          });
        }
      }
      
      // Check if accessing sandbox-only routes without being sandbox
      const sandboxOnlyPaths = [
        '/api/sandbox/approve',
        '/api/sandbox/reject',
        '/api/sandbox/clients',
        '/api/sandbox/reset'
      ];
      
      const isSandboxOnlyRoute = sandboxOnlyPaths.some(path => 
        req.path.startsWith(path)
      );
      
      if (isSandboxOnlyRoute && !['super_admin', 'consultant_admin'].includes(req.user?.userType)) {
        return res.status(403).json({
          success: false,
          message: 'This endpoint is restricted to administrators only.'
        });
      }
      
      next();
    } catch (error) {
      console.error('Sandbox access check error:', error);
      res.status(500).json({
        success: false,
        message: 'Error checking sandbox access',
        error: error.message
      });
    }
  };
};

/**
 * Middleware to add sandbox status to request
 */
const attachSandboxStatus = async (req, res, next) => {
  try {
    if (req.user) {
      // Add sandbox status to request for downstream use
      req.isSandboxUser = req.user.sandbox === true;
      req.isSandboxClient = false;
      
      // If user has clientId, check if client is sandbox
      if (req.user.clientId) {
        const Client = require('../models/Client');
        const client = await Client.findOne({ 
          clientId: req.user.clientId 
        }).select('sandbox isActive');
        
        if (client) {
          req.isSandboxClient = client.sandbox === true;
          req.clientActive = client.isActive;
        }
      }
    }
    
    next();
  } catch (error) {
    console.error('Attach sandbox status error:', error);
    next(); // Continue even if there's an error
  }
};

/**
 * Middleware to prevent sandbox users from modifying production data
 */
const preventSandboxModification = async (req, res, next) => {
  try {
    // Only check for modification requests
    const modificationMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
    if (!modificationMethods.includes(req.method)) {
      return next();
    }
    
    // If user is sandbox, check if they're trying to modify non-sandbox data
    if (req.user && req.user.sandbox === true) {
      const allowedModificationPaths = [
        '/api/users/change-password',
        '/api/data-entry/create', // Allow limited data entry
        '/api/sandbox/request-approval'
      ];
      
      const isAllowedModification = allowedModificationPaths.some(path => 
        req.path.startsWith(path)
      );
      
      if (!isAllowedModification) {
        return res.status(403).json({
          success: false,
          message: 'Sandbox accounts cannot modify production data.',
          isSandbox: true
        });
      }
    }
    
    next();
  } catch (error) {
    console.error('Prevent sandbox modification error:', error);
    res.status(500).json({
      success: false,
      message: 'Error checking modification permissions',
      error: error.message
    });
  }
};

module.exports = {
  checkSandboxAccess,
  attachSandboxStatus,
  preventSandboxModification
};