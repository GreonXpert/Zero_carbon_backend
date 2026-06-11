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

  // ── BRSR questionnaire — must be FIRST to prevent esg_metrics from stealing ──
  // BRSR is a questionnaire framework (questions, answers, stages, contributors).
  // Any mention of BRSR routes here unless it explicitly asks about ESG metrics/indicators.
  {
    intent: 'brsr_summary',
    keywords: [
      // standalone BRSR — broad catch-all
      /\bbrsr\b/i,
      // explicit questionnaire context
      /\b(business\s+responsibility(\s+and\s+sustainability)?(\s+report(ing)?)?)\b/i,
    ],
  },

  // ── ESGLink explicit guard — must come BEFORE user_data ─────────────────────
  // Catches queries where "esg link" / "esglink" is the clear focus.
  // user_data has broad clientId+details patterns that would otherwise steal these.
  {
    intent: 'esg_summary',
    keywords: [
      // "esgLink core/full/all details of Greon010", "give esgLink overview"
      /\besg.?link\s*(core|full|complete|all|entire|main|basic|general|comprehensive)?\s*(detail[s]?|info(rmation)?|overview|data|summary|status|profile)\b/i,
      /\b(give|show|get|tell|provide)\s+(me\s+)?(the\s+)?esg.?link\s*(detail[s]?|info|overview|data|summary|status)\b/i,
      /\b(detail[s]?|info(rmation)?|overview|data|summary)\s+(of|about|for|on)\s+(the\s+)?esg.?link\b/i,
      /\besg.?link\s*(module|platform|system|setup|configuration|status)\b/i,
      /\besg.?link\s*(core|full|complete)\b/i,
    ],
  },

  // ── ESGLink metrics explicit guard ───────────────────────────────────────────
  // "esgLink metric details", "metric details" in ESGLink context
  {
    intent: 'esg_metrics',
    keywords: [
      /\besg.?link\s*(metric[s]?|indicator[s]?|kpi[s]?|measure[s]?)\b/i,
      /\besg\s*metric[s]?\s*(detail[s]?|status|info|list|overview|count|configuration|assignment[s]?)\b/i,
      /\bmetric[s]?\s*(detail[s]?|status|info|list|overview|count|configuration|assignment[s]?)\b/i,
    ],
  },

  // User / client / team management data — must come BEFORE emission_summary
  // to avoid false matches on "my clients' emissions" (→ emission_summary) etc.
  {
    intent: 'user_data',
    keywords: [

      // ── "which/what all consultant/client I have" ─────────────────────────
      // Catches the natural phrasing: "which all consultant I have",
      // "which clients do I have", "what all client I manage" etc.
      /\b(which|what)\s+(all\s+)?(consultant[s]?|client[s]?|user[s]?|employee[s]?)\s*(do\s+)?(i\s+)?(have|manage|handle|own|created|added|assigned)?\b/i,
      /\bconsultant[s]?\s+(i\s+)?(have|manage|created|own|added)\b/i,
      /\bclient[s]?\s+(i\s+)?(have|manage|created|own)\b/i,
      /\ball\s+(my\s+)?consultant[s]?\b/i,
      /\ball\s+(my\s+)?client[s]?\b/i,

      // ── show / list / give ────────────────────────────────────────────────
      /\bshow\s+(me\s+)?(my\s+|all\s+)?(client[s]?|consultant[s]?)\b/i,
      /\blist\s+(my\s+|all\s+)?(client[s]?|consultant[s]?)\b/i,
      /\bgive\s+(me\s+)?(my\s+|all\s+)?(client[s]?|consultant[s]?)\s*(detail[s]?|list|info)?\b/i,
      /\bget\s+(me\s+)?(my\s+|all\s+)?(client[s]?|consultant[s]?)\s*(detail[s]?|list|info)?\b/i,

      // ── possessive references ─────────────────────────────────────────────
      /\b(my|assigned)\s+client[s]?\b/i,
      /\bmy\s+consultant[s]?\b/i,

      // ── "under me / under my account" ────────────────────────────────────
      /\bconsultant[s]?\s+under\s+(me|my)\b/i,
      /\bclient[s]?\s+under\s+(me|my)\b/i,
      /\b(user[s]?|employee[s]?|staff)\s+under\s+(me|my|this\s+client)\b/i,

      // ── counts / totals ───────────────────────────────────────────────────
      /\bhow\s+many\s+(employee[s]?|user[s]?|people|staff|contributor[s]?|reviewer[s]?|approver[s]?|auditor[s]?|viewer[s]?|client\s*employee[s]?|consultant[s]?)\b/i,
      /\b(total|count\s+of)\s+(employee[s]?|user[s]?|contributor[s]?|reviewer[s]?|approver[s]?|auditor[s]?|viewer[s]?|consultant[s]?)\b/i,

      // ── user details / client details ─────────────────────────────────────
      /\buser[s]?\s*(detail[s]?|list|breakdown|profile[s]?|group[s]?)\b/i,
      /\bclient\s*(user[s]?|team|staff|detail[s]?|list)\b/i,
      /\b(give|show|get)\s+(me\s+)?(user[s]?|employee[s]?)\s*(of|under|for|in)\s+(this\s+|my\s+)?client\b/i,

      // ── role-specific people ──────────────────────────────────────────────
      /\bclient\s*employee\s*(head[s]?|list|detail[s]?|count)\b/i,
      /\b(contributor[s]?|reviewer[s]?|approver[s]?|auditor[s]?|viewer[s]?)\s*(list|count|detail[s]?|in|under|how\s+many)\b/i,

      // ── accessible modules ────────────────────────────────────────────────
      /\baccessible\s*module[s]?\b/i,
      /\bassigned\s*module[s]?\b/i,
      /\b(show|give|list)\s+(me\s+)?(the\s+)?module[s]?\s*(access|detail[s]?|info)?\b/i,

      // ── assessment level (as management info, not decarbonization) ────────
      /\bassessment\s*level\s*(detail[s]?|info|of|for|per\s+client|breakdown)\b/i,
      /\besg\s*(assessment|link\s*assessment)\s*level\b/i,
      /\bclient\s*assessment\b/i,

      // ── team / people ─────────────────────────────────────────────────────
      /\bmy\s+(team|user[s]?|staff|people)\b/i,
      /\bteam\s*(structure|member[s]?|detail[s]?|list)\b/i,

      // ── consultant details / consultant admin ─────────────────────────────
      /\bconsultant\s*(admin[s]?\s*)?(detail[s]?|info|list|profile[s]?)\b/i,
      /\bconsultant[s]?\s*(detail[s]?|info|profile[s]?)\b/i,

      // ── who is / who are ──────────────────────────────────────────────────
      /\bwho\s+(is|are)\s+(the\s+)?(my\s+)?(client\s*admin|approver[s]?|reviewer[s]?|auditor[s]?|consultant[s]?)\b/i,

      // ── broad "consultant" standalone — catches "which all consultant …" ──
      // Only fires if the question is clearly asking about consultants as people,
      // not using "consultant" as an adjective (e.g. "consultant emissions").
      /\b(my|all|which|what|the)\s+consultant[s]?\b/i,
      /\bconsultant[s]?\s+(i|we|my|all|assigned|created|have|list|detail)\b/i,

      // ── "full details" / "all details" / "everything" about a client ────────
      // Catches: "Give me Greon012 client full details what all you have"
      //          "give me full details of this client"
      //          "tell me everything about this client"
      //          "client full details"
      /\bclient\s*(full\s*)?(detail[s]?|info|overview|profile|summary|data)\b/i,
      /\b(full|complete|all|entire)\s*(detail[s]?|info|overview|data)\s*(of|about|for|on)?\s*(the\s+|this\s+|a\s+)?client\b/i,
      /\b(give|show|get|tell|provide)\s+(me\s+)?(full|complete|all|entire|everything|detailed)\s*(detail[s]?|info|overview|data|about)?\s*(of|about|for|on|about)?\s*(the\s+|this\s+)?client\b/i,
      /\b(everything|all\s+detail[s]?|full\s+detail[s]?|complete\s+detail[s]?)\s*(about|on|for|of)\s*(the\s+|this\s+|a\s+)?client\b/i,
      /\bclient\s+full\b/i,
      /\bfull\s+client\b/i,

      // ── "[clientId] details" / "give me [clientId] details" ────────────────
      // clientId comes BEFORE "details": "Give me Greon012 full details"
      /\b(give|show|get|tell|provide)\s+(me\s+)?\w+\d+\s*(client\s*)?(full\s*)?(detail[s]?|info|overview|profile|data)\b/i,
      /\b\w+\d+\s+(client\s*)?(full\s*)?(detail[s]?|info|overview|summary)\b/i,

      // ── "details of [clientId]" — clientId comes AFTER "details" ────────────
      // Catches: "give me the details of Greon012"
      //          "details of Greon012"
      //          "info on Greon012"
      //          "information about Greon012"
      /\b(detail[s]?|info|information|overview|data|everything)\s+(of|about|for|on)\s+\w+\d+\b/i,
      /\b(give|show|get|tell|provide)\s+(me\s+)?(the\s+)?(detail[s]?|info|information|overview|everything|data)\s+(of|about|for|on)\s+\w+\d+\b/i,

      // ── "[clientId] info / data / details" without "client" keyword ──────────
      // Catches: "Greon012 info", "Greon012 data", "Greon012 details"
      /\b[A-Za-z]+\d{1,}\s+(info|data|detail[s]?|overview|summary|profile|report)\b/i,

      // ── "tell me about [clientId]" / "what is [clientId]" ───────────────────
      /\b(tell|show)\s+(me\s+)?about\s+\w+\d+\b/i,
      /\b(what|who)\s+is\s+\w+\d+\b/i,
      /\bshow\s+(me\s+)?\w+\d+\b/i,

      // ── "what all you have" / "everything you have" about a client ──────────
      /\bwhat\s+all\s+(you\s+)?(have|know|can\s+tell)\b/i,
      /\beverything\s+(you\s+)?(have|know)\s*(about|on|for)?\b/i,
      /\ball\s+(you\s+)?(have|know)\s*(about|on|for)?\b/i,

      // ── client overview / profile ────────────────────────────────────────────
      /\bclient\s*(overview|profile|snapshot|report|breakdown)\b/i,
      /\b(overview|profile|snapshot)\s*(of|for|about)?\s*(the\s+|this\s+)?client\b/i,
    ],
  },

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

  // Cross-client ranking: "which client has highest emissions", "rank all clients",
  // "top emitting clients across all". Must come BEFORE emission_summary so these
  // don't get routed as single-client queries.
  {
    intent: 'cross_client_summary',
    keywords: [
      // "which client has the highest/lowest/most/least emission(s)"
      /\bwhich\s+client\s+(has|have|had|with)\s+(the\s+)?(highest|lowest|most|least|top|bottom|max|min)\b/i,
      // "highest/lowest emission(s) (across/among/between) (all/my) clients"
      /\b(highest|lowest|most|least|top|bottom|max|min)\s+emission[s]?\b.{0,40}\b(all|my|across)\s+client[s]?\b/i,
      /\b(all|my)\s+client[s]?\b.{0,60}\b(highest|lowest|most|least|top|bottom|rank|ranked|ranking)\b/i,
      // "rank/ranking (all/my) clients by emissions"
      /\b(rank(ing)?|sort(ed)?|order(ed)?)\s+(all\s+|my\s+)?client[s]?\s+(by\s+)?(emission|carbon|co2|ghg)/i,
      // "top N clients by emissions"
      /\btop\s+\d+\s+client[s]?\s+(by\s+)?(emission|carbon|co2|ghg)/i,
      // "across all clients" + emission-related word
      /\bacross\s+all\s+client[s]?\b.{0,80}\bemission[s]?\b/i,
      /\bemission[s]?\b.{0,80}\bacross\s+all\s+client[s]?\b/i,
      // "client with most/least/highest carbon/emissions"
      /\bclient[s]?\s+(with\s+)?(the\s+)?(most|least|highest|lowest|max|min|top|bottom)\s+(emission|carbon|co2|ghg)/i,
      // "emission summary across all clients" / "emission data for all clients"
      /\bemission\s*(summary|data|total)s?\s*(across|for|of|from)\s+(all|my)\s+client[s]?\b/i,
    ],
  },

  // Client-vs-client comparison — two clientId-pattern tokens connected by
  // "and" / "vs" / "versus", or explicit "compare/comparison" with two clientIds.
  // Must come BEFORE emission_summary to avoid false routing.
  {
    intent: 'client_comparison',
    keywords: [
      // "[clientId] and/vs/versus [clientId]" — two alphanumeric client tokens
      /\b[A-Za-z]{2,}\d{2,}\b.{0,60}\b(and|vs\.?|versus)\b.{0,60}\b[A-Za-z]{2,}\d{2,}\b/i,
      // "compare/comparison ... [clientId] ... [clientId]"
      /\b(compare|comparison)\b.*\b[A-Za-z]{2,}\d{2,}\b.*\b[A-Za-z]{2,}\d{2,}\b/i,
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
      /\bmetric[s]?\s*(definition|mapping|node|list|overview|detail[s]?|assignment[s]?|configuration|count|status)\b/i,
      /\b(environmental|social|governance)\s*(metric[s]?|indicator[s]?|kpi[s]?)\b/i,
      /\b(brsr|gri|tcfd|cdp|sasb)\s*(metric[s]?|indicator[s]?|framework|status|level|overview|detail[s]?|compliance|configuration)?\b/i,
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
