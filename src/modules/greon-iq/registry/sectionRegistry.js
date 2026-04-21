'use strict';

// ============================================================================
// sectionRegistry.js — Maps userType to allowed sections per domain
//
// This registry determines which sections of a domain a role can access.
// It is used by accessContextService (Gate 9) to filter retrieval scope
// before any data is fetched.
//
// 'full'    — access to all sections defined in moduleRegistry for that domain
// string[]  — restricted to listed section keys only
// null      — no access (should never reach retrieval)
// ============================================================================

// Roles with full section access to all domains they can reach
const FULL_ACCESS_ROLES = [
  'super_admin',
  'consultant_admin',
  'consultant',
  'client_admin',
];

// Roles with read-only broad access
const READ_ONLY_ROLES = ['viewer', 'auditor'];

// ESGLink workflow roles
const ESG_WORKFLOW_ROLES = ['contributor', 'reviewer', 'approver'];

// Restricted operational roles (filtered by assignment — node/scope/project)
const RESTRICTED_ROLES = ['client_employee_head', 'employee'];

const SECTION_REGISTRY = {
  // ── ZeroCarbon domains ─────────────────────────────────────────────────
  emission_summary: {
    super_admin:          'full',
    consultant_admin:     'full',
    consultant:           'full',
    client_admin:         'full',
    client_employee_head: ['overview', 'byScope'],
    employee:             ['overview', 'byScope'],
    viewer:               ['overview', 'byScope', 'byCategory', 'trends'],
    auditor:              'full',
    contributor:          null,
    reviewer:             null,
    approver:             null,
  },

  data_entry: {
    super_admin:          'full',
    consultant_admin:     'full',
    consultant:           'full',
    client_admin:         'full',
    client_employee_head: ['list', 'stats'],
    employee:             ['list', 'stats'],
    viewer:               ['list'],
    auditor:              'full',
    contributor:          null,
    reviewer:             null,
    approver:             null,
  },

  organization_flowchart: {
    super_admin:          'full',
    consultant_admin:     'full',
    consultant:           'full',
    client_admin:         'full',
    client_employee_head: ['view', 'nodes'],
    employee:             ['view', 'nodes'],
    viewer:               ['view', 'nodes'],
    auditor:              'full',
    contributor:          null,
    reviewer:             null,
    approver:             null,
  },

  process_flowchart: {
    super_admin:          'full',
    consultant_admin:     'full',
    consultant:           'full',
    client_admin:         'full',
    client_employee_head: ['view', 'entries'],
    employee:             ['view', 'entries'],
    viewer:               ['view'],
    auditor:              'full',
    contributor:          null,
    reviewer:             null,
    approver:             null,
  },

  reduction: {
    super_admin:          'full',
    consultant_admin:     'full',
    consultant:           'full',
    client_admin:         'full',
    client_employee_head: ['list', 'summary'],
    employee:             ['list'],
    viewer:               ['list', 'summary'],
    auditor:              'full',
    contributor:          null,
    reviewer:             null,
    approver:             null,
  },

  decarbonization: {
    super_admin:          'full',
    consultant_admin:     'full',
    consultant:           'full',
    client_admin:         'full',
    client_employee_head: ['sbti', 'progress'],
    employee:             ['sbti'],
    viewer:               ['sbti', 'targets', 'progress'],
    auditor:              'full',
    contributor:          null,
    reviewer:             null,
    approver:             null,
  },

  // ── ESGLink domains ────────────────────────────────────────────────────
  esg_boundary: {
    super_admin:          'full',
    consultant_admin:     'full',
    consultant:           'full',
    client_admin:         'full',
    client_employee_head: null,
    employee:             null,
    viewer:               ['view', 'nodes'],
    auditor:              'full',
    contributor:          ['view', 'nodes'],
    reviewer:             ['view', 'nodes'],
    approver:             ['view', 'nodes'],
  },

  esg_metrics: {
    super_admin:          'full',
    consultant_admin:     'full',
    consultant:           'full',
    client_admin:         'full',
    client_employee_head: null,
    employee:             null,
    viewer:               ['list'],
    auditor:              'full',
    contributor:          ['list', 'detail'],
    reviewer:             ['list', 'detail'],
    approver:             ['list', 'detail'],
  },

  esg_data_entry: {
    super_admin:          'full',
    consultant_admin:     'full',
    consultant:           'full',
    client_admin:         'full',
    client_employee_head: null,
    employee:             null,
    viewer:               ['list', 'approved'],
    auditor:              'full',
    contributor:          ['list', 'detail', 'pending'],
    reviewer:             ['list', 'detail', 'pending', 'workflow'],
    approver:             ['list', 'detail', 'approved', 'workflow'],
  },

  esg_summary: {
    super_admin:          'full',
    consultant_admin:     'full',
    consultant:           'full',
    client_admin:         'full',
    client_employee_head: null,
    employee:             null,
    viewer:               ['overview', 'byMetric'],
    auditor:              'full',
    contributor:          ['overview'],
    reviewer:             ['overview', 'byMetric'],
    approver:             'full',
  },

  // ── Cross-module analysis ──────────────────────────────────────────────
  cross_module_analysis: {
    super_admin:          'full',
    consultant_admin:     'full',
    consultant:           'full',
    client_admin:         'full',
    client_employee_head: ['combined'],
    employee:             ['combined'],
    viewer:               ['combined', 'comparison'],
    auditor:              'full',
    contributor:          null,
    reviewer:             null,
    approver:             null,
  },
};

/**
 * Get allowed sections for a user type in a domain.
 * Returns 'full', an array of section keys, or null (no access).
 * @param {string} userType
 * @param {string} domain
 * @returns {'full'|string[]|null}
 */
function getAllowedSections(userType, domain) {
  const domainMap = SECTION_REGISTRY[domain];
  if (!domainMap) return null;
  const sections = domainMap[userType];
  return sections !== undefined ? sections : null;
}

/**
 * Returns the full list of allowed section keys for a domain+role.
 * If 'full', resolves against moduleRegistry sections list.
 * @param {string} userType
 * @param {string} domain
 * @param {string[]} allSections — from moduleRegistry
 * @returns {string[]|null}
 */
function resolveAllowedSections(userType, domain, allSections) {
  const sections = getAllowedSections(userType, domain);
  if (sections === null) return null;
  if (sections === 'full') return allSections;
  return sections;
}

module.exports = {
  SECTION_REGISTRY,
  FULL_ACCESS_ROLES,
  READ_ONLY_ROLES,
  ESG_WORKFLOW_ROLES,
  RESTRICTED_ROLES,
  getAllowedSections,
  resolveAllowedSections,
};
