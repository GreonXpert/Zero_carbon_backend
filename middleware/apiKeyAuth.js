// middleware/apiKeyAuth.js (UPDATED - API Key in URL Params)
const ApiKey = require('../models/ApiKey');
const { verifyApiKey, isIpWhitelisted } = require('../utils/ApiKey/keyGenerator');

/**
 * Middleware to authenticate API/IoT requests using API keys
 * 
 * ⚠️ UPDATED: API key is now passed as URL parameter instead of header
 * 
 * This middleware:
 * 1. Extracts the API key from req.params.apiKey
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
      console.log(`[API Key Auth] Authenticating ${keyType} request`);
      console.log(`[API Key Auth] URL Params:`, req.params);
      
      // ============== Extract API Key from URL Params ==============
      const apiKey = req.params.apiKey;

      console.log(`[API Key Auth] Extracted key: ${apiKey ? apiKey.substring(0, 10) + '...' : 'NONE'}`);

      if (!apiKey) {
        console.log('[API Key Auth] No API key provided in URL');
        return res.status(401).json({
          success: false,
          error: 'API key is required',
          message: 'Please provide an API key as a URL parameter. Format: /.../:apiKey/api or /.../:apiKey/iot'
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

        console.log('[API Key Auth] Net Reduction Route params:', routeParams);

        // Validate required params
        if (!routeParams.clientId || !routeParams.projectId || !routeParams.calculationMethodology) {
          console.log('[API Key Auth] Missing required route parameters');
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

        console.log('[API Key Auth] Data Collection Route params:', routeParams);

        // Validate required params
        if (!routeParams.clientId || !routeParams.nodeId || !routeParams.scopeIdentifier) {
          console.log('[API Key Auth] Missing required route parameters');
          return res.status(400).json({
            success: false,
            error: 'Missing route parameters',
            message: 'clientId, nodeId, and scopeIdentifier are required'
          });
        }
      }

      // ============== Find Key by Prefix ==============
      const keyPrefix = apiKey.substring(0, 6);
      console.log(`[API Key Auth] Key prefix: ${keyPrefix}`);
      
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

      console.log('[API Key Auth] Searching for key with query:', JSON.stringify(query, null, 2));

      // Find all potential matching keys
      const potentialKeys = await ApiKey.find(query);

      console.log(`[API Key Auth] Found ${potentialKeys.length} potential matching key(s)`);

      if (!potentialKeys || potentialKeys.length === 0) {
        console.log('[API Key Auth] No matching API key found');
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
          console.log(`[API Key Auth] Key hash verified successfully`);
          break;
        }
      }

      if (!validKey) {
        console.log('[API Key Auth] Key hash verification failed');
        return res.status(401).json({
          success: false,
          error: 'Invalid API key',
          message: 'API key verification failed'
        });
      }

      // ============== Check Expiry ==============
      if (validKey.expiresAt < new Date()) {
        console.log('[API Key Auth] Key has expired');
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
        console.log('[API Key Auth] Key has been revoked');
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
          console.log(`[API Key Auth] IP ${requestIp} not whitelisted`);
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
        console.log('[API Key Auth] Key scope does not match route parameters');
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
          console.log('[API Key Auth] Usage recorded');
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

      console.log('[API Key Auth] Authentication successful, proceeding to controller');

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