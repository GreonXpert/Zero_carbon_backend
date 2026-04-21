'use strict';

// ============================================================================
// intentRouterService.js — Classifies user questions into GreOn IQ domains
//
// APPROACH: Rule-based keyword matching (deterministic, fast, no AI cost).
// This runs BEFORE any DeepSeek call. Only use AI for intent detection when
// the rule-based classification returns 'ambiguous'.
//
// Returns one of:
//   emission_summary, data_entry, organization_flowchart, process_flowchart,
//   reduction, decarbonization,
//   esg_boundary, esg_metrics, esg_data_entry, esg_summary,
//   cross_module_analysis,
//   report,       — user is requesting a downloadable report
//   out_of_system — question is clearly outside internal data
//   ambiguous     — unclear, needs context or AI disambiguation
// ============================================================================

// ── Keyword maps (order = priority — first match wins) ────────────────────────
const INTENT_RULES = [

  // Report request — must come before emission_summary to catch "create a report"
  {
    intent: 'report',
    keywords: [
      /\b(generate|create|build|make|produce|export|download)\b.*\breport\b/i,
      /\breport\b.*\b(generate|create|build|make|produce|export|download)\b/i,
      /\bdownload(able)?\b/i,
      /\bexport\s+(to|as)?\s*(pdf|docx|word|excel|xlsx)\b/i,
    ],
  },

  // Emission summary — broad coverage for all natural phrasings
  {
    intent: 'emission_summary',
    keywords: [
      // explicit summary/overview words
      /\bemission[s]?\s*(summary|total|overview|breakdown|analysis|data|report|info)\b/i,
      /\b(summary|overview|total|breakdown|analysis)\s*(of\s*)?(emission[s]?|ghg|co2|carbon)\b/i,
      // "total / overall / aggregate emissions"
      /\b(total|overall|aggregate|combined)\s*emission[s]?\b/i,
      // scope X alone — "scope 3 breakdown", "what is scope 1", "scope 2 data"
      /\bscope\s*[123]\b/i,
      // units / abbreviations
      /\btco2e?\b/i,
      /\bco2\s*e?\b/i,
      // GHG / carbon phrasing
      /\bghg\b/i,
      /\bcarbon\s*(footprint|emission[s]?|summary|output|output|level[s]?|data)\b/i,
      /\b(emission|carbon|ghg)\s*(by|per)\s*(scope|category|node|department|location|month|year|period)\b/i,
      // generic "how much did we emit", "what are our emissions"
      /\b(how\s+much|what)\s+.{0,30}\bemit(ted)?\b/i,
      /\bwhat\s+are\s+(our|the|my)\s+emission[s]?\b/i,
      /\bour\s+emission[s]?\b/i,
      /\bshow\s+(me\s+)?(our\s+)?(emission[s]?|carbon|ghg|co2)\b/i,
      /\btell\s+me\s+(about\s+)?(the\s+)?(emission|carbon|scope|ghg)\b/i,
    ],
  },

  // Reduction & net reduction
  {
    intent: 'reduction',
    keywords: [
      /\b(reduction|reductions?|abatement)\s*(project[s]?|plan|summary|performance|target|goal)\b/i,
      /\bnet\s*reduction\b/i,
      /\breduction\s*project[s]?\b/i,
      /\bghg\s*reduction\b/i,
      /\bcarbon\s*reduction\b/i,
      /\bproject[s]?\s*(reduction|abatement|target)\b/i,
      /\b(reduce|reducing|reduced)\s*(emission[s]?|carbon|ghg)\b/i,
    ],
  },

  // SBTi / Decarbonization
  {
    intent: 'decarbonization',
    keywords: [
      /\bsbti\b/i,
      /\bscience.based.target[s]?\b/i,
      /\bdecarboni[sz]ation\b/i,
      /\bnet.?zero\s*(target|goal|pathway|plan)?\b/i,
      /\bclimate\s*(target[s]?|goal[s]?|commitment)\b/i,
      /\bcarbon\s*neutral(ity)?\b/i,
      /\bparis\s*(agreement|accord)\b/i,
    ],
  },

  // Process flowchart — "processflowchart", "process flow", "process nodes"
  {
    intent: 'process_flowchart',
    keywords: [
      /\bprocess\s*flow\s*chart\b/i,
      /\bprocessflowchart\b/i,
      /\bprocess\s*flow\b/i,
      /\bprocess\s*(node[s]?|emission[s]?|boundary|scope|structure)\b/i,
      /\bprocess\s*data\s*entr(y|ies)\b/i,
      /\b(node[s]?|emission[s]?)\s*(in|of|for)\s*(the\s+)?process\b/i,
    ],
  },

  // Organization flowchart — "flowchart", "org chart", "org structure", "nodes"
  {
    intent: 'organization_flowchart',
    keywords: [
      /\b(org(anization|anisation)?)\s*(flowchart|flow\s*chart|chart|structure|overview|node[s]?)\b/i,
      /\bflowchart\b/i,        // bare "flowchart" → org flowchart by default
      /\bflow\s*chart\b/i,
      /\b(show|list|get|what\s+are)\s+(the\s+)?(org\s+)?(node[s]?|department[s]?|location[s]?)\b/i,
      /\borganization\s*(structure|overview|chart|hierarchy)\b/i,
      /\borganisation\s*(structure|overview|chart|hierarchy)\b/i,
      /\bnode[s]?\s*(list|overview|structure|hierarchy|in\s+the\s+(org|flowchart|chart))\b/i,
    ],
  },

  // Data entry (generic)
  {
    intent: 'data_entry',
    keywords: [
      /\bdata\s*entr(y|ies)\b/i,
      /\b(manual|iot|api|ocr)\s*(data|entry|entries)\b/i,
      /\bdata\s*(input[s]?|record[s]?|submission[s]?|point[s]?)\b/i,
      /\braw\s*data\b/i,
      /\b(pending|approved|rejected)\s*(entr(y|ies)|submission[s]?)\b/i,
    ],
  },

  // ESGLink summary
  {
    intent: 'esg_summary',
    keywords: [
      /\besg\s*(summary|overview|total|report|performance|result[s]?)\b/i,
      /\besg.?link\s*(summary|overview|data|performance)\b/i,
      /\bboundary\s*(summary|overview|total[s]?|result[s]?)\b/i,
      /\b(show|tell|give)\s+(me\s+)?(the\s+)?esg\s*(summary|overview|performance)\b/i,
    ],
  },

  // ESGLink data entry / data collection
  {
    intent: 'esg_data_entry',
    keywords: [
      /\besg\s*(data\s*)?(entr(y|ies)|submission[s]?|collection|input[s]?)\b/i,
      /\besg.?link\s*(data|submission|collection)\b/i,
      /\bcontributor[s]?\s*(submission|data|entr(y|ies))\b/i,
      /\bapproval\s*workflow\b/i,
      /\besg\s*(pending|approved|rejected|status)\b/i,
    ],
  },

  // ESGLink metrics
  {
    intent: 'esg_metrics',
    keywords: [
      /\besg\s*(metric[s]?|indicator[s]?|kpi[s]?|measure[s]?)\b/i,
      /\bmetric[s]?\s*(definition|mapping|node|list|overview)\b/i,
      /\b(environmental|social|governance)\s*(metric[s]?|indicator[s]?|kpi[s]?)\b/i,
      /\b(brsr|gri|tcfd|cdp|sasb)\s*(metric[s]?|indicator[s]?|framework)?\b/i,
    ],
  },

  // ESGLink boundary — "esg boundary", "esg flowchart", "esg org", "boundary nodes"
  {
    intent: 'esg_boundary',
    keywords: [
      /\besg\s*(boundary|flowchart|flow\s*chart|chart|org|structure|node[s]?|entity|entities)\b/i,
      /\besg.?link\s*(boundary|org|structure|node[s]?)\b/i,
      /\bboundary\s*(node[s]?|structure|definition|list|overview)\b/i,
      /\besg\s*(organ(iz|is)ation|entity|entities)\b/i,
    ],
  },

  // Cross-module analysis
  {
    intent: 'cross_module_analysis',
    keywords: [
      /\b(compare|comparison|correlat|combined)\b.*\b(emission|esg|reduction|target)\b/i,
      /\bemission[s]?\s*(vs|versus|and)\s*(esg|reduction|target)\b/i,
      /\bcross.module\b/i,
      /\bintegrated\s*(report|analysis|view)\b/i,
    ],
  },

  // Out-of-system topics — hard block, no AI call
  {
    intent: 'out_of_system',
    keywords: [
      /\b(weather|climate\s*change\s*science|global\s*warming\s*cause)\b/i,
      /\b(stock\s*market|cryptocurrency|bitcoin|nft)\b/i,
      /\b(recipe|food|cooking|restaurant)\b/i,
      /\b(sport[s]?|football|cricket|basketball)\b/i,
      /\b(movie|film|celebrity|entertainment)\b/i,
      /\b(health|medical|doctor|hospital|disease|symptom)\b/i,
      /\b(politics|election|government\s*policy\s*outside)\b/i,
      /\bwho\s*(is|are|was|were)\s*(the\s*)?(president|prime\s*minister|ceo)\b/i,
      /\bhow\s+to\s+(cook|bake|make|draw|paint|play)\b/i,
      /\b(joke[s]?|fun\s*fact|trivia)\b/i,
    ],
  },
];

