'use strict';

// ============================================================================
// followupSuggestionService.js — Contextual follow-up question suggestions
//
// Generates 2-3 relevant follow-up questions based on the last query plan.
// Uses rule-based templates in v1 (no additional AI call / no extra quota).
// ============================================================================

const SUGGESTIONS = {
  emission_summary: [
    'Which scope contributes the most to our total emissions?',
    'How do our emissions compare to last year?',
    'Which node or department has the highest emissions?',
    'What is our Scope 3 breakdown?',
  ],
  data_entry: [
    'What percentage of entries are approved vs pending?',
    'Are there any rejected entries this period?',
    'Which nodes have the most data entry activity?',
    'Show me entries for a specific scope.',
  ],
  reduction: [
    'Which reduction projects are on track?',
    'What is the total actual reduction achieved so far?',
    'Show me net reduction entries for the last quarter.',
    'Which projects are behind their targets?',
  ],
  decarbonization: [
    'What is the progress toward our SBTi near-term target?',
    'Which scopes are covered under our SBTi commitment?',
    'When is our SBTi target year?',
    'What baseline year was used for our target?',
  ],
  esg_summary: [
    'What is the approval rate for ESG entries this year?',
    'Which ESG metrics have the most pending entries?',
    'Show me the boundary summary for the current reporting period.',
    'How many ESG data entries were submitted this quarter?',
  ],
  esg_data_entry: [
    'How many entries are in draft vs submitted status?',
    'Which nodes have incomplete ESG data?',
    'Show entries for a specific metric.',
    'Are there any entries awaiting reviewer approval?',
  ],
  esg_metrics: [
    'Which metrics are BRSR core metrics?',
    'How many custom vs global metrics are mapped?',
    'Show metrics in the environmental category.',
    'Which metrics require evidence uploads?',
  ],
  esg_boundary: [
    'How many nodes are included in our ESG boundary?',
    'When was the boundary last updated?',
    'How was the boundary set up — imported or manual?',
  ],
  cross_module_analysis: [
    'Is there a correlation between high emission nodes and low ESG scores?',
    'Which nodes contribute most to both carbon and ESG performance?',
    'Compare our emission reduction rate against ESG data completeness.',
  ],
  organization_flowchart: [
    'Which nodes are at the leaf level?',
    'How many levels does the organizational hierarchy have?',
    'Show me all nodes in a specific department.',
  ],
  process_flowchart: [
    'Which processes have emission data entries?',
    'Show me all process nodes for a specific scope.',
  ],
};

const GENERIC_SUGGESTIONS = [
  'Can you show me a breakdown by scope?',
  'What were the numbers last quarter?',
  'Can you summarize this as a trend over the past year?',
];

/**
 * Generate follow-up suggestions for the current query plan.
 * @param {object} plan  — from queryPlannerService
 * @param {object} [retrievalResult]  — optional, for data-aware suggestions
 * @returns {string[]}  — 2-3 question strings
 */
function generateSuggestions(plan, retrievalResult) {
  if (!plan?.intent) return GENERIC_SUGGESTIONS.slice(0, 2);

  const pool = SUGGESTIONS[plan.intent] || GENERIC_SUGGESTIONS;

  // Shuffle and pick 3
  const shuffled = [...pool].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, 3);
}

module.exports = { generateSuggestions };
