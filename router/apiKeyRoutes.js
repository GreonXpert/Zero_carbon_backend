// routes/apiKeyRoutes.js - UPDATED WITH PDF DOWNLOAD & EMAIL ENDPOINTS

const express = require('express');
const router = express.Router();
const { auth, checkRole } = require('../middleware/auth');
const {
  createKey,
  renewKey,
  revokeKey,
  listKeys,
  getKeyDetails,
  downloadKeyPDF,     // ✅ NEW
  sendKeyEmail        // ✅ NEW
} = require('../controllers/apiKeyController');
const { manualExpiryCheck, getApiKeyStats } = require('../utils/jobs/apiKeyExpiryChecker');

// ============== API Key Management Routes ==============

/**
 * All routes require authentication
 */
router.use(auth);

/**
 * CREATE API KEY
 * POST /api/clients/:clientId/api-keys
 * 
 * ✅ UPDATED: Now optionally generates PDF and sends email
 * 
 * Body:
 * {
 *   "keyType": "NET_API|NET_IOT|DC_API|DC_IOT",
 *   "projectId": "string",              // For NET keys
 *   "calculationMethodology": "string",  // For NET keys
 *   "nodeId": "string",                  // For DC keys
 *   "scopeIdentifier": "string",         // For DC keys
 *   "durationDays": 365,                 // Optional (default: 365)
 *   "description": "string",             // Optional
 *   "ipWhitelist": ["1.2.3.4"],         // Optional
 *   "sendEmail": true                    // ✅ NEW: Optional (default: true)
 * }
 */
router.post(
  '/clients/:clientId/api-keys',
  checkRole('super_admin', 'consultant_admin', 'consultant'),
  createKey
);

/**
 * LIST API KEYS FOR CLIENT
 * GET /api/clients/:clientId/api-keys
 * 
 * Query params:
 * - status: ACTIVE|REVOKED|EXPIRED (optional)
 * - keyType: NET_API|NET_IOT|DC_API|DC_IOT (optional)
 */
router.get(
  '/clients/:clientId/api-keys',
  checkRole('super_admin', 'consultant_admin', 'consultant'),
  listKeys
);

/**
 * GET API KEY DETAILS
 * GET /api/clients/:clientId/api-keys/:keyId
 */
router.get(
  '/clients/:clientId/api-keys/:keyId',
  checkRole('super_admin', 'consultant_admin', 'consultant'),
  getKeyDetails
);



/**
 * RENEW API KEY
 * POST /api/clients/:clientId/api-keys/:keyId/renew
 * 
 * Body:
 * {
 *   "durationDays": 365  // Optional
 * }
 */
router.post(
  '/clients/:clientId/api-keys/:keyId/renew',
  checkRole('super_admin', 'consultant_admin', 'consultant'),
  renewKey
);

/**
 * REVOKE API KEY
 * DELETE /api/clients/:clientId/api-keys/:keyId
 * 
 * Body:
 * {
 *   "reason": "string"  // Optional
 * }
 */
router.delete(
  '/clients/:clientId/api-keys/:keyId',
  checkRole('super_admin', 'consultant_admin', 'consultant'),
  revokeKey
);

// ============== Admin/Monitoring Routes ==============

/**
 * GET API KEY STATISTICS
 * GET /api/admin/api-keys/stats
 * Super admin only
 */
router.get(
  '/admin/api-keys/stats',
  checkRole('super_admin'),
  async (req, res) => {
    try {
      const stats = await getApiKeyStats();
      return res.status(200).json({
        success: true,
        data: stats
      });
    } catch (error) {
      console.error('[API Keys] Stats error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to get statistics',
        message: error.message
      });
    }
  }
);

/**
 * MANUAL EXPIRY CHECK
 * POST /api/admin/api-keys/check-expiry
 * Super admin only - for testing or manual trigger
 */
router.post(
  '/admin/api-keys/check-expiry',
  checkRole('super_admin'),
  async (req, res) => {
    try {
      const result = await manualExpiryCheck();
      return res.status(200).json(result);
    } catch (error) {
      console.error('[API Keys] Manual check error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to run expiry check',
        message: error.message
      });
    }
  }
);

module.exports = router;