/**
 * Classify a user question into an intent domain.
 *
 * @param {string} question
 * @returns {{ intent: string, confidence: 'high'|'medium'|'low' }}
 */
function classifyIntent(question) {
  if (!question || typeof question !== 'string') {
    return { intent: 'ambiguous', confidence: 'low' };
  }

  for (const rule of INTENT_RULES) {
    for (const pattern of rule.keywords) {
      if (pattern.test(question)) {
        return { intent: rule.intent, confidence: 'high' };
      }
    }
  }

  // No keyword match — return ambiguous
  // queryPlannerService will attempt context-based resolution using session history
  return { intent: 'ambiguous', confidence: 'low' };
}

/**
 * Attempt to resolve 'ambiguous' intent using the session's last context.
 *
 * Strategy (in order):
 *  1. Explicit follow-up / comparison words → reuse lastIntent
 *  2. Temporal references with no domain change → reuse lastIntent
 *  3. Short question (< 6 words) with no new domain signal → reuse lastIntent
 *  4. Otherwise → ambiguous
 *
 * @param {string} question
 * @param {object|null} contextState   ChatSession.contextState
 * @returns {string}  resolved intent or 'ambiguous'
 */
function resolveAmbiguousIntent(question, contextState) {
  if (!contextState || !contextState.lastIntent) return 'ambiguous';

  // Anything that reads as a follow-up, comparison, or temporal drill-down
  const followUpPatterns = [
    /\b(compare|comparison|vs\.?|versus|against)\b/i,
    /\b(previous|prior|last|earlier|before|past)\b/i,
    /\b(same|that|it|them|those|these|this|which)\b/i,
    /\b(drill.?down|more\s*detail|detail[s]?|breakdown|split|expand)\b/i,
    /\b(increase|decrease|change|trend|growth|drop|rise|fell|went\s+up|went\s+down)\b/i,
    /\b(reason[s]?|why|cause[s]?|factor[s]?|driver[s]?)\b/i,
    /\b(month|year|quarter|week|period|annual|monthly|yearly|quarterly)\b/i,
    /\b(show|tell|give|explain|summarize|what\s+about|how\s+about)\b/i,
    /\b(main|top|highest|lowest|biggest|most|least)\b/i,
  ];

  const isFollowUp = followUpPatterns.some((p) => p.test(question));
  if (isFollowUp) return contextState.lastIntent;

  // Short vague questions in an active session → treat as same domain
  const wordCount = question.trim().split(/\s+/).length;
  if (wordCount <= 6) return contextState.lastIntent;

  return 'ambiguous';
}

module.exports = { classifyIntent, resolveAmbiguousIntent };
