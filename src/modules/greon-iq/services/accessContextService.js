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

// Roles that always have access to all ZeroCarbon + ESGLink modules
const UNRESTRICTED_ROLES = ['super_admin', 'consultant_admin', 'consultant', 'client_admin'];

// Roles with restricted operational scope (filtered by node/scope/project assignments)
const SCOPE_RESTRICTED_ROLES = ['client_employee_head', 'employee'];

/**
 * Build the full access context from req.user and resolved clientId.
 *
 * @param {object} user             req.user (full Mongoose document or POJO)
 * @param {string} resolvedClientId The clientId resolved by clientScopeResolver
 * @returns {object} accessContext
 */
function buildAccessContext(user, resolvedClientId) {
  const {
    _id: userId,
    userType,
    accessibleModules = [],
    accessControls    = {},
    esgAccessControls = {},
    // Node/scope restrictions for employee-level roles
    // These fields come from user assignments (populated in dataEntryPermission.js pattern)
    assignedNodes          = [],
    assignedScopeIds       = [],
    assignedProcessNodes   = [],
    assignedReductionProjects = [],
  } = user;

  const isUnrestricted = UNRESTRICTED_ROLES.includes(userType);
  const isScopeRestricted = SCOPE_RESTRICTED_ROLES.includes(userType);

  // ── Product access ──────────────────────────────────────────────────────────
  const canAccessZeroCarbon = accessibleModules.includes('zero_carbon');
  const canAccessEsgLink    = accessibleModules.includes('esg_link');

  // ── ZeroCarbon module access checker ───────────────────────────────────────
  // For unrestricted roles: all modules granted
  // For checklist roles: use hasModuleAccess from existing permission utility
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
  // For employee-level roles: retrieval must be filtered by these IDs.
  // For unrestricted roles: empty arrays mean "no filter applied" (all records returned).
  const nodeRestrictions = isScopeRestricted
    ? {
        nodeIds:             assignedNodes.map(String),
        scopeIdentifiers:    assignedScopeIds.map(String),
        processNodeIds:      assignedProcessNodes.map(String),
        reductionProjectIds: assignedReductionProjects.map(String),
      }
    : null; // null = no restriction (full scope)

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
