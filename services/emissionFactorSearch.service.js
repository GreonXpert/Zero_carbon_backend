/**
 * emissionFactorSearch.service.js
 * ---------------------------------------------------------------
 * Super-Search service for all Emission Factor collections.
 *
 * Architecture: Search Provider Registry
 *   - Each source is registered once with its model + searchable fields.
 *   - Adding a new source = adding one entry to PROVIDERS (no logic changes).
 *   - Future API sources can plug in via type:"api" + a mapper function.
 *
 * Matching priority (per provider, sequential):
 *   1. Exact     – full case-insensitive match on primary fields.
 *   2. Partial   – token-based contains on all searchable fields.
 *   3. Fuzzy     – Levenshtein re-ranking over a small candidate set
 *                  fetched by $text index (no full-collection regex scan).
 *
 * Comma handling:
 *   - Query "diesel, transport" → tokens ["diesel","transport"]
 *   - AND results (match ALL tokens) scored higher than OR results.
 *
 * Performance:
 *   - All queries run with maxTimeMS (configurable).
 *   - Promise.allSettled keeps one slow/failed source from killing others.
 *   - lean() + field projection on every query.
 *   - Input sanitised + length-capped.
 *   - Regex anchors / escaping everywhere – NO unbounded full-scan regex.
 *   - Fuse.js-style scoring only over a bounded candidate set (≤200 docs).
 * ---------------------------------------------------------------
 */

'use strict';

const EPAData    = require('../models/EmissionFactor/EPAData');
const IPCCData   = require('../models/EmissionFactor/IPCCData');
const DefraData  = require('../models/EmissionFactor/DefraData');
const CountryEF  = require('../models/EmissionFactor/countryEmissionFactorModel');

// ─── Constants ───────────────────────────────────────────────────────────────
const MAX_QUERY_LEN   = 120;
const MAX_LIMIT       = 25000;
const DEFAULT_LIMIT   = 20;
const QUERY_TIMEOUT   = 2500;          // ms per MongoDB query
const FUZZY_CANDIDATE = 20000;           // max docs to run in-memory fuzzy on
const FUZZY_THRESHOLD = 0.38;          // 0–1; lower = more permissive (covers 1-2 char typos)
// ── Score Tiers ──────────────────────────────────────────────────────────────
// Each tier's maximum is strictly below the next tier's minimum so no tier
// can ever drift into a higher tier through floating-point variation.
//
//  Tier          Score range   Formula
//  ──────────────────────────────────────────────────────────────────────────
//  exact         1.00          fixed — token matches full field value
//  comma-all     0.90          fixed — ALL tokens found (AND match)
//  comma-partial 0.70–0.89     0.70 + (matchedCount / totalTokens) * 0.19
//                              e.g. 3 of 4 tokens → 0.70 + 0.75*0.19 = 0.843
//                              Minimum matchedCount = ceil(tokens/2) to enter
//  partial       0.75          fixed — single-token contains match
//  fuzzy         0.30–0.45     0.30 + jwScore*0.15  (max 0.45)
//  ──────────────────────────────────────────────────────────────────────────
//  NOTE: comma-partial range 0.70–0.89 sits between partial (0.75) and
//  comma-all (0.90) intentionally — a doc matching 3 of 4 tokens ranks above
//  a plain single-token partial match.  A doc matching only 1 of 4 tokens
//  (below the majority threshold) is EXCLUDED entirely — not surfaced at all.
const EXACT_SCORE          = 1.00;
const COMMA_ALL_SCORE      = 0.90;  // all tokens matched (AND)
const COMMA_PARTIAL_BASE   = 0.70;  // base score for majority-token matches
const COMMA_PARTIAL_RANGE  = 0.19;  // added proportionally per token ratio
const PARTIAL_SCORE        = 0.75;  // single-token partial (non-comma query)
const FUZZY_BASE           = 0.30;
const FUZZY_RANGE          = 0.15;  // max 0.45 — never reaches any partial tier

