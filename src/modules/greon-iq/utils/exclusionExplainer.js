'use strict';

// ============================================================================
// exclusionExplainer.js — Builds human-readable exclusion explanations
//
// Called by retrievers and accessContextService when data is filtered out.
// The result is included in the API response exclusions[] array and passed
// to DeepSeek as context so it can reference limitations in its narrative.
// ============================================================================

/**
 * Build an exclusion message for a blocked product.
 * @param {'zero_carbon'|'esg_link'} product
 * @returns {string}
 */
function explainProductExclusion(product) {
  const names = { zero_carbon: 'ZeroCarbon', esg_link: 'ESGLink' };
  return `${names[product] || product} data was excluded because your account does not have access to this module.`;
}

/**
 * Build an exclusion message for a blocked module/section.
 * @param {string} moduleName
 * @returns {string}
 */
function explainModuleExclusion(moduleName) {
  return `The '${moduleName}' section was excluded because it is not enabled for your account. Contact your administrator to request access.`;
}

/**
 * Build exclusion messages for scope-based restrictions (node/scope/project).
 * @param {object} nodeRestrictions  — from accessContext
 * @returns {string[]}
 */
function explainScopeRestrictions(nodeRestrictions) {
  if (!nodeRestrictions) return [];
  const messages = [];
  if (nodeRestrictions.nodeIds?.length > 0) {
    messages.push('Results are filtered to nodes assigned to your account. Records from other nodes were excluded.');
  }
  if (nodeRestrictions.scopeIdentifiers?.length > 0) {
    messages.push('Results are filtered to scope identifiers assigned to you. Other scope data was excluded.');
  }
  if (nodeRestrictions.processNodeIds?.length > 0) {
    messages.push('Process flowchart data is filtered to process nodes assigned to your account.');
  }
  if (nodeRestrictions.reductionProjectIds?.length > 0) {
    messages.push('Reduction project data is filtered to projects assigned to you. Other projects were excluded.');
  }
  return messages;
}

/**
 * Build an exclusion message when no data was found for the query.
 * @param {string} domain
 * @param {object} dateRange
 * @returns {string}
 */
function explainNoData(domain, dateRange) {
  const label = dateRange?.label || 'the requested period';
  return `No data was found for '${domain}' in ${label} within your accessible scope.`;
}

/**
 * Build an exclusion message when records were truncated due to max context limit.
 * @param {number} total    — total records found
 * @param {number} returned — records actually returned
 * @returns {string}
 */
function explainTruncation(total, returned) {
  return `Results were limited to ${returned} of ${total} records to stay within the AI context limit. For full data, request an export.`;
}

module.exports = {
  explainProductExclusion,
  explainModuleExclusion,
  explainScopeRestrictions,
  explainNoData,
  explainTruncation,
};
