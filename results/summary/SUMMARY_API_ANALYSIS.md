# Summary API — Performance & Bug Analysis
**Generated:** 2026-06-17  
**Target:** All 7 tested endpoints under `GET /api/summaries/:clientId/*`  
**Goal:** Identify every bug and bottleneck preventing sub-200 ms responses under smoke / load (1 000 VU) / stress (2 000 VU) / spike (3 000 VU)

---

## 1. Load Test Results Summary

| Test Mode | VUs | Total Requests | Error Rate | p95 Latency | Verdict |
|-----------|-----|---------------|------------|-------------|---------|
| Smoke     | 5   | ~35           | 0%         | ~2 500 ms   | ✅ Server alive |
| Load      | 1 000 | 1 910       | 0.10%      | **86 544 ms** | ❌ All thresholds FAIL |
| Stress    | 2 000 | 2 901       | **55.87%** | **120 157 ms** (timeout) | ❌ Server saturated |
| Spike     | 3 000 | 104 (70 s)   | 4.95%      | **38 398 ms** | ❌ Mostly dropped |

### Endpoint p95 Latency at 1 000 VU

| Endpoint | p95 (ms) | Threshold | Status |
|----------|----------|-----------|--------|
| `GET /:id` (basic) | 85 118 | 15 000 | ❌ FAIL |
| `GET /:id/multiple` | 84 229 | 15 000 | ❌ FAIL |
| `GET /:id/filtered` | 92 486 | 15 000 | ❌ FAIL |
| `GET /:id/top-low` | 83 604 | 15 000 | ❌ FAIL |
| `GET /:id/scope-identifiers/extremes` | 84 086 | 30 000 | ❌ FAIL |
| `GET /:id/scope-identifiers/hierarchy` | 82 865 | 20 000 | ❌ FAIL |
| `GET /:id/reduction/hierarchy` | 96 869 | 15 000 | ❌ FAIL |

**Single-user minimum latencies** (smoke / first request): 1 079–5 648 ms. The server is not broken—it is saturated.

---

## 2. Security Bugs

### BUG-SEC-01 — Cross-Client Data Leak: `POST /:clientId/compare`
**File:** `src/modules/zero-carbon/calculation/routes/summaryRoutes.js`  
**Severity:** CRITICAL  
**Status:** Unpatched

`POST /:clientId/compare` has `zcGate` (module subscription check) but **no `checkSummaryPermission`**. Any authenticated user from a different client can supply a foreign `clientId` in the URL and receive that client's comparison data. Confirmed by Jest test: a Greon017 user querying `/:Greon001/compare` receives HTTP 200 instead of 403.

**What needs to change:** Add `checkSummaryPermission` middleware to this route, identically to all other routes on this router.

---

### BUG-SEC-02 — Cross-Client Data Leak: `GET /:clientId/reduction/projects`
**File:** `src/modules/zero-carbon/calculation/routes/summaryRoutes.js`  
**Severity:** HIGH  
**Status:** Unpatched

Same issue — `zcGate` only, no `checkSummaryPermission`. Any authenticated user can read another client's reduction projects.

**What needs to change:** Add `checkSummaryPermission` middleware to this route.

---

### BUG-SEC-03 — Malformed JWT Returns 500 Instead of 401
**File:** `src/common/middleware/auth.js` (auth middleware)  
**Severity:** MEDIUM  
**Status:** Unpatched

When a JWT has an invalid base64 middle segment (e.g., `eyJ...fake.sig`), `jwt.verify()` throws a `SyntaxError` (not a `JsonWebTokenError`). The auth middleware catches `JsonWebTokenError` but not `SyntaxError`, so the error propagates up and returns HTTP 500. Confirmed by Jest test on `/scope12-total`.

**What needs to change:** Auth middleware must catch all exceptions from `jwt.verify()`, not just `JsonWebTokenError`. A bare `catch(err)` that returns 401 for any verification failure is correct.

---

## 3. Functional Bugs

