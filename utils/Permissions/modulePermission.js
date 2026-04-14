/**
 * modulePermission.js
 * ────────────────────────────────────────────────────────────────
 * Module-level access control helpers for the multi-module setup
 * (ZeroCarbon + ESGLink).
 *
 * Exported:
 *   requireModuleAccess(moduleName) — Express middleware factory
 *   isModuleSubscriptionActive(client, moduleName) — pure helper
 *   requireActiveModuleSubscription(moduleName) — Express middleware factory
 *   getQuotaKeysForModules(accessibleModules) — quota helper
 *   MODULE_NAMES — constant list of valid module identifiers
 */

'use strict';

// ── Valid module identifiers ──────────────────────────────────────────────────
const MODULE_NAMES = Object.freeze({
  ZERO_CARBON: 'zero_carbon',
  ESG_LINK: 'esg_link',
});

const ACTIVE_STATUSES = new Set(['active', 'grace_period']);

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
  if (!client) return false;

  if (moduleName === MODULE_NAMES.ZERO_CARBON) {
    const status = client?.accountDetails?.subscriptionStatus;
    return ACTIVE_STATUSES.has(status);
  }

  if (moduleName === MODULE_NAMES.ESG_LINK) {
    const status = client?.accountDetails?.esgLinkSubscription?.subscriptionStatus;
    return ACTIVE_STATUSES.has(status);
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

/* -------------------------------------------------------------------------- */
/* Client resolution helpers                                                  */
/* -------------------------------------------------------------------------- */
function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function looksLikeClientDocument(client) {
  return !!client && (
    hasValue(client?.clientId) ||
    !!client?.accountDetails ||
    client?.sandbox === true
  );
}

function getRequestClientId(req) {
  return (
    req.resolvedClientId ||
    req.user?.clientId ||
    req.params?.clientId ||
    req.body?.clientId ||
    req.query?.clientId ||
    null
  );
}


function getModuleLabel(moduleName) {
  return moduleName === MODULE_NAMES.ESG_LINK ? 'ESGLink' : 'ZeroCarbon';
}

async function findClientByClientId(clientId) {
  if (!hasValue(clientId)) return null;

  const Client = require('../../models/CMS/Client');
  return Client.findOne({ clientId });
}


async function resolveClientIdFromDirectRequest(req) {
  const directClientId =
    req.params?.clientId ||
    req.body?.clientId ||
    req.query?.clientId ||
    null;

  return hasValue(directClientId) ? directClientId : null;
}

/**
 * Resolve clientId from a resource-specific ID in routes that do not expose
 * :clientId directly.
 *
 * Supported fallbacks:
 * - :flowchartId  -> Flowchart / ProcessFlowchart
 * - :dataId       -> DataEntry
 * - :entryId      -> ProcessEmissionDataEntry
 */
async function resolveClientIdFromResource(req) {
  const flowchartId =
    req.params?.flowchartId ||
    req.body?.flowchartId ||
    req.query?.flowchartId ||
    null;

  if (hasValue(flowchartId)) {
    try {
      const Flowchart = require('../../models/Organization/Flowchart');
      const ProcessFlowchart = require('../../models/Organization/ProcessFlowchart');

      let doc = await Flowchart.findById(flowchartId).select('clientId').lean();
      if (!doc) {
        doc = await ProcessFlowchart.findById(flowchartId).select('clientId').lean();
      }

      if (hasValue(doc?.clientId)) {
        return doc.clientId;
      }
    } catch (_) {}
  }

 const dataId =
    req.params?.dataId ||
    req.body?.dataId ||
    req.query?.dataId ||
    null;

  if (hasValue(dataId)) {
    try {
      const DataEntry = require('../../models/Organization/DataEntry');
      const doc = await DataEntry.findById(dataId).select('clientId').lean();

      if (hasValue(doc?.clientId)) {
        return doc.clientId;
      }
    } catch (_) {}
  }

  const entryId =
    req.params?.entryId ||
    req.body?.entryId ||
    req.query?.entryId ||
    null;

  if (hasValue(entryId)) {
    try {
      const ProcessEmissionDataEntry = require('../../models/Organization/ProcessEmissionDataEntry');
      const doc = await ProcessEmissionDataEntry.findById(entryId).select('clientId').lean();

      if (hasValue(doc?.clientId)) {
        return doc.clientId;
      }
    } catch (_) {}
  }

  return null;
}

async function resolveClientForModuleCheck(req) {
  // Trust req.client only when it actually looks like a real client document
  if (looksLikeClientDocument(req.client)) {
    req.resolvedClientId = req.client.clientId || req.resolvedClientId || null;
    return req.client;
  }

  // Ignore partial / broken req.client and continue resolving normally
  const userClientId = req.user?.clientId;
  if (hasValue(userClientId)) {
    const client = await findClientByClientId(userClientId);
    if (client) {
      req.client = client;
      req.resolvedClientId = client.clientId;
      return client;
    }
  }

  const directClientId = await resolveClientIdFromDirectRequest(req);
  if (hasValue(directClientId)) {
    const client = await findClientByClientId(directClientId);
    if (client) {
      req.client = client;
      req.resolvedClientId = client.clientId;
      return client;
    }
  }

  const derivedClientId = await resolveClientIdFromResource(req);
  if (hasValue(derivedClientId)) {
    const client = await findClientByClientId(derivedClientId);
    if (client) {
      req.client = client;
      req.resolvedClientId = client.clientId;
      return client;
    }
  }

  return null;
}

/**
 * requireActiveModuleSubscription
 * ─────────────────────────────────────────────────────────────────
 * Express middleware factory. Blocks the request with 403 when the
 * client's subscription for `moduleName` is not currently active.
 *
 * Supports:
 * - req.client                    (already attached by auth)
 * - req.user.clientId             (client-side users)
 * - req.params.clientId
 * - req.body.clientId
 * - req.query.clientId
 * - req.params.flowchartId        (resolves through Flowchart / ProcessFlowchart)
 * - req.params.dataId             (resolves through DataEntry)
 * - req.params.entryId            (resolves through ProcessEmissionDataEntry)
 *
 * Subscription management routes must NOT use this middleware.
 *
 * @param {string} moduleName - One of MODULE_NAMES values
 * @returns {Function} Express middleware
 */
function requireActiveModuleSubscription(moduleName) {
  return async function checkModuleSubscription(req, res, next) {
    try {
      const client = await resolveClientForModuleCheck(req);
      const requestClientId = getRequestClientId(req);

      if (!client) {
        return next();
      }

      const isSandbox =
        client?.sandbox === true ||
        String(client?.clientId || '').startsWith('Sandbox_');

      if (isSandbox) {
        return next();
      }

      if (!isModuleSubscriptionActive(client, moduleName)) {
        return res.status(403).json({
          message: `The ${getModuleLabel(moduleName)} subscription has expired or is not active`,
          module: moduleName,
          subscriptionExpired: true,
          clientId: requestClientId,
        });
      }

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * getQuotaKeysForModules
 * ─────────────────────────────────────────────────────────────────
 * Returns the set of quota keys that are relevant for a given set
 * of accessible modules. Used to filter quota responses.
 *
 * @param {string[]} accessibleModules - e.g. ['zero_carbon', 'esg_link']
 * @returns {string[]} quota key names
 */
function getQuotaKeysForModules(accessibleModules = []) {
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

  // viewer and auditor are module-agnostic
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