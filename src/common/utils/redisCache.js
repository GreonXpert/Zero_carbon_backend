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

// Build a canonical cache key for an emission summary request.
//
// Keys are PERIOD-TYPE-AWARE: only the parts that are meaningful for a given
// period type are included.  Irrelevant parts are normalised to 0 so that:
//   - "GET …?periodType=yearly&year=2026" always produces the SAME key,
//     regardless of the current month/week/day (which getEmissionSummary
//     fills in as defaults but are irrelevant for a yearly period).
//   - saveEmissionSummary's cache-invalidation call (Fix 1) produces the
//     SAME key even though normalizedPeriod.month/week/day are undefined for
//     yearly/all-time periods.
//
// Key format (0 = not applicable for this period type):
//   emission_summary:<clientId>:<periodType>:<year>:<month>:<week>:<day>
function emissionSummaryKey(clientId, periodType, y, m, w, d) {
  switch (periodType) {
    case 'daily':
      // year + month + day; week is irrelevant
      return `emission_summary:${clientId}:daily:${y}:${m}:0:${d}`;
    case 'weekly':
      // year + week; month and day are irrelevant
      return `emission_summary:${clientId}:weekly:${y}:0:${w}:0`;
    case 'monthly':
      // year + month; week and day are irrelevant
      return `emission_summary:${clientId}:monthly:${y}:${m}:0:0`;
    case 'yearly':
      // year only; month, week, and day are irrelevant
      return `emission_summary:${clientId}:yearly:${y}:0:0:0`;
    case 'all-time':
      // no date parts
      return `emission_summary:${clientId}:all-time:0:0:0:0`;
    default:
      // Fallback: include everything (future-proof for unknown period types)
      return `emission_summary:${clientId}:${periodType}:${y}:${m}:${w}:${d}`;
  }
}

// Choose TTL: 24 h for past years, 10 min for the current period.
function emissionSummaryTTL(year) {
  const currentYear = new Date().getFullYear();
  return year < currentYear ? 86400 : 600;
}

connect();

module.exports = { get, set, del, emissionSummaryKey, emissionSummaryTTL };