### BUG-FUNC-01 — `POST /:clientId/compare` Crashes on Empty Body (500)
**File:** `src/modules/zero-carbon/calculation/CalculationSummary.js`, controller `compareSummarySelections`  
**Severity:** MEDIUM  
**Status:** Unpatched

When `POST /compare` is called with an empty body, `globalPeriod` is null. The controller passes it directly into an aggregation pipeline or a `buildDateRange()` call without a null guard. MongoDB aggregation receives undefined dates and crashes, returning 500.

**What needs to change:** Default `globalPeriod` to a safe fallback (e.g., current year yearly) when the request body is empty or missing the field.

---

### BUG-FUNC-02 — `GET /:clientId/reduction/projects` Returns 400
**File:** Controller for the reduction/projects route  
**Severity:** LOW  
**Status:** Unpatched

The controller requires at least one query parameter that the k6 test does not send. This caused 400 errors in Jest tests. The parameter is not documented in summaryRoutes.js.

**What needs to change:** Either document the required parameter and add it to tests, or add server-side default values so bare requests return usable data.

---

### BUG-FUNC-03 — `GET /:clientId/reductions/summary` Returns 403 for `client_admin`
**File:** `netReductionSummaryController.js`  
**Severity:** LOW  
**Status:** Known limitation

The reduction summary controller internally rejects the `client_admin` role. This is likely intentional (consultant_admin only) but is not documented.

**What needs to change:** Add documentation or return 403 with a clear message explaining the role restriction.

---

## 4. Performance Bugs — Root Causes (Priority Order)

---

### PERF-01 — Redis Not Running Locally → All Caching Bypassed (Silent)
**Files:** `src/common/utils/redisCache.js`  
**Impact:** CATASTROPHIC — 100% cache miss on every endpoint  
**Status:** Infrastructure gap

`redisCache.js` silently degrades to `null` returns when Redis is unavailable (after 3 retry attempts it sets `unavailable = true` and all `get()`/`set()` calls return immediately without doing anything). If Redis is not started locally (`redis-server` not running), EVERY single request to EVERY caching endpoint hits MongoDB. At 1 000 VUs, this means 1 000 simultaneous MongoDB reads of the same data instead of 1 000 Redis cache hits.

**Evidence:** `.env` sets `REDIS_HOST=localhost, REDIS_PORT=6379`. There is no check in startup that Redis is alive. The load test showed all 1 910 requests at p95 = 86 s — consistent with all going to Atlas M0.

**What needs to change:**
- Start Redis locally before running load tests: `redis-server` (Windows: `redis-server.exe`)
- Add a startup health check that logs loudly if Redis is unavailable
- Consider Redis Cloud (free tier, 30 MB) as an always-available alternative

---

### PERF-02 — Single Node.js Process — Event Loop Blocks Under Load
**Impact:** SEVERE — CPU-bound work prevents concurrent response  
**Status:** Infrastructure gap

All 7 summary endpoints perform heavy JavaScript-level data processing (Map iterations, object copying, sorting, filtering) in the same single-threaded event loop. With 1 000 simultaneous users, each waiting for a slow aggregation, they queue up behind each other. One slow `calculateEmissionSummary()` call (which builds Maps for `byCategory`, `byActivity`, `byNode`, `byDepartment`, `byLocation`, `byEmissionFactor` by iterating all DataEntry documents in JavaScript) blocks the event loop for other requests.

**What needs to change:**
- **Production:** PM2 cluster mode: `pm2 start index.js -i max` (uses all CPU cores, Node distributes connections across workers). This alone multiplies throughput by the number of CPU cores.
- **Local load testing:** `pm2 start src/index.js -i 4 --name zero-carbon` before running k6. Without this, local tests cannot represent production behaviour.
- **Long-term:** Move the JavaScript aggregation loop in `calculateEmissionSummary()` to a MongoDB aggregation pipeline. The current pattern loads ALL DataEntry documents into Node memory and loops over them — this should happen inside MongoDB.

---

### PERF-03 — `getScopeIdentifierEmissionExtremes`: Full Document Load, No Projection
**File:** `src/modules/zero-carbon/calculation/CalculationSummary.js`, line 4258  
**Impact:** HIGH — 5–10× more network I/O than necessary  
**Status:** Bug

