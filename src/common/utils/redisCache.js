// src/common/utils/redisCache.js
// Redis wrapper using ioredis — gracefully degrades if Redis is unavailable.
// ioredis is already installed as a transitive dependency of bull.

'use strict';

const IORedis = require('ioredis');

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

// commandTimeout: any get/set that does not complete in 200 ms rejects and
// falls through to MongoDB — prevents the 2-second hangs caused by the
// redis-v3 retry queue under Windows TCP reconnects.
//
// enableOfflineQueue: false — when disconnected, commands fail immediately
// instead of queuing, so cache misses are instant (< 1 ms) rather than
// waiting up to RETRY_DELAY × MAX_ATTEMPTS seconds.
const client = new IORedis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  lazyConnect:          false,
  connectTimeout:       2000,
  commandTimeout:       200,
  maxRetriesPerRequest: 0,
  enableOfflineQueue:   false,
  retryStrategy(times) {
    if (times > 20) return null; // stop retrying after ~37 s total
    return Math.min(times * 200, 2000); // 200 ms → 400 ms → … → 2 s
  },
});

client.on('connect',     () => console.log(`[RedisCache] Connected to ${REDIS_HOST}:${REDIS_PORT}`));
client.on('reconnecting',() => console.log('[RedisCache] Reconnecting...'));
client.on('error',       (err) => {
  if (!['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(err.code)) {
    console.warn('[RedisCache] error:', err.message);
  }
});

async function get(key) {
  try {
    const raw = await client.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // Redis down, timeout, or parse error → fall through to DB
  }
}

// Returns the raw JSON string — controllers can call res.end(raw) directly,
// skipping JSON.parse + JSON.stringify (saves 4–16 ms per cached response).
async function getRaw(key) {
  try {
    return await client.get(key); // string | null
  } catch {
    return null;
  }
}

async function set(key, value, ttlSeconds) {
  try {
    await client.setex(key, ttlSeconds, JSON.stringify(value));
  } catch {
    // Missing a cache write is never fatal — silent fail
  }
}

async function del(key) {
  try {
    await client.del(key);
  } catch {}
}

async function delPattern(pattern) {
  try {
    const keys = await client.keys(pattern);
    if (keys && keys.length > 0) {
      await client.del(...keys);
      console.log(`[RedisCache] delPattern(${pattern}): evicted ${keys.length} key(s)`);
    }
  } catch {}
}

// ── Cache key builders ────────────────────────────────────────────────────────
// These are pure string functions — no Redis I/O.

function emissionSummaryKey(clientId, periodType, y, m, w, d, summaryType = 'both') {
  let base;
  switch (periodType) {
    case 'daily':    base = `emission_summary:${clientId}:daily:${y}:${m}:0:${d}`;    break;
    case 'weekly':   base = `emission_summary:${clientId}:weekly:${y}:0:${w}:0`;      break;
    case 'monthly':  base = `emission_summary:${clientId}:monthly:${y}:${m}:0:0`;     break;
    case 'yearly':   base = `emission_summary:${clientId}:yearly:${y}:0:0:0`;          break;
    case 'all-time': base = `emission_summary:${clientId}:all-time:0:0:0:0`;           break;
    default:         base = `emission_summary:${clientId}:${periodType}:${y}:${m}:${w}:${d}`;
  }
  return `${base}:${summaryType}`;
}

function emissionSummaryTTL(year) {
  const currentYear = new Date().getFullYear();
  return year < currentYear ? 86400 : 600;
}

function multipleSummariesKey(clientId, periodType, startYear, endYear, startMonth, endMonth, limit, summaryType) {
  return `multi_summary:${clientId}:${periodType}:${startYear || 0}:${endYear || 0}:${startMonth || 0}:${endMonth || 0}:${limit}:${summaryType || 'both'}`;
}

function filteredSummaryKey(clientId, periodType, year, month, scope, category, nodeId, department, summaryKind, sortBy, sortDirection) {
  const parts = [
    clientId, periodType,
    year || 0, month || 0,
    scope || '', category || '', nodeId || '', department || '',
    summaryKind || '', sortBy || '', sortDirection || '',
  ];
  return `filtered_summary:${parts.join(':')}`;
}

function topLowKey(clientId, periodType, year, month, limit) {
  return `toplow_summary:${clientId}:${periodType}:${year || 0}:${month || 0}:${limit || 5}`;
}

function hierarchyKey(clientId, periodType, year, month, location, department, scopeType) {
  return `hierarchy_summary:${clientId}:${periodType}:${year || 0}:${month || 0}:${location || ''}:${department || ''}:${scopeType || ''}`;
}

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

module.exports = {
  get,
  getRaw,
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
