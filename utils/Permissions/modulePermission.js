/**
 * modulePermission.js
 * ────────────────────────────────────────────────────────────────
 * Module-level access control helpers for the multi-module setup
 * (ZeroCarbon + ESGLink).
 *
 * Exported:
 *   requireModuleAccess(moduleName) — Express middleware factory
 *   isModuleSubscriptionActive(client, moduleName) — pure helper
 *   MODULE_NAMES — constant list of valid module identifiers
 */

'use strict';

// ── Valid module identifiers ──────────────────────────────────────────────────
const MODULE_NAMES = Object.freeze({
  ZERO_CARBON: 'zero_carbon',
  ESG_LINK:    'esg_link',
});

/**
 * isModuleSubscriptionActive
 * ─────────────────────────────────────────────────────────────────
 * Returns true when the given module's subscription is currently
 * in an "active" or "grace_period" state for the provided client.
 *
 * @param {object} client     - Mongoose Client document (or plain object)
 * @param {string} moduleName - One of MODULE_NAMES values
 * @returns {boolean}
 */
function isModuleSubscriptionActive(client, moduleName) {
  const ACTIVE_STATUSES = ['active', 'grace_period'];

  if (moduleName === MODULE_NAMES.ZERO_CARBON) {
    const status = client?.accountDetails?.subscriptionStatus;
    return ACTIVE_STATUSES.includes(status);
  }

  if (moduleName === MODULE_NAMES.ESG_LINK) {
    const status = client?.accountDetails?.esgLinkSubscription?.subscriptionStatus;
    return ACTIVE_STATUSES.includes(status);
  }

  return false;
}

/**
 * requireModuleAccess
 * ─────────────────────────────────────────────────────────────────
 * Express middleware factory. Blocks the request with 403 when the
 * authenticated user does not have the requested module in their
 * accessibleModules array.
 *
 * Usage:
 *   router.post('/some-route', auth, requireModuleAccess('esg_link'), handler);
 *
 * @param {string} moduleName - One of MODULE_NAMES values
 * @returns {Function} Express middleware
 */
function requireModuleAccess(moduleName) {
  return function checkModuleAccess(req, res, next) {
    const userModules = req.user?.accessibleModules;

    if (!Array.isArray(userModules) || !userModules.includes(moduleName)) {
      return res.status(403).json({
        message: `Access to the '${moduleName}' module is not permitted for your account.`,
      });
    }

    next();
  };
}

/**
 * requireActiveModuleSubscription
 * ─────────────────────────────────────────────────────────────────
 * Express middleware factory. Blocks the request with 403 when the
 * client's subscription for `moduleName` is not currently active.
 *
 * Works for both client users (req.client attached by auth middleware)
 * and consultants (no clientId on user record — reads req.params.clientId).
 *
 * Subscription management routes must NOT use this middleware so that
 * consultants can always reach renewal/suspend endpoints.
 *
 * Usage:
 *   app.use('/api/flowchart', requireActiveModuleSubscription('zero_carbon'), flowchartR);
 *
 * @param {string} moduleName - One of MODULE_NAMES values
 * @returns {Function} Express middleware
 */
function requireActiveModuleSubscription(moduleName) {
  return async function checkModuleSubscription(req, res, next) {
    try {
      // Prefer the client doc already attached by auth (avoids an extra DB call).
      // Fall back to fetching by clientId from the request for consultants.
      let client = req.client || null;

      if (!client) {
        const clientId = req.user?.clientId || req.params?.clientId;
        if (!clientId) return next(); // no client context — let route handle it

        const Client = require('../../models/CMS/Client');
        client = await Client.findOne({ clientId }).lean();
        if (!client) return next();
      }

      const isSandbox =
        client.sandbox === true ||
        String(client.clientId || '').startsWith('Sandbox_');
      if (isSandbox) return next();

      if (!isModuleSubscriptionActive(client, moduleName)) {
        return res.status(403).json({
          message: `The ${moduleName === MODULE_NAMES.ESG_LINK ? 'ESGLink' : 'ZeroCarbon'} subscription has expired or is not active`,
          module: moduleName,
          subscriptionExpired: true,
        });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * getModuleStatusForQuota
 * ─────────────────────────────────────────────────────────────────
 * Returns the set of quota keys that are relevant for a given set
 * of accessible modules. Used to filter quota responses.
 *
 * @param {string[]} accessibleModules - e.g. ['zero_carbon', 'esg_link']
 * @returns {string[]} quota key names
 */
function getQuotaKeysForModules(accessibleModules) {
  const keys = new Set();

  if (accessibleModules.includes(MODULE_NAMES.ZERO_CARBON)) {
    keys.add('employeeHead');
    keys.add('employee');
  }

  if (accessibleModules.includes(MODULE_NAMES.ESG_LINK)) {
    keys.add('contributor');
    keys.add('reviewer');
    keys.add('approver');
  }

  // viewer and auditor are module-agnostic — always included when either module present
  if (accessibleModules.length > 0) {
    keys.add('viewer');
    keys.add('auditor');
  }

  return [...keys];
}

module.exports = {
  MODULE_NAMES,
  isModuleSubscriptionActive,
  requireModuleAccess,
  requireActiveModuleSubscription,
  getQuotaKeysForModules,
};
