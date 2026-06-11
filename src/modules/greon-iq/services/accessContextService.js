'use strict';

// ============================================================================
// accessContextService.js — Builds the full access context for a GreOn IQ query
//
// Called once at the start of every query (after auth and clientId resolution).
// Returns a single accessContext object that all downstream services rely on
// for permission decisions. Nothing downstream should re-read req.user directly.
//
// GATES ENFORCED HERE: 7, 8, 10 (product gate, module access, scope filter)
// Gates 1-6 are enforced before this service is called.
// ============================================================================

const {
  hasModuleAccess,
  hasEsgModuleAccess,
} = require('../../../common/utils/Permissions/accessControlPermission');

const Client = require('../../client-management/client/Client');

// Simple in-process cache to avoid repeated DB hits for the same clientId
// within a request burst. TTL: 60 seconds.
const _clientCache = new Map(); // key: clientId → { data, expiresAt }
const CLIENT_CACHE_TTL_MS = 60_000;

async function _fetchClientSubscription(clientId) {
  const now = Date.now();
  const cached = _clientCache.get(clientId);
  if (cached && cached.expiresAt > now) return cached.data;

  try {
    const doc = await Client.findOne(
      { clientId, isDeleted: { $ne: true } },
      {
        'submissionData.assessmentLevel':        1,
        'submissionData.esgLinkAssessmentLevel': 1,
        accessibleModules:                       1,
      }
    ).lean();

    const data = {
      clientAssessmentLevel:    doc?.submissionData?.assessmentLevel        || null,
      clientEsgAssessmentLevel: doc?.submissionData?.esgLinkAssessmentLevel || null,
    };

    _clientCache.set(clientId, { data, expiresAt: now + CLIENT_CACHE_TTL_MS });
    return data;
  } catch (err) {
    console.error('[GreOnIQ] accessContextService: client fetch error:', err.message);
    return { clientAssessmentLevel: null, clientEsgAssessmentLevel: null };
  }
}

// Roles that always have access to all ZeroCarbon + ESGLink modules
const UNRESTRICTED_ROLES = ['super_admin', 'consultant_admin', 'consultant', 'client_admin'];

// Roles with restricted operational scope (filtered by node/scope/project assignments)
const SCOPE_RESTRICTED_ROLES = ['client_employee_head', 'employee'];

/**
 * Build the full access context from req.user and resolved clientId.
 *
 * @param {object} user             req.user (full Mongoose document or POJO)
 * @param {string} resolvedClientId The clientId resolved by clientScopeResolver
 * @returns {Promise<object>} accessContext
 */
async function buildAccessContext(user, resolvedClientId) {
  const {
    _id: userId,
    userType,
    accessibleModules = [],
    accessControls    = {},
    esgAccessControls = {},
    assignedNodes          = [],
    assignedScopeIds       = [],
    assignedProcessNodes   = [],
    assignedReductionProjects = [],
  } = user;

  const isUnrestricted    = UNRESTRICTED_ROLES.includes(userType);
  const isScopeRestricted = SCOPE_RESTRICTED_ROLES.includes(userType);

  // ── Product access ──────────────────────────────────────────────────────────
  const canAccessZeroCarbon = accessibleModules.includes('zero_carbon');
  const canAccessEsgLink    = accessibleModules.includes('esg_link');

  // ── ZeroCarbon module access checker ───────────────────────────────────────
  function hasZCModule(moduleName) {
    if (isUnrestricted) return true;
    if (!canAccessZeroCarbon) return false;
    return hasModuleAccess(user, moduleName);
  }

  // ── ESGLink module access checker ──────────────────────────────────────────
  function hasESGModule(moduleName) {
    if (isUnrestricted) return true;
    if (!canAccessEsgLink) return false;
    return hasEsgModuleAccess(user, moduleName);
  }

  // ── Node/scope restriction filter ──────────────────────────────────────────
  const nodeRestrictions = isScopeRestricted
    ? {
        nodeIds:             assignedNodes.map(String),
        scopeIdentifiers:    assignedScopeIds.map(String),
        processNodeIds:      assignedProcessNodes.map(String),
        reductionProjectIds: assignedReductionProjects.map(String),
      }
    : null;

  // ── Client subscription levels (fetched from Client record) ────────────────
  const clientSub = await _fetchClientSubscription(resolvedClientId);

  return {
    userId:            userId.toString(),
    userType,
    clientId:          resolvedClientId,

    // Product flags
    canAccessZeroCarbon,
    canAccessEsgLink,
    accessibleModules,

    // Module checkers (functions — called lazily by queryPlannerService)
    hasZCModule,
    hasESGModule,

    // Scope restrictions (null = unrestricted, object = filter IDs)
    nodeRestrictions,
    isScopeRestricted,
    isUnrestricted,

    // Client subscription — used for assessment-level gating
    clientAssessmentLevel:    clientSub.clientAssessmentLevel,
    clientEsgAssessmentLevel: clientSub.clientEsgAssessmentLevel,
  };
}

/**
 * Validate that a domain is accessible given the current access context.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 *
 * @param {object} accessContext   from buildAccessContext()
 * @param {object} moduleInfo      from moduleRegistry.getModuleInfo(domain)
 * @returns {{ allowed: boolean, reason?: string }}
 */
function validateDomainAccess(accessContext, moduleInfo) {
  if (!moduleInfo) {
    return { allowed: false, reason: 'Unknown data domain.' };
  }

  const { product, accessModule } = moduleInfo;

  // Check product-level access
  if (product === 'zero_carbon' && !accessContext.canAccessZeroCarbon) {
    return {
      allowed: false,
      reason:  'Your account does not have access to the ZeroCarbon module.',
    };
  }
  if (product === 'esg_link' && !accessContext.canAccessEsgLink) {
    return {
      allowed: false,
      reason:  'Your account does not have access to the ESGLink module.',
    };
  }
  if (product === 'both') {
    if (!accessContext.canAccessZeroCarbon && !accessContext.canAccessEsgLink) {
      return { allowed: false, reason: 'Your account does not have access to either module.' };
    }
  }

  // Check module-level access (for checklist-based roles)
  if (accessModule) {
    if (product === 'zero_carbon' && !accessContext.hasZCModule(accessModule)) {
      return {
        allowed: false,
        reason:  `Access to the '${accessModule}' section is not enabled for your account.`,
      };
    }
    if (product === 'esg_link' && !accessContext.hasESGModule(accessModule)) {
      return {
        allowed: false,
        reason:  `Access to the '${accessModule}' ESGLink section is not enabled for your account.`,
      };
    }
  }

  return { allowed: true };
}

module.exports = { buildAccessContext, validateDomainAccess };
