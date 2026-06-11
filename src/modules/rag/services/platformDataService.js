'use strict';

const { resolveAllBindings } = require('../rag/dataResolver');

// ── Base context bindings ──────────────────────────────────────────────────────
// These bindings are ALWAYS resolved regardless of what the template declares.
// This ensures the AI prompt always has complete emission context for all 3 scopes
// even if the template author forgot to add specific bindings.
// Template-declared bindings are merged on top of these.
const BASE_CONTEXT_BINDINGS = {
  'org.name':                       {},
  'org.reportingYear':              {},
  'org.country':                    {},
  'org.industry':                   {},
  'org.baselineYear':               {},
  'emissions.total':                {},
  'emissions.scope1.total':         {},
  'emissions.scope2.total':         {},
  'emissions.scope2.locationBased': {},
  'emissions.scope2.marketBased':   {},
  'emissions.scope3.total':         {},
  'emissions.scope1.byCategory':    {},
  'emissions.scope2.byCategory':    {},
  'emissions.scope3.byCategory':    {},
};

const platformDataService = {
  async collectOrgData(organizationId, dataMappings, reportingYear) {
    // Merge base context bindings with template-declared bindings.
    // Template bindings take precedence (in case they have extra config).
    const mergedBindings = {
      ...BASE_CONTEXT_BINDINGS,
      ...(dataMappings?.bindings || {})
    };

    const mergedMappings = {
      ...(dataMappings || {}),
      bindings: mergedBindings
    };

    const { data, warnings } = await resolveAllBindings(mergedMappings, organizationId, reportingYear);

    return { data, warnings };
  }
};

module.exports = { platformDataService };