// ─── Provider Registry ───────────────────────────────────────────────────────
/**
 * Each provider entry:
 *  type          : "mongo" | "api"  (api providers need a fetch() fn – future)
 *  model         : Mongoose model
 *  primaryFields : fields checked first for exact / partial match (indexed)
 *  allFields     : all searchable string fields (for multi-token OR search)
 *  textIndex     : true if $text index is defined on this model
 *  projection    : lean projection – keeps payload small
 *  staticFilters : always-applied mongo filters (e.g. { isActive: true })
 */
const PROVIDERS = {
  defra: {
    type: 'mongo',
    model: DefraData,
    primaryFields: ['level1', 'level2', 'level3', 'level4', 'columnText'],
    allFields:     ['scope', 'level1', 'level2', 'level3', 'level4', 'columnText', 'uom', 'ghgUnit'],
    textIndex:     true,   // see index definitions at bottom of file
    projection:    { conversionFactorHistory: 0, createdBy: 0, updatedBy: 0, __v: 0 },
    staticFilters: {},
  },
  epa: {
    type: 'mongo',
    model: EPAData,
    primaryFields: ['level1EPA', 'level2EPA', 'level3EPA', 'level4EPA', 'columnTextEPA'],
    allFields:     ['scopeEPA', 'level1EPA', 'level2EPA', 'level3EPA', 'level4EPA', 'columnTextEPA', 'uomEPA', 'ghgUnitEPA'],
    textIndex:     true,
    projection:    { conversionFactorHistoryEPA: 0, createdBy: 0, updatedBy: 0, __v: 0 },
    staticFilters: {},
  },
  ipcc: {
    type: 'mongo',
    model: IPCCData,
    primaryFields: ['level1', 'level2', 'level3', 'Description', 'TypeOfParameter'],
    allFields:     ['level1', 'level2', 'level3', 'Cpool', 'TypeOfParameter', 'Description',
                    'TechnologiesOrPractices', 'ParametersOrConditions',
                    'RegionOrRegionalConditions', 'OtherProperties', 'Unit', 'DataProvider'],
    textIndex:     true,
    projection:    { history: 0, createdBy: 0, updatedBy: 0, __v: 0 },
    staticFilters: { isActive: { $ne: false } },
  },
  country: {
    type: 'mongo',
    model: CountryEF,
    primaryFields: ['country', 'regionGrid', 'emissionFactor'],
    allFields:     ['country', 'regionGrid', 'emissionFactor', 'reference', 'unit'],
    textIndex:     true,
    projection:    { __v: 0 },
    staticFilters: {},
  },
  // ── Future API source example ──────────────────────────────────────────────
  // climatiq: {
  //   type: 'api',
  //   baseUrl: 'https://api.climatiq.io/data/v1/search',
  //   apiKey: process.env.CLIMATIQ_API_KEY,
  //   mapper: (rawResults, q) => rawResults.results.map(r => ({...})),
  // },
};

const ALLOWED_SOURCES = Object.keys(PROVIDERS);

// ─── Pure Utility Functions ───────────────────────────────────────────────────

/**
 * Escape special regex characters in a string.
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalise a query string: lowercase, trim, collapse whitespace.
 * @param {string} raw
 * @returns {string}
 */
function normalizeQuery(raw) {
  return raw
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_QUERY_LEN);
}

/**
 * Split a comma-containing query into trimmed, non-empty tokens.
 * Returns [fullQuery] if no comma present.
 * @param {string} normalized
 * @returns {string[]}
 */
function splitCommaQuery(normalized) {
  if (!normalized.includes(',')) return [normalized];
  return normalized
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);
}

/**
 * Jaro-Winkler similarity (0–1).  Used only over a bounded candidate set.
 * @param {string} s1
 * @param {string} s2
 * @returns {number}
 */
