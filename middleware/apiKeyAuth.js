// middleware/apiKeyAuth.js
const ApiKey = require('../models/ApiKey');
const { verifyApiKey, isIpWhitelisted } = require('../utils/ApiKey/keyGenerator');

/**
 * Middleware to authenticate API/IoT requests using API keys
 * 
 * This middleware:
 * 1. Extracts the API key from the request header
 * 2. Validates the key exists and is active
 * 3. Verifies the key matches the route parameters
 * 4. Checks expiry
 * 5. Records usage
 * 6. Optional: IP whitelist validation
 * 
 * @param {string} keyType - Expected key type: 'NET_API', 'NET_IOT', 'DC_API', 'DC_IOT'
 * @returns {Function} Express middleware
 */
function apiKeyAuth(keyType) {
  return async (req, res, next) => {
    try {
      // ============== Extract API Key ==============
      // Try multiple header formats for flexibility
      const apiKey = 
        req.headers['x-api-key'] || 
        req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
        req.query.apiKey; // Fallback to query param (not recommended for production)

      if (!apiKey) {
        return res.status(401).json({
          success: false,
          error: 'API key is required',
          message: 'Please provide an API key in the X-API-Key header or Authorization header'
        });
      }

      // ============== Get Route Parameters ==============
      let routeParams;
      
      if (keyType === 'NET_API' || keyType === 'NET_IOT') {
        // Net Reduction routes
        routeParams = {
          clientId: req.params.clientId,
          projectId: req.params.projectId,
          calculationMethodology: req.params.calculationMethodology
        };

        // Validate required params
        if (!routeParams.clientId || !routeParams.projectId || !routeParams.calculationMethodology) {
          return res.status(400).json({
            success: false,
            error: 'Missing route parameters',
            message: 'clientId, projectId, and calculationMethodology are required'
          });
        }
      } else {
        // Data Collection routes
        routeParams = {
          clientId: req.params.clientId,
          nodeId: req.params.nodeId,
          scopeIdentifier: req.params.scopeIdentifier
        };

        // Validate required params
        if (!routeParams.clientId || !routeParams.nodeId || !routeParams.scopeIdentifier) {
          return res.status(400).json({
            success: false,
            error: 'Missing route parameters',
            message: 'clientId, nodeId, and scopeIdentifier are required'
          });
        }
      }

      // ============== Find Key by Prefix ==============
      const keyPrefix = apiKey.substring(0, 6);
      
      // Build query to find matching keys
      const query = {
        keyPrefix,
        clientId: routeParams.clientId,
        keyType,
        status: 'ACTIVE'
      };

      // Add scope-specific filters
      if (keyType === 'NET_API' || keyType === 'NET_IOT') {
        query.projectId = routeParams.projectId;
        query.calculationMethodology = routeParams.calculationMethodology;
      } else {
        query.nodeId = routeParams.nodeId;
        query.scopeIdentifier = routeParams.scopeIdentifier;
      }

      // Find all potential matching keys
      const potentialKeys = await ApiKey.find(query);

      if (!potentialKeys || potentialKeys.length === 0) {
        return res.status(401).json({
          success: false,
          error: 'Invalid API key',
          message: 'No matching API key found for this endpoint'
        });
      }

      // ============== Verify Key Hash ==============
      let validKey = null;
      
      for (const keyDoc of potentialKeys) {
        const isValid = await verifyApiKey(apiKey, keyDoc.keyHash);
        if (isValid) {
          validKey = keyDoc;
          break;
        }
      }

      if (!validKey) {
        return res.status(401).json({
          success: false,
          error: 'Invalid API key',
          message: 'API key verification failed'
        });
      }

      // ============== Check Expiry ==============
      if (validKey.expiresAt < new Date()) {
        // Mark as expired if not already
        if (validKey.status === 'ACTIVE') {
          await validKey.markExpired();
        }
        
        return res.status(401).json({
          success: false,
          error: 'API key expired',
          message: `This API key expired on ${validKey.expiresAt.toISOString()}. Please renew or create a new key.`,
          expiresAt: validKey.expiresAt
        });
      }

      // ============== Check Revocation ==============
      if (validKey.status === 'REVOKED') {
        return res.status(401).json({
          success: false,
          error: 'API key revoked',
          message: 'This API key has been revoked and can no longer be used',
          revokedAt: validKey.revokedAt,
          revocationReason: validKey.revocationReason
        });
      }

      // ============== IP Whitelist Check (Optional) ==============
      if (validKey.ipWhitelist && validKey.ipWhitelist.length > 0) {
        const requestIp = req.ip || req.connection.remoteAddress;
        
        if (!isIpWhitelisted(requestIp, validKey.ipWhitelist)) {
          // Log the attempt
          validKey.lastError = `Unauthorized IP: ${requestIp}`;
          validKey.lastErrorAt = new Date();
          await validKey.save();
          
          return res.status(403).json({
            success: false,
            error: 'IP not whitelisted',
            message: 'Your IP address is not authorized to use this API key'
          });
        }
      }

      // ============== Validate Scope Matches Route ==============
      const scopeMatches = ApiKey.validateKeyScope(validKey, routeParams);
      
      if (!scopeMatches) {
        return res.status(403).json({
          success: false,
          error: 'Key scope mismatch',
          message: 'This API key is not authorized for the requested endpoint'
        });
      }

      // ============== Record Usage ==============
      // Use setImmediate to avoid blocking the response
      setImmediate(async () => {
        try {
          await validKey.recordUsage();
        } catch (err) {
          console.error('[API Key Auth] Failed to record usage:', err);
        }
      });

      // ============== Attach Key Info to Request ==============
      req.apiKey = {
        id: validKey._id,
        clientId: validKey.clientId,
        keyType: validKey.keyType,
        prefix: validKey.keyPrefix,
        isSandbox: validKey.isSandboxKey,
        expiresAt: validKey.expiresAt,
        metadata: {
          projectId: validKey.projectId,
          calculationMethodology: validKey.calculationMethodology,
          nodeId: validKey.nodeId,
          scopeIdentifier: validKey.scopeIdentifier
        }
      };

      // Proceed to the next middleware/controller
      next();

    } catch (error) {
      console.error('[API Key Auth] Error:', error);
      return res.status(500).json({
        success: false,
        error: 'Authentication error',
        message: 'An error occurred while authenticating the API key'
      });
    }
  };
}

