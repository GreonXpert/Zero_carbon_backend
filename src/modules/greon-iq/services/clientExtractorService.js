'use strict';

// ============================================================================
// clientExtractorService.js
//
// IMPORTANT: companyName is stored at leadInfo.companyName on the Client
// document, NOT at the root level. Every DB query in this file projects
// 'leadInfo.companyName' and reads via c.leadInfo?.companyName.
//
// extractClientFromQuestion — used by multi-client roles to auto-resolve
//   which client the user means from their message text.
//   Receives a pre-fetched accessibleClients list — no DB queries.
//
// extractClientFromDB       — searches ALL clients in the DB.
//   Used by super_admin (auto-resolve any client) and to detect unassigned
//   client mentions for consultant/consultant_admin.
//
// detectCrossClientAttempt  — used by single-client roles (client_admin etc.)
//   to block queries that reference a company other than their own.
// ============================================================================

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Helper: normalise a raw Client document to { clientId, companyName }
function _entry(doc) {
  return {
    clientId:    doc.clientId,
    companyName: doc.leadInfo?.companyName || doc.clientId,
  };
}

const STOP_WORDS = new Set([
  // Action / question words
  'show','give','get','tell','list','view','find','fetch','please',
  // Conjunctions / prepositions / articles
  'for','the','and','our','my','all','can','you','this','that','what',
  'how','who','when','where','which','with','from','into','about','by',
  'or','not','an','a','of','at','in','on','to','up','do','if',
  // Pronouns — the key missing group that caused "give me the" false positive
  'me','us','it','he','she','we','they','him','her','them','i',
  // Auxiliary verbs
  'is','are','was','were','be','been','am','has','have','had',
  'will','would','could','should','may','might','must','shall',
  // Domain noise — these alone are never a company name
  'data','client','company','report','summary','emissions','scope','esg',
  'carbon','emission','boundary','metric','metrics','reduction',
  'decarbonization','entry','entries','analysis','overview','total',
  'breakdown','trend','its','their',
]);

// Articles to strip from the start of a captured company phrase
const ARTICLE_PREFIX = /^(?:the|a|an)\s+/i;