function jaroWinkler(s1, s2) {
  if (s1 === s2) return 1;
  const l1 = s1.length, l2 = s2.length;
  const matchDist = Math.max(Math.floor(Math.max(l1, l2) / 2) - 1, 0);
  const s1m = new Array(l1).fill(false);
  const s2m = new Array(l2).fill(false);
  let matches = 0, transpositions = 0;
  for (let i = 0; i < l1; i++) {
    const start = Math.max(0, i - matchDist);
    const end   = Math.min(i + matchDist + 1, l2);
    for (let j = start; j < end; j++) {
      if (s2m[j] || s1[i] !== s2[j]) continue;
      s1m[i] = s2m[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let k = 0;
  for (let i = 0; i < l1; i++) {
    if (!s1m[i]) continue;
    while (!s2m[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  const jaro = (matches / l1 + matches / l2 + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, l1, l2); i++) {
    if (s1[i] !== s2[i]) break;
    prefix++;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Score a single document's fields against a set of tokens using Jaro-Winkler.
 * Returns a float 0–1 representing the best average token coverage.
 * @param {object} doc
 * @param {string[]} fields
 * @param {string[]} tokens
 * @returns {number}
 */
function scoreDocFuzzy(doc, fields, tokens) {
  const words = fields
    .map(f => (doc[f] || '').toLowerCase())
    .join(' ')
    .split(/\s+/)
    .filter(Boolean);

  if (!words.length) return 0;

  const tokenScores = tokens.map(tok => {
    return Math.max(...words.map(w => jaroWinkler(tok, w)));
  });
  return tokenScores.reduce((a, b) => a + b, 0) / tokenScores.length;
}

/**
 * Build a safe $regex filter for a single token over a list of fields.
 * @param {string} token - already-escaped
 * @param {string[]} fields
 * @returns {object} Mongo $or clause
 */
function buildTokenRegexClause(token, fields) {
  return { $or: fields.map(f => ({ [f]: { $regex: token, $options: 'i' } })) };
}

/**
 * Given an array of raw results + their match metadata, normalise into
 * the unified result shape.
 * @param {string}   sourceName
 * @param {object[]} docs
 * @param {string}   matchReason
 * @param {number}   baseScore
 * @param {string[]|null} requestedFields
 */
function formatResults(sourceName, docs, matchReason, baseScore, requestedFields) {
  return docs.map(doc => {
    let data = doc;
    if (requestedFields && requestedFields.length) {
      data = {};
      requestedFields.forEach(f => { if (doc[f] !== undefined) data[f] = doc[f]; });
      data._id = doc._id;
    }
    return {
      source:      sourceName,
      id:          doc._id,
      score:       baseScore,
      matchReason,
      data,
    };
  });
}

// ─── MongoDB Query Builders ───────────────────────────────────────────────────

/**
 * Stage 1 – Exact match on primary fields (case-insensitive).
 * Uses anchored regex on indexed fields → fast.
 * @param {object}   provider
 * @param {string[]} tokens
 * @param {number}   limit
 * @returns {Promise<object[]>}
 */
async function queryExact(provider, tokens, limit) {
  const { model, primaryFields, projection, staticFilters } = provider;
  const escaped = tokens.map(escapeRegex);

  // Build: each token must appear as a whole-word match on at least one primary field
  const tokenClauses = escaped.map(t =>
    buildTokenRegexClause(`^${t}$`, primaryFields)
  );
  const filter = { ...staticFilters, $and: tokenClauses };

  // No .limit() here — we want ALL exact matches so pagination is accurate
  return model
    .find(filter)
    .select(projection)
    .maxTimeMS(QUERY_TIMEOUT)
    .lean()
    .exec();
}

/**
 * Stage 2 – Partial (contains) match across all searchable fields.
 * Excludes docs already found in exactIds.
 * @param {object}   provider
 * @param {string[]} tokens
 * @param {string[]} exactIds   – _id strings to exclude
 * @param {number}   limit
 * @param {boolean}  allRequired – if true use AND across tokens (comma-AND)
 * @returns {Promise<object[]>}
 */
async function queryPartial(provider, tokens, exactIds, limit, allRequired) {
  const { model, allFields, projection, staticFilters } = provider;
  const escaped = tokens.map(escapeRegex);

  const tokenClauses = escaped.map(t => buildTokenRegexClause(t, allFields));
  const logicClause  = allRequired ? { $and: tokenClauses } : { $or: tokenClauses };

  const filter = {
    ...staticFilters,
    ...logicClause,
    ...(exactIds.length ? { _id: { $nin: exactIds } } : {}),
  };

  // No .limit() here — fetch ALL partial matches for accurate totalMatched count
  return model
    .find(filter)
    .select(projection)
    .maxTimeMS(QUERY_TIMEOUT)
    .lean()
    .exec();
}

/**
 * Stage 3 – Fuzzy match via $text search → bounded candidate set → Jaro-Winkler re-rank.
 * Falls back to a liberal regex on primaryFields when $text index is absent.
 * @param {object}   provider
 * @param {string[]} tokens
 * @param {string[]} seenIds
 * @param {number}   limit
 * @returns {Promise<{doc:object, fuzzyScore:number}[]>}
 */
/**
 * Generate prefix substrings + trigrams from a misspelled token so we can
 * pull real candidates from MongoDB without needing a $text index.
 *
 * "deisel"   -> prefixes ["dei","deis","deis","deisel"] + trigrams ["dei","eis","isel","sel"]
 * "anthrasit" -> prefix "ant","anth","anthr" catch "Anthracite" in DB
 */
function buildFuzzyPrefixes(token) {
  const prefixes = new Set();
  prefixes.add(token);
  for (let len = 3; len <= Math.min(token.length, 6); len++) {
    prefixes.add(token.slice(0, len));
  }
  // trigrams catch transpositions (deisel -> eis matches diesel)
  for (let i = 0; i <= token.length - 3; i++) {
    prefixes.add(token.slice(i, i + 3));
  }
  return Array.from(prefixes).sort((a, b) => b.length - a.length);
}

/**
 * Fetch fuzzy candidates using 4-strategy cascade.
 * Works WITHOUT $text indexes (strategies 2-4 are pure regex/sample).
 *
 * Strategy 1: $text search  (fastest — requires index)
 * Strategy 2: Anchored prefix regex on primaryFields  (index-friendly, catches prefix typos)
 * Strategy 3: Trigram contains on allFields  (catches transpositions like deisel -> diesel)
 * Strategy 4: Recent-doc sample  (last resort, always returns something)
 *
 * Jaro-Winkler re-ranks all candidates at the end.
 */
async function queryFuzzy(provider, tokens, seenIds, limit) {
  const { model, allFields, primaryFields, projection, staticFilters, textIndex } = provider;
  let candidates = [];

  const seenSet   = new Set(seenIds.map(String));
  const baseFilter = {
    ...staticFilters,
    ...(seenIds.length ? { _id: { $nin: seenIds } } : {}),
  };

  // ── Strategy 1: $text index ──────────────────────────────────────────────
  if (textIndex) {
    try {
      const docs = await model
        .find({ ...baseFilter, $text: { $search: tokens.join(' ') } })
        .select({ ...projection, _score: { $meta: 'textScore' } })
        .sort({ _score: { $meta: 'textScore' } })
        .limit(FUZZY_CANDIDATE)
        .maxTimeMS(QUERY_TIMEOUT)
        .lean()
        .exec();
      if (docs.length) candidates = docs;
    } catch (_) { /* index not ready */ }
  }

  // ── Strategy 2: Anchored prefix regex on primaryFields ───────────────────
  // Uses ^prefix so MongoDB can leverage a B-tree index (fast even at 25k docs).
  // "deisel" -> try "dei","deis","deisel" prefixes -> "die"/"dies" miss but
  // trigrams from strategy 3 will catch it.
  if (!candidates.length) {
    const prefixClauses = [];
    for (const token of tokens) {
      for (const prefix of buildFuzzyPrefixes(token)) {
        if (prefix.length < 3) continue;
        const esc = escapeRegex(prefix);
        primaryFields.forEach(f => prefixClauses.push({ [f]: { $regex: '^' + esc, $options: 'i' } }));
      }
    }
    if (prefixClauses.length) {
      try {
        const docs = await model
          .find({ ...baseFilter, $or: prefixClauses })
          .select(projection)
          .limit(FUZZY_CANDIDATE)
          .maxTimeMS(QUERY_TIMEOUT)
          .lean()
          .exec();
        if (docs.length) candidates = docs;
      } catch (_) {}
    }
  }

  // ── Strategy 3: Trigram contains on allFields ────────────────────────────
  // Catches transpositions: "deisel" trigrams include "eis","sel"
  // "diesel" contains both -> candidates fetched -> Jaro-Winkler scores high.
  if (!candidates.length) {
    const trigramClauses = [];
    for (const token of tokens) {
      for (let i = 0; i <= token.length - 3; i++) {
        const tri = escapeRegex(token.slice(i, i + 3));
        allFields.forEach(f => trigramClauses.push({ [f]: { $regex: tri, $options: 'i' } }));
      }
    }
    if (trigramClauses.length) {
      try {
        const docs = await model
          .find({ ...baseFilter, $or: trigramClauses })
          .select(projection)
          .limit(FUZZY_CANDIDATE)
          .maxTimeMS(QUERY_TIMEOUT)
          .lean()
          .exec();
        if (docs.length) candidates = docs;
      } catch (_) {}
    }
  }

  // ── Strategy 4: Recent-doc sample (last resort) ──────────────────────────
  if (!candidates.length) {
    try {
      candidates = await model
        .find(staticFilters)
        .select(projection)
        .sort({ createdAt: -1 })
        .limit(FUZZY_CANDIDATE)
        .maxTimeMS(QUERY_TIMEOUT)
        .lean()
        .exec();
    } catch (_) {}
  }

  // ── Filter already-seen, then Jaro-Winkler re-rank ───────────────────────
  candidates = candidates.filter(d => !seenSet.has(String(d._id)));

  const scored = candidates
    .map(doc => ({ doc, fuzzyScore: scoreDocFuzzy(doc, allFields, tokens) }))
    .filter(x => x.fuzzyScore >= FUZZY_THRESHOLD)
    .sort((a, b) => b.fuzzyScore - a.fuzzyScore)
    .slice(0, limit);

  return scored;
}

// ─── Comma-Query Helpers ─────────────────────────────────────────────────────

/**
 * Count how many of the given tokens are contained (substring) in any field
 * value of the doc.  Case-insensitive.  Returns integer 0..tokens.length.
 */
function countTokenHits(doc, fields, tokens) {
  const text = fields.map(f => (doc[f] || '').toLowerCase()).join(' ');
  return tokens.filter(tok => text.includes(tok)).length;
}

/**
 * Compute a score for a comma-query result based on how many tokens matched.
 *
 *  matchedCount === totalTokens  →  COMMA_ALL_SCORE  (0.90, fixed ceiling)
 *  matchedCount  <  totalTokens  →  COMMA_PARTIAL_BASE + ratio * COMMA_PARTIAL_RANGE
 *
 * The caller is responsible for only calling this when matchedCount >= minRequired.
 */
function commaScore(matchedCount, totalTokens) {
  if (matchedCount >= totalTokens) return COMMA_ALL_SCORE;
  const ratio = matchedCount / totalTokens;
  return COMMA_PARTIAL_BASE + ratio * COMMA_PARTIAL_RANGE;
}

// ─── Per-Provider Search Orchestrator ────────────────────────────────────────

/**
 * Run all three match stages for one provider and return unified result objects.
 * @param {string}   key            – provider key (e.g. "defra")
 * @param {object}   provider
 * @param {string[]} tokens
 * @param {boolean}  hasComma
 * @param {number}   limit
 * @param {string[]|null} requestedFields
 * @returns {Promise<object[]>}
 */
async function searchProvider(key, provider, tokens, hasComma, limit, requestedFields) {
  const results = [];
  const { allFields } = provider;

  // ─────────────────────────────────────────────────────────────────────────
  // STAGE 1 — Exact match
  // Single token : token must equal a full primary-field value  (^token$)
  // Comma query  : ALL tokens must each equal a primary-field value (AND)
  // Scored at EXACT_SCORE (1.00) always — exact is exact.
  // ─────────────────────────────────────────────────────────────────────────
  let exactDocs = [];
  try {
    exactDocs = await queryExact(provider, tokens, limit);
  } catch (err) {
    console.warn(`[SuperSearch] exact query failed for "${key}":`, err.message);
  }

  const exactIds = exactDocs.map(d => d._id);
  results.push(...formatResults(key, exactDocs, 'exact', EXACT_SCORE, requestedFields));

  // ─────────────────────────────────────────────────────────────────────────
  // STAGE 2 — Partial / Comma-scored match
  // ─────────────────────────────────────────────────────────────────────────
  try {
    if (hasComma && tokens.length > 1) {
      // ── Comma query — score by token-coverage, enforce majority threshold ──
      //
      // Strategy:
      //   1. Run a single OR query to pull every doc that contains ANY token.
      //      This is one DB round-trip (cheap).
      //   2. Count how many tokens each candidate actually contains (in-memory).
      //   3. Require at least ceil(tokens.length / 2) tokens to be present
      //      (majority threshold).  A doc matching only 1 out of 4 tokens is
      //      too loosely related — SKIP it entirely.
      //   4. Score proportionally: all tokens = 0.90, majority = 0.70–0.89.
      //   5. matchReason = 'comma-and'  when ALL tokens matched,
      //                  = 'comma-partial' when a majority (but not all) matched.
      //
      // This replaces the old AND-pass + unrestricted-OR-pass approach which
      // returned unrelated docs that happened to contain just one search token.

      const minRequired = Math.ceil(tokens.length / 2); // majority gate

      // One OR query — pull ALL candidates that contain at least one token
      const candidateDocs = await queryPartial(provider, tokens, exactIds, Infinity, false);

      for (const doc of candidateDocs) {
        const hits = countTokenHits(doc, allFields, tokens);

        // Hard gate — below majority, not relevant enough to show
        if (hits < minRequired) continue;

        const score  = commaScore(hits, tokens.length);
        const reason = hits >= tokens.length ? 'comma-and' : 'comma-partial';
        const [formatted] = formatResults(key, [doc], reason, score, requestedFields);
        results.push(formatted);
      }

    } else {
      // ── Single token — standard contains partial ──
      const partialDocs = await queryPartial(provider, tokens, exactIds, Infinity, false);
      results.push(...formatResults(key, partialDocs, 'partial', PARTIAL_SCORE, requestedFields));
    }
  } catch (err) {
    console.warn(`[SuperSearch] partial query failed for "${key}":`, err.message);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STAGE 3 — Fuzzy (always runs — catches typos not found by exact/partial)
  // ─────────────────────────────────────────────────────────────────────────
  const seenIds = results.map(r => String(r.id));
  try {
    const fuzzyHits = await queryFuzzy(provider, tokens, seenIds, FUZZY_CANDIDATE);
    for (const { doc, fuzzyScore } of fuzzyHits) {
      const [formatted] = formatResults(key, [doc], 'fuzzy', FUZZY_BASE + fuzzyScore * FUZZY_RANGE, requestedFields);
      results.push(formatted);
    }
  } catch (err) {
    console.warn(`[SuperSearch] fuzzy query failed for "${key}":`, err.message);
  }

  return results;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Main search entry point.
 *
 * @param {object} params
 * @param {string}   params.q               – raw query string (required)
 * @param {string}   [params.source="all"]  – provider key or "all"
 * @param {number}   [params.page=1]
 * @param {number}   [params.limit=20]
 * @param {string[]} [params.fields]        – restrict returned fields
 * @returns {Promise<{results:object[], meta:object}>}
 */
async function search({ q, source = 'all', page = 1, limit = DEFAULT_LIMIT, fields }) {
  // ── Input validation ──
  if (!q || typeof q !== 'string' || !q.trim()) {
    const err = new Error('Query parameter "q" is required and must be a non-empty string.');
    err.code  = 'MISSING_QUERY';
    err.status = 400;
    throw err;
  }

  const normalizedQ = normalizeQuery(q);
  const tokens      = splitCommaQuery(normalizedQ);
  const hasComma    = q.includes(',');

  const clampedLimit = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const clampedPage  = Math.max(parseInt(page, 10000) || 1, 1);
  // NO per-provider cap — fetch ALL matches, paginate only at the final merge step.
  // This is the fix for totalMatched being truncated (e.g. 60 instead of 160).
  const providerLimit = Number.MAX_SAFE_INTEGER;

  // Determine which providers to query
  let providerKeys;
  if (source === 'all') {
    providerKeys = ALLOWED_SOURCES;
  } else {
    const key = source.toLowerCase();
    if (!PROVIDERS[key]) {
      const err = new Error(`Invalid source "${source}". Allowed: all, ${ALLOWED_SOURCES.join(', ')}.`);
      err.code   = 'INVALID_SOURCE';
      err.status = 400;
      throw err;
    }
    providerKeys = [key];
  }

  const requestedFields = (fields && fields.length) ? fields : null;

  // ── Run all providers in parallel ──
  const settled = await Promise.allSettled(
    providerKeys.map(key =>
      searchProvider(PROVIDERS[key].type === 'mongo' ? key : key,
                     PROVIDERS[key], tokens, hasComma, providerLimit, requestedFields)
    )
  );

  // ── Collect results + track failures ──
  let allResults   = [];
  const timedOut   = [];
  const warnings   = [];

  settled.forEach((outcome, idx) => {
    const key = providerKeys[idx];
    if (outcome.status === 'fulfilled') {
      allResults.push(...outcome.value);
    } else {
      timedOut.push(key);
      warnings.push(`Source "${key}" failed: ${outcome.reason?.message || 'unknown error'}`);
    }
  });

  // ── Deduplicate (same _id within same source) ──
  const seen = new Set();
  allResults = allResults.filter(r => {
    const key = `${r.source}:${String(r.id)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // ── Sort: strict tier order first, then score descending within each tier ──
  // This guarantees: all exact results → all partial results → all fuzzy results,
  // regardless of the raw float score value.
  // ── Sort: tier rank first, then score descending within each tier ──────────
  // Tier order: exact → comma-and (all tokens) → comma-partial (majority) →
  //             partial (single-token) → fuzzy
  // Within a tier, higher score (= better token coverage) comes first.
  const MATCH_RANK = {
    'exact':         0,  // full field value match
    'comma-and':     1,  // all tokens found — highest comma tier
    'comma-partial': 2,  // majority of tokens found (scored proportionally)
    'partial':       3,  // single-token contains match
    'fuzzy':         4,  // typo / spelling variant
  };
  allResults.sort((a, b) => {
    const rankA = MATCH_RANK[a.matchReason] ?? 99;
    const rankB = MATCH_RANK[b.matchReason] ?? 99;
    if (rankA !== rankB) return rankA - rankB;  // tier order first
    return b.score - a.score;                   // higher coverage score first within tier
  });

  // ── Paginate ──
  const total      = allResults.length;
  const startIdx   = (clampedPage - 1) * clampedLimit;
  const paginated  = allResults.slice(startIdx, startIdx + clampedLimit);

  return {
    results: paginated,
    meta: {
      totalReturned:  paginated.length,
      totalMatched:   total,
      page:           clampedPage,
      limit:          clampedLimit,
      timedOutSources: timedOut,
      warnings,
    },
  };
}

module.exports = {
  search,
  ALLOWED_SOURCES,
  PROVIDERS, // exported so callers can inspect the registry
};

// ─── Index Definitions ────────────────────────────────────────────────────────
/**
 * Add these index calls inside each respective model file, BEFORE
 * `module.exports = mongoose.model(...)`.  They are idempotent.
 *
 * ── DefraData.js ──────────────────────────────────────────────────────────────
 * DefraDataSchema.index(
 *   { level1: 'text', level2: 'text', level3: 'text', level4: 'text',
 *     columnText: 'text', scope: 'text', uom: 'text', ghgUnit: 'text' },
 *   { name: 'defra_text_search', weights: { level1: 10, level2: 8, level3: 6, level4: 4, columnText: 5 } }
 * );
 * // Fast prefix / partial
 * DefraDataSchema.index({ level1: 1, level2: 1, level3: 1 });
 *
 * ── EPAData.js ────────────────────────────────────────────────────────────────
 * EPADataSchema.index(
 *   { level1EPA: 'text', level2EPA: 'text', level3EPA: 'text', level4EPA: 'text',
 *     columnTextEPA: 'text', scopeEPA: 'text', uomEPA: 'text', ghgUnitEPA: 'text' },
 *   { name: 'epa_text_search', weights: { level1EPA: 10, level2EPA: 8, level3EPA: 6 } }
 * );
 * EPADataSchema.index({ level1EPA: 1, level2EPA: 1, level3EPA: 1 });
 *
 * ── IPCCData.js ───────────────────────────────────────────────────────────────
 * IPCCDataSchema.index(
 *   { level1: 'text', level2: 'text', level3: 'text', Description: 'text',
 *     TypeOfParameter: 'text', TechnologiesOrPractices: 'text', Unit: 'text', DataProvider: 'text' },
 *   { name: 'ipcc_text_search', weights: { level1: 10, level2: 8, level3: 6, Description: 7 } }
 * );
 * IPCCDataSchema.index({ level1: 1, level2: 1, level3: 1 });
 * IPCCDataSchema.index({ isActive: 1 });
 *
 * ── countryEmissionFactorModel.js ─────────────────────────────────────────────
 * CountryEmissionFactorSchema.index(
 *   { country: 'text', regionGrid: 'text', emissionFactor: 'text', reference: 'text' },
 *   { name: 'country_text_search', weights: { country: 10, regionGrid: 8, emissionFactor: 6 } }
 * );
 * CountryEmissionFactorSchema.index({ country: 1, regionGrid: 1 });
 *
 * ── Mongo shell commands (run once, non-blocking) ─────────────────────────────
 * db.defradatas.createIndex({ level1:'text', level2:'text', level3:'text', level4:'text', columnText:'text', scope:'text', uom:'text', ghgUnit:'text' }, { name:'defra_text_search', weights:{ level1:10, level2:8, level3:6 }, background:true });
 * db.epadata.createIndex({ level1EPA:'text', level2EPA:'text', level3EPA:'text', level4EPA:'text', columnTextEPA:'text', scopeEPA:'text', uomEPA:'text', ghgUnitEPA:'text' }, { name:'epa_text_search', weights:{ level1EPA:10, level2EPA:8, level3EPA:6 }, background:true });
 * db.ipccdatas.createIndex({ level1:'text', level2:'text', level3:'text', Description:'text', TypeOfParameter:'text', TechnologiesOrPractices:'text', Unit:'text', DataProvider:'text' }, { name:'ipcc_text_search', weights:{ level1:10, level2:8, level3:6 }, background:true });
 * db.countryemissionfactors.createIndex({ country:'text', regionGrid:'text', emissionFactor:'text', reference:'text' }, { name:'country_text_search', weights:{ country:10, regionGrid:8 }, background:true });
 */