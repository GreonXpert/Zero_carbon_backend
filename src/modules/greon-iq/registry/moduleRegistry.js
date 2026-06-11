'use strict';

// ============================================================================
// moduleRegistry.js — Maps data domains to their product, access module,
// allowed sections, retriever, and output capabilities.
//
// This is the central routing brain. intentRouterService uses it to map
// a classified intent to the correct product gate and retriever.
//
// Convention:
//   product      — 'zero_carbon' | 'esg_link' | 'both'
//   accessModule — must match a key in user.accessControls (ZC)
//                  or user.esgAccessControls (ESG)
//   sections     — which sub-sections the retriever can serve
//   retriever    — key name used by queryPlannerService to pick retriever
// ============================================================================

const MODULE_REGISTRY = {

  // ── ZeroCarbon domains ───────────────────────────────────────────────────────

  emission_summary: {
    product:                  'zero_carbon',
    accessModule:             'emission_summary',
    sections:                 ['overview', 'byScope', 'byCategory', 'byNode', 'trends', 'metadata'],
    retriever:                'emissionSummaryRetriever',
    supportsCharts:           true,
    supportsTables:           true,
    supportsReports:          true,
    crossModule:              false,
    requiredAssessmentLevel:  'organization',
  },

  data_entry: {
    product:                  'zero_carbon',
    accessModule:             'data_entry',
    sections:                 ['list', 'detail', 'stats', 'logs'],
    retriever:                'dataEntryRetriever',
    supportsCharts:           false,
    supportsTables:           true,
    supportsReports:          false,
    crossModule:              false,
    requiredAssessmentLevel:  'organization',
  },

  organization_flowchart: {
    product:                  'zero_carbon',
    accessModule:             'organization_flowchart',
    sections:                 ['view', 'nodes', 'scopeDetails', 'assignments'],
    retriever:                'dataEntryRetriever',
    supportsCharts:           false,
    supportsTables:           true,
    supportsReports:          false,
    crossModule:              false,
    requiredAssessmentLevel:  'organization',
  },

  process_flowchart: {
    product:                  'zero_carbon',
    accessModule:             'process_flowchart',
    sections:                 ['view', 'entries', 'processEmissionEntries'],
    retriever:                'dataEntryRetriever',
    supportsCharts:           false,
    supportsTables:           true,
    supportsReports:          false,
    crossModule:              false,
    requiredAssessmentLevel:  'process',
  },

  reduction: {
    product:                  'zero_carbon',
    accessModule:             'reduction',
    sections:                 ['summary', 'kpis', 'byProject', 'trends', 'breakdown', 'methodology'],
    retriever:                'reductionRetriever',
    supportsCharts:           true,
    supportsTables:           true,
    supportsReports:          true,
    crossModule:              false,
    requiredAssessmentLevel:  'reduction',
  },

  decarbonization: {
    product:                  'zero_carbon',
    accessModule:             'decarbonization',
    sections:                 ['sbti', 'targets', 'progress'],
    retriever:                'm3Retriever',
    supportsCharts:           true,
    supportsTables:           true,
    supportsReports:          false,
    crossModule:              false,
    requiredAssessmentLevel:  'decarbonization',
  },

  // ── BRSR questionnaire domain ────────────────────────────────────────────────

  brsr_summary: {
    product:         'esg_link',
    accessModule:    null,
    sections:        ['overview', 'bySection', 'byContributor', 'progress'],
    retriever:       'brsrRetriever',
    supportsCharts:  true,
    supportsTables:  true,
    supportsReports: false,
    crossModule:     false,
  },

  // ── ESGLink domains ──────────────────────────────────────────────────────────

  esg_boundary: {
    product:         'esg_link',
    accessModule:    'esgLinkBoundary',
    sections:        ['view', 'nodes', 'assignments'],
    retriever:       'esgRetriever',
    supportsCharts:  false,
    supportsTables:  true,
    supportsReports: false,
    crossModule:     false,
  },

  esg_metrics: {
    product:         'esg_link',
    accessModule:    'metrics',
    sections:        ['list', 'detail', 'mappings'],
    retriever:       'esgRetriever',
    supportsCharts:  false,
    supportsTables:  true,
    supportsReports: false,
    crossModule:     false,
  },

  esg_data_entry: {
    product:         'esg_link',
    accessModule:    'dataCollectionEsgLink',
    sections:        ['list', 'detail', 'workflow', 'approved', 'pending'],
    retriever:       'esgRetriever',
    supportsCharts:  true,
    supportsTables:  true,
    supportsReports: true,
    crossModule:     false,
  },

  esg_summary: {
    product:         'esg_link',
    accessModule:    'dataCollectionEsgLink',
    sections:        ['overview', 'byMetric', 'byNode', 'byCategory'],
    retriever:       'esgRetriever',
    supportsCharts:  true,
    supportsTables:  true,
    supportsReports: true,
    crossModule:     false,
  },

  // ── User / client / team management data ─────────────────────────────────────
  // No product gate, no assessment level gate — access controlled by sectionRegistry
  // (only super_admin, consultant_admin, consultant, client_admin can reach this domain).
  user_data: {
    product:                  'both',
    accessModule:             null,
    sections:                 ['summary', 'clients', 'consultants', 'users', 'modules', 'assessment'],
    retriever:                'userDataRetriever',
    supportsCharts:           false,
    supportsTables:           true,
    supportsReports:          false,
    crossModule:              false,
    requiredAssessmentLevel:  null,
  },

  // ── Cross-client ranking / "which client has the highest emissions" ─────────

  cross_client_summary: {
    product:                 'both',
    accessModule:            null,
    sections:                ['overview', 'byScope'],
    retriever:               'crossClientSummaryRetriever',
    supportsCharts:          true,
    supportsTables:          true,
    supportsReports:         false,
    crossModule:             true,
    requiredAssessmentLevel: null,
  },

  // ── Cross-client comparison (super_admin / consultant_admin / consultant only) ───

  client_comparison: {
    product:                 'both',
    accessModule:            null,
    sections:                ['overview', 'byScope'],
    retriever:               'clientComparisonRetriever',
    supportsCharts:          true,
    supportsTables:          true,
    supportsReports:         false,
    crossModule:             true,
    requiredAssessmentLevel: null,
  },

  // ── Cross-module domains ──────────────────────────────────────────────────────

  cross_module_analysis: {
    product:         'both',
    accessModule:    null,    // Checked per-product in queryPlannerService
    sections:        ['combined', 'comparison', 'correlation'],
    retriever:       'multi',  // queryPlannerService runs multiple retrievers
    supportsCharts:  true,
    supportsTables:  true,
    supportsReports: true,
    crossModule:     true,
  },
};

/**
 * Look up a domain's registry entry.
 * @param {string} domain
 * @returns {object|null}
 */
function getModuleInfo(domain) {
  return MODULE_REGISTRY[domain] || null;
}

/**
 * Get all domains for a given product.
 * @param {'zero_carbon'|'esg_link'|'both'} product
 * @returns {string[]}
 */
function getDomainsByProduct(product) {
  return Object.entries(MODULE_REGISTRY)
    .filter(([, info]) => info.product === product || info.product === 'both')
    .map(([domain]) => domain);
}

module.exports = {
  MODULE_REGISTRY,
  getModuleInfo,
  getDomainsByProduct,
};
