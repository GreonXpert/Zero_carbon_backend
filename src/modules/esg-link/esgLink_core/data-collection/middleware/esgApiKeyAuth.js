'use strict';

/**
 * ESG API Key authentication middleware.
 *
 * Modelled after src/modules/zero-carbon/api-key/middleware/apiKeyAuth.js
 * but uses the separate EsgApiKey model and esg_api_keys collection.
 * Does NOT touch the ZC ApiKey collection or middleware.
 */

const EsgApiKey = require('../api-key/models/EsgApiKey');

// ── In-memory rate limiter (per key, per minute) ──────────────────────────────
const rateMap = new Map(); // keyId → { count, windowStart }

function checkRateLimit(keyId, maxRequests = 100, windowMs = 60000) {
  const now    = Date.now();
  const entry  = rateMap.get(keyId) || { count: 0, windowStart: now };

  if (now - entry.windowStart > windowMs) {
    entry.count       = 0;
    entry.windowStart = now;
  }
  entry.count++;
  rateMap.set(keyId, entry);

  return { allowed: entry.count <= maxRequests, count: entry.count, limit: maxRequests };
}

/**
 * Factory: returns Express middleware for a given ESG key type.
 * @param {string} keyType  'ESG_API' | 'ESG_IOT'
 */
function esgApiKeyAuth(keyType) {
  return async function (req, res, next) {
    try {
      const { clientId, nodeId, mappingId, apiKey: plaintextKey } = req.params;

      if (!plaintextKey) {
        return res.status(401).json({ success: false, message: 'API key required' });
      }

      // ── 1. Prefix lookup ───────────────────────────────────────────────────
      const prefix      = plaintextKey.substring(0, 8);
      const candidates  = await EsgApiKey.find({
        keyPrefix: prefix,
        clientId,
        keyType,
        status: 'ACTIVE',
      });

      if (!candidates.length) {
        return res.status(401).json({ success: false, message: 'Invalid or revoked API key' });
      }

      // ── 2. Hash verification ───────────────────────────────────────────────
      let matched = null;
      for (const candidate of candidates) {
        const ok = await candidate.verifyKey(plaintextKey);
        if (ok) { matched = candidate; break; }
      }

      if (!matched) {
        return res.status(401).json({ success: false, message: 'Invalid API key' });
      }

      // ── 3. Expiry check ────────────────────────────────────────────────────
      if (matched.expiresAt <= new Date()) {
        if (matched.status === 'ACTIVE') {
          matched.status = 'EXPIRED';
          await matched.save();
        }
        return res.status(401).json({ success: false, message: 'API key has expired' });
      }

      // ── 4. Scope validation ────────────────────────────────────────────────
      if (!EsgApiKey.validateKeyScope(matched, { clientId, nodeId, mappingId })) {
        return res.status(403).json({ success: false, message: 'API key scope mismatch' });
      }

      // ── 5. IP whitelist check ──────────────────────────────────────────────
      if (matched.ipWhitelist && matched.ipWhitelist.length > 0) {
        const remoteIp = req.ip || req.connection?.remoteAddress || '';
        const allowed  = matched.ipWhitelist.some((entry) => {
          if (entry.includes('/')) {
            // CIDR check (simplified — exact match only for /32)
            return remoteIp.startsWith(entry.split('/')[0].split('.').slice(0, 3).join('.'));
          }
          return remoteIp === entry;
        });
        if (!allowed) {
          return res.status(403).json({ success: false, message: 'IP address not in whitelist' });
        }
      }

      // ── 6. Rate limiting ───────────────────────────────────────────────────
      const { allowed, count, limit } = checkRateLimit(matched._id.toString());
      res.set('X-RateLimit-Limit',     String(limit));
      res.set('X-RateLimit-Remaining', String(Math.max(0, limit - count)));

      if (!allowed) {
        return res.status(429).json({ success: false, message: 'Rate limit exceeded' });
      }

      // ── 7. Record usage (non-blocking) ─────────────────────────────────────
      setImmediate(() => matched.recordUsage().catch(() => {}));

      // ── 8. Attach to request ───────────────────────────────────────────────
      req.esgApiKey = {
        id:        matched._id.toString(),
        clientId:  matched.clientId,
        nodeId:    matched.nodeId,
        mappingId: matched.mappingId,
        metricId:  matched.metricId,
        keyType:   matched.keyType,
        prefix:    matched.keyPrefix,
      };

      return next();
    } catch (err) {
      console.error('[esgApiKeyAuth] Error:', err.message);
      return res.status(500).json({ success: false, message: 'API key verification failed' });
    }
  };
}

const esgKeyMiddleware = {
  esgAPI: esgApiKeyAuth('ESG_API'),
  esgIoT: esgApiKeyAuth('ESG_IOT'),
};

module.exports = { esgApiKeyAuth, esgKeyMiddleware };