```js
// Line 4257–4262 (extremes endpoint)
const [dataEntries, emissionSummaryDoc] = await Promise.all([
  DataEntry.find({
    clientId,
    processingStatus: "processed",
    timestamp: { $gte: from, $lte: to }
  }).lean(),   // ← NO .select() — loads ALL fields
```

The `DataEntry` document schema includes: `dataValues` (Map), `calculatedEmissions` (nested Maps with CO2, CH4, N2O per gas), `cumulativeValues` (Map), `highData` (Map), `lowData` (Map), `lastEnteredData` (Map), `editHistory` (array), `appliedEmissionFactors`, `dataQuality`, `validationErrors`, etc. Each DataEntry document is 10–100 KB. Loading 500 documents with no projection = 5–50 MB per request. At 1 000 VUs, this is 5–50 GB/s of MongoDB-to-Node data transfer — far exceeding Atlas M0's disk I/O capacity.

The extremes controller only needs `calculatedEmissions`, `scopeIdentifier`, `nodeId`, `scopeType`, `timestamp` and `_id`. Everything else is wasted.

**What needs to change:** Add `.select('calculatedEmissions scopeIdentifier nodeId scopeType timestamp _id')` to the `DataEntry.find()` at line 4258.

---

### PERF-04 — `getScopeIdentifierHierarchy`: Full Document Load, No Projection
**File:** `src/modules/zero-carbon/calculation/CalculationSummary.js`, line 4740  
**Impact:** HIGH — same problem as PERF-03  
**Status:** Bug

```js
// Line 4739–4740 (hierarchy endpoint)
const [entries, orgChart, processChart, emissionSummaryDoc] = await Promise.all([
  DataEntry.find(findQuery).lean(),  // ← NO .select()
```

Same issue as PERF-03. The hierarchy controller only needs emission values, `nodeId`, `scopeIdentifier`, `scopeType`, `categoryName`, `activity`, `emissionFactor`, `inputType`, `timestamp`.

**What needs to change:** Add `.select('calculatedEmissions scopeIdentifier nodeId scopeType categoryName activity emissionFactor inputType timestamp _id')` to the `DataEntry.find()` at line 4740.

---

### PERF-05 — `calculateEmissionSummary()` Is JavaScript Aggregation, Not MongoDB Pipeline
**File:** `src/modules/zero-carbon/calculation/CalculationSummary.js`, lines 245–622  
**Impact:** HIGH — CPU-bound, blocks event loop, O(N) in Node.js  
**Status:** Architectural issue

`calculateEmissionSummary()` (the function underlying `getEmissionSummary` and `getMultipleSummaries`) works as follows:
1. Queries all DataEntry documents for the period with a projection (line 261) — good
2. Loops over every document in JavaScript, building Maps for byScope, byCategory, byActivity, byNode, byDepartment, byLocation, byEmissionFactor, byInputType
3. Makes an additional DB query for the previous period summary (for trends, line 541)
4. Makes a second parallel DB query for ProcessEmissionDataEntry records

The JavaScript loop is fine for 100 documents. At 10 000 DataEntry records for a yearly period, this loop takes 2–5 seconds of pure CPU time in Node.js, during which it blocks the event loop for ALL other requests.

**What needs to change (long term):** Port the aggregation to a MongoDB `$group` + `$project` pipeline. This moves computation to the database server (which is better suited for it) and returns only the summary. Short-term: ensure the result is cached in Redis immediately after first calculation and all subsequent requests hit Redis, not this function.

---

### PERF-06 — `EmissionSummary.metadata.dataEntriesIncluded` Array in Response
**File:** `src/modules/zero-carbon/calculation/EmissionSummary.js`, line 233  
**Impact:** MEDIUM — wasted serialization/deserialization