// Patterns that introduce a company name in natural English.
// Group 1 captures the raw company phrase (article stripped later).
const COMPANY_PATTERNS = [
  /\b(?:of|for|about)\s+((?:the\s+|a\s+|an\s+)?[A-Za-z][A-Za-z0-9\s&.,'-]{1,60}?)(?:\s+(?:data|emissions?|emission\s+summary|esg|report|summary|info)|\s*$|[,.])/i,
  /\b((?:the\s+|a\s+|an\s+)?[A-Za-z][A-Za-z0-9\s&.,'-]{1,60}?)\s+(?:data|emissions?|emission\s+summary|esg|report|summary)\b/i,
  /\b(?:summary|report)\s+of\s+((?:the\s+|a\s+|an\s+)?[A-Za-z][A-Za-z0-9\s&.,'-]{1,60}?)(?:\s*$|[,.]|\s+(?:data|emissions?))/i,
];

// ── Shared DB projection ──────────────────────────────────────────────────────
const CLIENT_PROJECTION = { clientId: 1, 'leadInfo.companyName': 1 };

/**
 * Try to extract a client reference from the user's question using a
 * pre-fetched list of accessible clients (no DB calls here).
 *
 * @param {string} question
 * @param {Array<{ clientId: string, companyName: string }>} accessibleClients
 * @returns {{ clientId: string, companyName: string, matchedBy: string }|null}
 */
function extractClientFromQuestion(question, accessibleClients) {
  if (!question || !Array.isArray(accessibleClients) || accessibleClients.length === 0) {
    return null;
  }

  // Strategy 1: clientId exact word-boundary match
  for (const client of accessibleClients) {
    if (!client.clientId) continue;
    const pattern = new RegExp(`\\b${escapeRegex(client.clientId)}\\b`, 'i');
    if (pattern.test(question)) {
      return { clientId: client.clientId, companyName: client.companyName || client.clientId, matchedBy: 'clientId' };
    }
  }

  // Strategy 2: companyName substring match — longest name wins
  const byLength = [...accessibleClients]
    .filter((c) => c.companyName && c.companyName.length >= 3)
    .sort((a, b) => b.companyName.length - a.companyName.length);

  const qLower = question.toLowerCase();
  for (const client of byLength) {
    if (qLower.includes(client.companyName.toLowerCase())) {
      return { clientId: client.clientId, companyName: client.companyName, matchedBy: 'companyName' };
    }
  }

  return null;
}

/**
 * Search the ENTIRE Client collection for a company/clientId mentioned in
 * the question.
 *
 * Used by:
 *  • super_admin   — auto-resolve any client without a selection prompt
 *  • consultant*   — detect mentions of clients they may not be assigned to
 *
 * @param {string} question
 * @returns {Promise<{ clientId: string, companyName: string }|null>}
 */
async function extractClientFromDB(question) {
  if (!question) return null;

  const Client = require('../../client-management/client/Client');
  const qLower = question.toLowerCase();

  const rawTokens = question.match(/\b[A-Za-z][A-Za-z0-9_-]{2,19}\b/g) || [];
  const candidateTokens = [...new Set(rawTokens.filter((t) => !STOP_WORDS.has(t.toLowerCase())))];

  // ── clientId exact token match ────────────────────────────────────────────
  if (candidateTokens.length > 0) {
    try {
      const byId = await Client.findOne(
        { clientId: { $in: candidateTokens }, isDeleted: { $ne: true } },
        CLIENT_PROJECTION
      ).lean();
      if (byId) return _entry(byId);
    } catch (_) {}
  }

  // ── companyName DB search (leadInfo.companyName) ──────────────────────────
  if (candidateTokens.length > 0) {
    try {
      const regexStr = candidateTokens.map(escapeRegex).join('|');
      const results  = await Client.find(
        { 'leadInfo.companyName': { $regex: regexStr, $options: 'i' }, isDeleted: { $ne: true } },
        CLIENT_PROJECTION
      ).limit(20).lean();

      const entries = results.map(_entry);
      const sorted  = entries.sort((a, b) => b.companyName.length - a.companyName.length);

      for (const e of sorted) {
        if (e.companyName && qLower.includes(e.companyName.toLowerCase())) return e;
      }
      for (const e of sorted) {
        const words = e.companyName.split(/\s+/);
        for (const w of words) {
          if (w.length >= 5 && candidateTokens.some((t) => t.toLowerCase() === w.toLowerCase())) return e;
        }
      }
    } catch (_) {}
  }

  // ── Pattern-based extraction ──────────────────────────────────────────────
  for (const pattern of COMPANY_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    let m;
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(question)) !== null) {
      if (!m[1]) continue;
      const raw      = m[1].trim().replace(ARTICLE_PREFIX, '').trim();
      const rawWords = raw.split(/\s+/);
      // A valid company name candidate must:
      //   a) have at least 3 characters total
      //   b) contain at least one word that is not a stop-word AND has length >= 3
      //      ("give me the" fails this: "give"→stop, "me"→length<3, "the"→stop)
      const hasSubstantiveWord = rawWords.some(w => w.length >= 3 && !STOP_WORDS.has(w.toLowerCase()));
      if (raw.length < 3 || !hasSubstantiveWord) continue;

      try {
        const dbClient = await Client.findOne(
          { 'leadInfo.companyName': { $regex: escapeRegex(raw), $options: 'i' }, isDeleted: { $ne: true } },
          CLIENT_PROJECTION
        ).lean();
        if (dbClient) return _entry(dbClient);
      } catch (_) {}
    }
  }

  return null;
}

/**
 * Detect whether a single-client role's message refers to a DIFFERENT company.
 *
 * @param {string} question
 * @param {string} ownClientId
 * @param {string} [ownCompanyName]
 * @returns {Promise<{ clientId: string, companyName: string, notInSystem?: boolean }|null>}
 */
async function detectCrossClientAttempt(question, ownClientId, ownCompanyName) {
  if (!question || !ownClientId) return null;

  const Client = require('../../client-management/client/Client');

  // Ensure we have the user's own company name (fallback: DB lookup)
  let ownName = (ownCompanyName || '').trim();
  if (!ownName) {
    try {
      const ownDoc = await Client.findOne(
        { clientId: String(ownClientId), isDeleted: { $ne: true } },
        { 'leadInfo.companyName': 1 }
      ).lean();
      ownName = ownDoc?.leadInfo?.companyName || '';
    } catch (_) {}
  }

  const ownLower = ownName.toLowerCase();
  const qLower   = question.toLowerCase();

  const rawTokens = question.match(/\b[A-Za-z][A-Za-z0-9_-]{2,19}\b/g) || [];
  const candidateTokens = [...new Set(
    rawTokens.filter((t) => {
      const tl = t.toLowerCase();
      if (STOP_WORDS.has(tl)) return false;
      if (tl === String(ownClientId).toLowerCase()) return false;
      if (ownName) {
        if (ownLower.split(/\s+/).includes(tl)) return false;
      }
      return true;
    })
  )];

  // ── Strategy 1: clientId exact token match ────────────────────────────────
  if (candidateTokens.length > 0) {
    try {
      const byId = await Client.findOne(
        {
          $and: [
            { clientId: { $in: candidateTokens } },
            { clientId: { $ne: String(ownClientId) } },
            { isDeleted: { $ne: true } },
          ],
        },
        CLIENT_PROJECTION
      ).lean();
      if (byId) return _entry(byId);
    } catch (err) {
      console.error('[GreOnIQ] detectCrossClient strategy1 error:', err.message);
    }
  }

  // ── Strategy 2: companyName DB search (leadInfo.companyName) ─────────────
  if (candidateTokens.length > 0) {
    try {
      const regexStr = candidateTokens.map(escapeRegex).join('|');
      const found = await Client.find(
        { 'leadInfo.companyName': { $regex: regexStr, $options: 'i' }, isDeleted: { $ne: true } },
        CLIENT_PROJECTION
      ).limit(20).lean();

      const others = found
        .map(_entry)
        .filter((e) => e.clientId.toLowerCase() !== String(ownClientId).toLowerCase());

      if (others.length > 0) {
        const sorted = others.sort((a, b) => b.companyName.length - a.companyName.length);

        for (const e of sorted) {
          if (e.companyName && qLower.includes(e.companyName.toLowerCase())) return e;
        }
        for (const e of sorted) {
          const words = e.companyName.split(/\s+/);
          for (const w of words) {
            if (w.length >= 5 && candidateTokens.some((t) => t.toLowerCase() === w.toLowerCase())) return e;
          }
        }
      }
    } catch (err) {
      console.error('[GreOnIQ] detectCrossClient strategy2 error:', err.message);
    }
  }

  // ── Strategy 3: pattern-based extraction ─────────────────────────────────
  for (const pattern of COMPANY_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    let m;
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(question)) !== null) {
      if (!m[1]) continue;

      const raw      = m[1].trim().replace(ARTICLE_PREFIX, '').trim();
      const rawLower = raw.toLowerCase();
      const rawWords = raw.split(/\s+/);

      if (raw.length < 3) continue;
      // Require at least one substantive word (non-stop, length >= 3)
      // This prevents "give me the" (all stop/short words) from being treated
      // as a company name and triggering a false Access Restricted block.
      const hasSubstantiveWord = rawWords.some(w => w.length >= 3 && !STOP_WORDS.has(w.toLowerCase()));
      if (!hasSubstantiveWord) continue;

      // Skip if it matches the user's own company
      if (ownLower && (rawLower === ownLower || ownLower.includes(rawLower) || rawLower.includes(ownLower))) {
        continue;
      }

      try {
        const dbClient = await Client.findOne(
          {
            'leadInfo.companyName': { $regex: escapeRegex(raw), $options: 'i' },
            clientId: { $ne: String(ownClientId) },
            isDeleted: { $ne: true },
          },
          CLIENT_PROJECTION
        ).lean();

        return dbClient
          ? _entry(dbClient)
          : { clientId: 'EXTERNAL', companyName: raw, notInSystem: true };
      } catch (_) {
        return { clientId: 'EXTERNAL', companyName: raw, notInSystem: true };
      }
    }
  }

  return null;
}

module.exports = { extractClientFromQuestion, extractClientFromDB, detectCrossClientAttempt };