/**
 * Rate limiting middleware for API key requests
 * Simple in-memory rate limiter (for production, use Redis)
 * 
 * @param {number} maxRequests - Max requests per window
 * @param {number} windowMs - Time window in milliseconds
 * @returns {Function} Express middleware
 */
function apiKeyRateLimit(maxRequests = 100, windowMs = 60000) {
  const requestCounts = new Map();

  return (req, res, next) => {
    if (!req.apiKey) {
      return next(); // No API key attached, skip rate limiting
    }

    const keyId = req.apiKey.id.toString();
    const now = Date.now();

    // Get or initialize request data
    let requestData = requestCounts.get(keyId);
    
    if (!requestData || now - requestData.windowStart > windowMs) {
      // New window
      requestData = {
        count: 0,
        windowStart: now
      };
    }

    requestData.count++;
    requestCounts.set(keyId, requestData);

    // Check if limit exceeded
    if (requestData.count > maxRequests) {
      const resetTime = new Date(requestData.windowStart + windowMs);
      
      return res.status(429).json({
        success: false,
        error: 'Rate limit exceeded',
        message: `Too many requests. Limit: ${maxRequests} requests per ${windowMs/1000} seconds`,
        resetAt: resetTime,
        retryAfter: Math.ceil((resetTime - now) / 1000)
      });
    }

    // Add rate limit headers
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', maxRequests - requestData.count);
    res.setHeader('X-RateLimit-Reset', new Date(requestData.windowStart + windowMs).toISOString());

    next();
  };
}

/**
 * Middleware factory for different endpoint types
 */
const apiKeyMiddleware = {
  netReductionAPI: apiKeyAuth('NET_API'),
  netReductionIoT: apiKeyAuth('NET_IOT'),
  dataCollectionAPI: apiKeyAuth('DC_API'),
  dataCollectionIoT: apiKeyAuth('DC_IOT')
};

module.exports = {
  apiKeyAuth,
  apiKeyRateLimit,
  apiKeyMiddleware
};