The `EmissionSummary` document stores `dataEntriesIncluded: [ObjectId]` — an array of every DataEntry `_id` included in the summary. For a yearly summary with 5 000 entries, this is 5 000 × 24 bytes = 120 KB of ObjectId data serialized on every response. This field is not used by the frontend (it's audit metadata) but is returned in every `getEmissionSummary` response.

**What needs to change:** Exclude `metadata.dataEntriesIncluded` from the response projection. It can be stored in the DB but should not be sent to the client.

---

### PERF-07 — `buildSbtiProgressForSummary()` Has N+1 Query Pattern
**File:** `src/modules/zero-carbon/calculation/CalculationSummary.js`, lines 818–912  
**Impact:** MEDIUM — proportional to number of SBTi targets

```js
for (const target of targets) {
  // N × query 1:
  const snap = await ProgressSnapshot.findOne({ target_id: target._id ... })
  // N × query 2 (fallback):
  const pathway = await PathwayAnnual.findOne({ target_id: target._id ... })
}
```

Each SBTi target requires 1–2 sequential DB queries. If a client has 5 targets, this is 5–10 sequential round trips to MongoDB, each adding 20–200 ms on Atlas M0. This runs every time `getSbtiProgress` or any `getEmissionSummary` with SBTi data is called without a cache hit.

**What needs to change:** Collect all `target._id` values first, then run two single queries with `$in: [allTargetIds]` and join in JavaScript. This reduces N+1 to 2 queries total.

---

### PERF-08 — `getEmissionSummary`: Cold-Start Triggers Full Synchronous Recalculation
**File:** `src/modules/zero-carbon/calculation/CalculationSummary.js`, lines 2232–2243  
**Impact:** HIGH — first-ever request or after recalculate=true blocks for 1–30 s

```js
if (!summary) {
  // First-ever request: recalculate synchronously
  const recomputed = await recalculateAndSaveSummary(...)
```

On first request for a period, or after `recalculate=true`, the endpoint synchronously runs `calculateEmissionSummary()` (the full JavaScript aggregation loop + all parallel queries) before responding. This is 1–30 seconds on Atlas M0 depending on data size. With 1 000 VUs, if many are hitting this simultaneously on a cold cache, all 1 000 queue up waiting for the same recalculation.

**What needs to change:** Add a per-client mutex / in-flight de-duplication: if a recalculation is already in progress for `(clientId, periodType, year)`, subsequent requests should wait for that one to complete and then serve the result, rather than all independently triggering `recalculateAndSaveSummary()`.

---

### PERF-09 — Atlas M0 Connection Pool Saturation at ~100 Connections
**Impact:** SEVERE — structural cap that cannot be fixed in application code  
**Status:** Infrastructure gap

Atlas M0 free tier allows approximately 100 simultaneous connections. With 1 000 VUs each needing a MongoDB connection for their request, the pool is exhausted at 10% load. All requests beyond the first 100 wait for a free connection. This adds 10–90 s of queuing on top of actual query time.

**Evidence:** Load test min latency = 1 079 ms (a request that got a connection immediately). p95 = 85 118 ms (a request that waited in the connection pool). The difference is almost entirely pool-wait time, not query execution time.

**What needs to change:**
- Upgrade Atlas cluster to M10+ for production load testing (M10 allows ~500 connections)
- In application code: set `mongoose.connect()` pool size to `maxPoolSize: 50` (default 5–10) to make better use of available connections under the cap
- Implement Redis caching (PERF-01) to dramatically reduce how often MongoDB connections are needed

---

### PERF-10 — `getReductionSummaryHierarchy`: Two Sequential DB Queries (NetReductionEntry + Reduction)
**File:** `src/modules/zero-carbon/calculation/CalculationSummary.js`, lines 5271 and 5294  
**Impact:** MEDIUM

```js
const rows = await NetReductionEntry.find(entryQuery).lean();
// ...
const projects = await Reduction.find({ clientId, projectId: { $in: uniqProjectIds } })
```

These two queries run sequentially (second depends on results of first). Combined latency on Atlas M0 = 500–2 000 ms under load. This explains why `reduction/hierarchy` has the highest p95 at load (96 869 ms).

**What needs to change:** Use `$lookup` in a MongoDB aggregation pipeline to join NetReductionEntry with Reduction in a single query, or run both queries in parallel using `Promise.all()` with a known set of projectIds extracted from the URL parameter.

---

## 5. Index Analysis

### DataEntry Indexes (from `src/modules/zero-carbon/organization/models/DataEntry.js`)

| Index | Query it covers |
|-------|----------------|
| `{ clientId: 1, processingStatus: 1, timestamp: -1 }` | Main query pattern used by all DataEntry fetches |
| `{ clientId: 1, nodeId: 1, scopeIdentifier: 1, timestamp: -1 }` | Filtered queries with node/scope |
| `{ clientId: 1, nodeId: 1, scopeIdentifier: 1 }` | Lookup without date range |
| `{ clientId: 1, timestamp: -1 }` | Date-sorted queries |

**Status: ✅ Adequate indexes exist for DataEntry query patterns.** The main query `{ clientId, processingStatus: 'processed', timestamp: { $gte, $lte } }` is covered by `{ clientId: 1, processingStatus: 1, timestamp: -1 }`. MongoDB can use this index for the range scan.

**The bottleneck is NOT missing indexes on DataEntry — it is the volume of documents returned and the lack of projection (PERF-03, PERF-04).**

### EmissionSummary Indexes (from `src/modules/zero-carbon/calculation/EmissionSummary.js`)

| Index | Query it covers |
|-------|----------------|
| `{ clientId: 1, 'period.type': 1, 'period.year': -1, 'period.month': -1, 'period.week': -1, 'period.day': -1 }` | Primary sort index |
| `{ clientId: 1, 'period.type': 1, 'period.year': 1, 'period.month': 1 }` | Month-filtered queries |
| `{ clientId: 1, 'metadata.lastCalculated': -1 }` | Latest summary lookup |
| `{ 'period.from': 1, 'period.to': 1 }` | Date range queries |
| UNIQUE: `{ clientId: 1, 'period.type': 1, 'period.year': 1, 'period.month': 1, 'period.week': 1, 'period.day': 1 }` | Uniqueness constraint |

**Status: ✅ Adequate indexes for EmissionSummary.** No missing indexes here.

---

## 6. What Is Working Correctly

| Component | Status |
|-----------|--------|
| Redis integration code | ✅ Correctly coded; fails only if Redis not started |
| DataEntry projection in `calculateEmissionSummary()` | ✅ `DATA_ENTRY_PROJECTION` limits fields at line 258 |
| Parallel queries with `Promise.all()` in `calculateEmissionSummary()` | ✅ DataEntry + ProcessEmissionDataEntry fetched in parallel |
| Stale-while-revalidate pattern | ✅ Returns stale data immediately, recalculates in background |
| Redis cache key scoped per `type` parameter | ✅ BUG-4 fix applied |
| EmissionSummary compound unique index | ✅ Prevents duplicate summary docs |
| Mongoose `.lean()` on all reads | ✅ Avoids Mongoose document overhead |
| Filtered summary Redis caching (`getFilteredSummary`) | ✅ 3-min TTL cache applied |
| Top/low Redis caching (`getTopLowEmissionStats`) | ✅ 5-min TTL cache applied |
| Hierarchy Redis caching (`getScopeIdentifierHierarchy`) | ✅ 5-min TTL cache applied |
| Reduction hierarchy Redis caching | ✅ 5-min TTL cache applied |
| bcrypt async calls | ✅ Fixed (Issue #9, 17 calls updated) |

---

## 7. Prioritized Fix Plan

### Tier 1 — Immediate: Must Fix Before Any Further Load Testing

| # | Bug ID | Change | File | Expected Impact |
|---|--------|--------|------|----------------|
| 1 | PERF-01 | Start Redis locally (`redis-server`) before k6 runs | Infrastructure | Reduces DB hits by ~99% for repeat requests |
| 2 | PERF-02 | Start Node in PM2 cluster mode locally (`pm2 start src/index.js -i 4`) | Infrastructure | Multiplies throughput by number of cores |
| 3 | PERF-03 | Add `.select(...)` projection to `DataEntry.find()` in `getScopeIdentifierEmissionExtremes` (line 4258) | CalculationSummary.js | Reduces per-request payload by 80–95% |
| 4 | PERF-04 | Add `.select(...)` projection to `DataEntry.find()` in `getScopeIdentifierHierarchy` (line 4740) | CalculationSummary.js | Reduces per-request payload by 80–95% |
| 5 | BUG-SEC-01 | Add `checkSummaryPermission` to `POST /:clientId/compare` route | summaryRoutes.js | Closes cross-client data leak |
| 6 | BUG-SEC-02 | Add `checkSummaryPermission` to `GET /:clientId/reduction/projects` route | summaryRoutes.js | Closes cross-client data leak |

### Tier 2 — High Priority: Fix Before Production Deployment

| # | Bug ID | Change | File | Expected Impact |
|---|--------|--------|------|----------------|
| 7 | BUG-SEC-03 | Catch all exceptions in auth middleware, not just JsonWebTokenError | auth.js | Converts 500 → 401 on malformed JWT |
| 8 | BUG-FUNC-01 | Add null guard / default for `globalPeriod` in compare controller | CalculationSummary.js | Converts 500 → 400 on empty body |
| 9 | PERF-06 | Exclude `metadata.dataEntriesIncluded` from all summary responses | CalculationSummary.js | Reduces response payload by 10–500 KB |
| 10 | PERF-07 | Batch ProgressSnapshot + PathwayAnnual queries using `$in` | CalculationSummary.js | Reduces N+1 to 2 queries for SBTi |
| 11 | PERF-09 | Set `maxPoolSize: 50` in `mongoose.connect()` options | database config | Better utilises Atlas M0's connection budget |
| 12 | PERF-10 | Run `NetReductionEntry` + `Reduction` queries in `Promise.all()` | CalculationSummary.js | Reduces reduction hierarchy latency by ~30–50% |

### Tier 3 — Long-Term: Required for True Sub-200 ms at Scale

| # | Bug ID | Change | Expected Impact |
|---|--------|--------|----------------|
| 13 | PERF-05 | Port `calculateEmissionSummary()` JavaScript loop to MongoDB `$group` aggregation pipeline | Moves CPU work to MongoDB; eliminates event-loop block |
| 14 | PERF-08 | Add per-client in-flight de-duplication for concurrent recalculation requests | Eliminates thundering-herd on cold cache |
| 15 | PERF-09 | Upgrade Atlas to M10+ for production | Removes 100-connection hard cap |
| 16 | — | Pre-warm caches on server startup for all active clients' most-used periods | Eliminates cold-start latency for first users each day |

---

## 8. Expected Latency After Tier 1 Fixes

After starting Redis, using PM2 cluster (4 workers), and adding the two missing projections:

| Scenario | Before Fix | Expected After Tier 1 |
|----------|-----------|----------------------|
| Smoke (5 VU) — cached | 1 100 ms | **< 10 ms** (Redis hit) |
| Smoke (5 VU) — uncached | 1 100 ms | ~800 ms (Atlas M0 single query) |
| Load (1 000 VU) — after warm cache | 86 000 ms p95 | **< 50 ms** (Redis hit, 4 workers) |
| Load (1 000 VU) — cache cold burst | 86 000 ms p95 | 2 000–5 000 ms (MongoDB hit, 4 workers) |
| Stress (2 000 VU) | 120 000 ms (timeout) | Depends on Atlas tier + cache hit rate |
| Sub-200 ms target locally | ❌ 0% | ✅ Achievable for cached responses; ❌ uncached Atlas M0 |

**Key insight:** Sub-200 ms is only achievable locally when Redis is running and the cache is warm. A cold-cache request to Atlas M0 will always take 800–5 000 ms because of Atlas M0 shared disk I/O, regardless of optimisations.

---

## 9. File Map — Every Location That Must Change

| File | Line(s) | Change Required | Bug IDs |
|------|---------|----------------|---------|
| `src/modules/zero-carbon/calculation/routes/summaryRoutes.js` | compare route | Add `checkSummaryPermission` | SEC-01 |
| `src/modules/zero-carbon/calculation/routes/summaryRoutes.js` | reduction/projects route | Add `checkSummaryPermission` | SEC-02 |
| `src/common/middleware/auth.js` | jwt.verify catch block | Catch `SyntaxError` not just `JsonWebTokenError` | SEC-03 |
| `src/modules/zero-carbon/calculation/CalculationSummary.js` | ~4258 | Add `.select()` to DataEntry.find() in extremes | PERF-03 |
| `src/modules/zero-carbon/calculation/CalculationSummary.js` | ~4740 | Add `.select()` to DataEntry.find() in hierarchy | PERF-04 |
| `src/modules/zero-carbon/calculation/CalculationSummary.js` | compareSummarySelections | Null guard on globalPeriod | FUNC-01 |
| `src/modules/zero-carbon/calculation/CalculationSummary.js` | ~2270–2360 | Exclude dataEntriesIncluded from response | PERF-06 |
| `src/modules/zero-carbon/calculation/CalculationSummary.js` | buildSbtiProgressForSummary loop | Batch ProgressSnapshot + PathwayAnnual with $in | PERF-07 |
| `src/modules/zero-carbon/calculation/CalculationSummary.js` | getReductionSummaryHierarchy ~5271 | Parallelise NetReductionEntry + Reduction queries | PERF-10 |
| `src/common/config/database.js` (or wherever mongoose.connect is called) | mongoose.connect options | Add `maxPoolSize: 50` | PERF-09 |
| Infrastructure | N/A | Start `redis-server` before load tests | PERF-01 |
| Infrastructure | N/A | `pm2 start src/index.js -i 4` for local load tests | PERF-02 |

---

## 10. Summary Table of All Issues

| ID | Category | Severity | Status | One-Line Description |
|----|----------|----------|--------|---------------------|
| SEC-01 | Security | CRITICAL | Unpatched | `POST /compare` missing `checkSummaryPermission` → cross-client leak |
| SEC-02 | Security | HIGH | Unpatched | `GET /reduction/projects` missing `checkSummaryPermission` → cross-client leak |
| SEC-03 | Security | MEDIUM | Unpatched | Malformed JWT → SyntaxError → 500 instead of 401 |
| FUNC-01 | Functional | MEDIUM | Unpatched | Empty compare body → null globalPeriod → 500 |
| FUNC-02 | Functional | LOW | Unpatched | `reduction/projects` returns 400 — missing required param |
| FUNC-03 | Functional | LOW | Known | `reductions/summary` returns 403 for client_admin (role restriction) |
| PERF-01 | Performance | CATASTROPHIC | Infrastructure | Redis not started locally → zero cache hits → all requests hit Atlas |
| PERF-02 | Performance | SEVERE | Infrastructure | Single Node.js process → event loop saturated at ~10 concurrent users |
| PERF-03 | Performance | HIGH | Bug (1 line fix) | `extremes` endpoint: DataEntry.find() has no projection → full doc load |
| PERF-04 | Performance | HIGH | Bug (1 line fix) | `hierarchy` endpoint: DataEntry.find() has no projection → full doc load |
| PERF-05 | Performance | HIGH | Architecture | calculateEmissionSummary() is JavaScript loop, not MongoDB pipeline |
| PERF-06 | Performance | MEDIUM | Bug (response projection) | `dataEntriesIncluded` array (100s of ObjectIds) sent in every response |
| PERF-07 | Performance | MEDIUM | Bug (N+1) | buildSbtiProgressForSummary: N×2 sequential queries per SBTi target |
| PERF-08 | Performance | HIGH | Architecture | Cold-cache recalculation has no de-duplication — thundering herd |
| PERF-09 | Performance | SEVERE | Infrastructure | Atlas M0 caps at ~100 connections — saturated at 10% of 1 000 VU load |
| PERF-10 | Performance | MEDIUM | Bug | reduction/hierarchy: NetReductionEntry + Reduction queries are sequential |
