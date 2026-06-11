// src/common/utils/redisCache.js
// Thin Redis wrapper — gracefully degrades if Redis is unavailable.
// Used by getEmissionSummary to serve hot responses from memory.

'use strict';

const redis = require('redis');
const { promisify } = require('util');

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS     = 2000;

let client = null;
let getAsync = null;
let setexAsync = null;
let delAsync = null;
let connected = false;
let unavailable = false; // set after MAX_RETRY_ATTEMPTS — stops further noise

function connect() {
  if (client) return;

  client = redis.createClient({
    host: REDIS_HOST,
    port: REDIS_PORT,
    retry_strategy(options) {
      if (options.attempt >= MAX_RETRY_ATTEMPTS) {
        // Give up silently — app continues without cache
        unavailable = true;
        console.warn(
          `[RedisCache] Unavailable after ${MAX_RETRY_ATTEMPTS} attempts. ` +
          `Running without cache — start Redis to enable it.`
        );
        return undefined; // stops retrying
      }
      return RETRY_DELAY_MS;
    }
  });

  client.on('connect', () => {
    connected = true;
    unavailable = false;
    console.log(`[RedisCache] Connected to ${REDIS_HOST}:${REDIS_PORT}`);
  });

  client.on('error', () => {
    // Suppress per-error noise — retry_strategy already reports final failure
    connected = false;
  });

  getAsync   = promisify(client.get).bind(client);
  setexAsync = promisify(client.setex).bind(client);
  delAsync   = promisify(client.del).bind(client);
}

async function get(key) {
  if (unavailable || !connected || !getAsync) return null;
  try {
    const raw = await getAsync(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn('[RedisCache] get error:', e.message);
    return null;
  }
}

async function set(key, value, ttlSeconds) {
  if (unavailable || !connected || !setexAsync) return;
  try {
    await setexAsync(key, ttlSeconds, JSON.stringify(value));
  } catch (e) {
    console.warn('[RedisCache] set error:', e.message);
  }
}

async function del(key) {
  if (unavailable || !connected || !delAsync) return;
  try {
    await delAsync(key);
  } catch (e) {
    console.warn('[RedisCache] del error:', e.message);
  }
}

// BUG 9/10/11 FIX: Wildcard delete for cache invalidation.
// Uses client.keys() (safe for small key counts; upgrade to SCAN for large datasets).
async function delPattern(pattern) {
  if (unavailable || !connected || !client) return;
  try {
    const keys = await new Promise((resolve, reject) => {
      client.keys(pattern, (err, k) => (err ? reject(err) : resolve(k)));
    });
    if (keys && keys.length > 0) {
      await Promise.all(keys.map(k => delAsync(k)));
      console.log(`[RedisCache] delPattern(${pattern}): evicted ${keys.length} key(s)`);
    }
  } catch (e) {
    console.warn('[RedisCache] delPattern error:', e.message);
  }
}

// Build a canonical cache key for an emission summary request.
//
// Keys are PERIOD-TYPE-AWARE: only the parts that are meaningful for a given
// period type are included.  Irrelevant parts are normalised to 0 so that:
//   - "GET …?periodType=yearly&year=2026" always produces the SAME key,
//     regardless of the current month/week/day (which getEmissionSummary
//     fills in as defaults but are irrelevant for a yearly period).
//   - saveEmissionSummary's cache-invalidation call produces the SAME key
//     even though normalizedPeriod.month/week/day are undefined for yearly/all-time.
//
// BUG 4 FIX: summaryType (emission|reduction|both|process) is now the last segment.
// All four type variants produce distinct keys so they can't overwrite each other.
//
// Key format (0 = not applicable for this period type):
//   emission_summary:<clientId>:<periodType>:<year>:<month>:<week>:<day>:<summaryType>
function emissionSummaryKey(clientId, periodType, y, m, w, d, summaryType = 'both') {
  let base;
  switch (periodType) {
    case 'daily':
      base = `emission_summary:${clientId}:daily:${y}:${m}:0:${d}`;
      break;
    case 'weekly':
      base = `emission_summary:${clientId}:weekly:${y}:0:${w}:0`;
      break;
    case 'monthly':
      base = `emission_summary:${clientId}:monthly:${y}:${m}:0:0`;
      break;
    case 'yearly':
      base = `emission_summary:${clientId}:yearly:${y}:0:0:0`;
      break;
    case 'all-time':
      base = `emission_summary:${clientId}:all-time:0:0:0:0`;
      break;
    default:
      base = `emission_summary:${clientId}:${periodType}:${y}:${m}:${w}:${d}`;
  }
  return `${base}:${summaryType}`;
}

// Choose TTL: 24 h for past years, 10 min for the current period.
function emissionSummaryTTL(year) {
  const currentYear = new Date().getFullYear();
  return year < currentYear ? 86400 : 600;
}

// ── Cache keys for BUG 9/10 — summary list and filter endpoints ───────────────

function multipleSummariesKey(clientId, periodType, startYear, endYear, startMonth, endMonth, limit, summaryType) {
  return `multi_summary:${clientId}:${periodType}:${startYear || 0}:${endYear || 0}:${startMonth || 0}:${endMonth || 0}:${limit}:${summaryType || 'both'}`;
}

function filteredSummaryKey(clientId, periodType, year, month, scope, category, nodeId, department, summaryKind, sortBy, sortDirection) {
  const parts = [
    clientId, periodType,
    year || 0, month || 0,
    scope || '', category || '', nodeId || '', department || '',
    summaryKind || '', sortBy || '', sortDirection || ''
  ];
  return `filtered_summary:${parts.join(':')}`;
}

function topLowKey(clientId, periodType, year, month, limit) {
  return `toplow_summary:${clientId}:${periodType}:${year || 0}:${month || 0}:${limit || 5}`;
}

function hierarchyKey(clientId, periodType, year, month, location, department, scopeType) {
  return `hierarchy_summary:${clientId}:${periodType}:${year || 0}:${month || 0}:${location || ''}:${department || ''}:${scopeType || ''}`;
}

// ── Cache keys for BUG 11 — reduction dashboard endpoints ────────────────────

function reductionTrendKey(clientId, projectId, period) {
  return `reduction_trend:${clientId}:${projectId || 'all'}:${period || 'all'}`;
}

function reductionMechanismKey(clientId, projectId) {
  return `reduction_mechanism:${clientId}:${projectId || 'all'}`;
}

function reductionTopSourcesKey(clientId, projectId, limit) {
  return `reduction_topsources:${clientId}:${projectId || 'all'}:${limit || 10}`;
}

function reductionCatPriorityKey(clientId, projectId) {
  return `reduction_catpriority:${clientId}:${projectId || 'all'}`;
}

connect();

module.exports = {
  get,
  set,
  del,
  delPattern,
  emissionSummaryKey,
  emissionSummaryTTL,
  multipleSummariesKey,
  filteredSummaryKey,
  topLowKey,
  hierarchyKey,
  reductionTrendKey,
  reductionMechanismKey,
  reductionTopSourcesKey,
  reductionCatPriorityKey,
};
