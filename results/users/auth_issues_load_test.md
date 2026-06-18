# Auth API — Load Test Issues Report
Generated: 2026-06-17

---

## CRITICAL — Server Crash Under ~237 Concurrent VUs

**Symptom:**
```
wsarecv: An existing connection was forcibly closed by the remote host.
connectex: No connection could be made because the target machine actively refused it.
```

**What happened:**
The backend Node.js process (single instance, `node index.js`) crashed when k6 ramped up to
approximately **237 concurrent VUs** during the load test.  The process dropped all open TCP
connections and then stopped accepting new ones (ECONNREFUSED). The test was targeting 1 000 VUs.

**Root cause — bcrypt + libuv thread-pool exhaustion:**

1. Each login request calls `bcrypt.compare(password, hash)`.
2. `bcrypt.compare` is CPU-bound and uses libuv's native thread pool (default: 4 threads).
3. Setting `UV_THREADPOOL_SIZE=64` helps, but with 237+ concurrent requests all queuing bcrypt
   work, the event-loop backlog grows until either:
   - The OS TCP socket backlog overflows (default `listen(511)` in Node).
   - Node.js runs out of file descriptors or heap memory under the request flood.
4. This results in ECONNRESET/ECONNREFUSED for the k6 VUs and the process crashing.

---

## Issues Found

### [CRITICAL] Server crashes at ~237 concurrent login requests
- **Severity:** Critical
- **Endpoint:** POST /api/users/login
- **Trigger:** ~237 simultaneous bcrypt.compare calls in a single Node.js process
- **Fix 1 (immediate):** Start server with `UV_THREADPOOL_SIZE=64; node index.js`
  - Raises the libuv thread pool from 4 → 64 threads
  - Allows 64 concurrent bcrypt operations instead of 4
  - Expected to handle ~400-500 concurrent VUs on a 4-core machine
- **Fix 2 (required for 1 000+ concurrent):** PM2 cluster mode
  ```
  pm2 start index.js -i max
  ```
  - Spawns one Node.js worker per CPU core (e.g. 4 cores → 4 workers)
  - Each worker handles ~250 VUs → 4 × 250 = 1 000 total
  - **BLOCKER:** OTP store is an in-memory Map in `otpHelper.js`.
    Under PM2 cluster, Step 1 (login → storeOTP) may run on Worker A, but
    Step 2 (verify-otp → verifyOTP) may hit Worker B (different Map) → OTP not found → 400.
  - **Pre-condition for PM2:** Migrate OTP store from in-memory Map to Redis or MongoDB.
    ```js
    // Current (breaks under cluster):
    const otpStore = new Map();
    // Required:
    // Option A — Redis:  await redis.set(`otp:${email}`, otpJson, 'EX', 600)
    // Option B — MongoDB: OTPRecord model with TTL index
    ```

### [HIGH] 4 test users cannot login during setup (step2: 409)
- **Affected:** meera.nair@urbanaxis.com, devika.pillai@urbanaxis.com,
  aarav.menon@urbanaxis.com, Neena@codenest.com
- **Reason:** These users have existing active sessions in the DB from the real app.
  Although `NODE_ENV=test` bypasses the session limit in the main VU iterations,
  the setup's sequential login-logout of each user is still hitting the limit.
  **Investigation needed:** Check if `NODE_ENV=test` is actually picked up by the running
  server. Verify by checking server console: `[OTP TEST MODE]` messages should appear.
- **Impact on test:** Minor. The main VU iterations (actual load test) had 0% error rate
  in the smoke test (5 VUs). These users are just not being pre-cleaned in setup.

### [MEDIUM] canLogoutAllDevices permission not set on any test user
- **Endpoint:** POST /api/users/me/logout-all-devices
- **Finding:** All test accounts return 403 LOGOUT_ALL_DENIED.
  This permission must be explicitly granted via admin API.
- **Impact on load test setup:** The setup originally used this endpoint to clear
  all sessions before the test. Since no test user has the permission, session pre-clearing
  was not working. Workaround: use regular logout (implemented in current k6 script).
- **Impact on k6 setup (from login_test.js):** The original `login_test.js` setup()
  also calls `logout-all-devices`. Same issue — those setup calls return 403 silently.
- **Fix:** Grant `canLogoutAllDevices: true` to at least one super_admin / consultant_admin
  test account via:
  ```
  PATCH /api/admin/users/:userId/user-permissions
  Body: { "canLogoutAllDevices": true }
  ```

### [LOW] p99 latency not captured in summary
- **Finding:** k6 Trend metric p(99) shows 0 in the summary banner. This is a display bug —
  the `avg()` helper in `handleSummary` looks for `['p(99)']` but k6 only outputs p(99) when
  explicitly requested. The data is in `rawMetrics` in the JSON output.
- **Fix:** Not a production concern. JSON output has full percentile data.

---

## What Passed (Functional Tests — 40/40)
All functional tests in `__tests__/users/auth.test.js` passed:
- Login happy path (200 + tempToken, masked email, response shape)
- Login validation (missing fields, wrong password, unknown email)
- Login security (no hash exposure, no injection, no user enumeration)
- OTP verification (200 + JWT, user object, wrong OTP, invalid token)
- Resend OTP (cooldown 429, missing/invalid tempToken)
- Logout (401 without token, 200 with valid token, 401 on reuse — session invalidated)
- Logout-all-devices (401 without token, 403 without permission — correct API contract)
- Forgot password (400 missing email, 200 for both registered/unknown — no enumeration)
- Reset password (400 missing fields, 400 short password, 400 invalid token)
- Security headers (X-Content-Type-Options, no X-Powered-By)

## Smoke Test Results (5 VUs, 40 s)
- Login avg: 457 ms, p95: 795 ms
- OTP verify avg: 396 ms, p95: 506 ms
- Logout avg: 404 ms
- Error rate: 0.00% (all thresholds passed)

---

## Recommended Action Plan (Priority Order)

1. **[IMMEDIATE]** Always start server with `UV_THREADPOOL_SIZE=64`:
   ```powershell
   $env:UV_THREADPOOL_SIZE = 64; node index.js
   ```

2. **[SHORT TERM]** Migrate OTP store to Redis or MongoDB (required before clustering):
   - File to change: `src/common/utils/otpHelper.js`
   - The in-memory Map is a single point of failure for clustering

3. **[SHORT TERM]** Replace remaining `bcrypt.hashSync` calls with `await bcrypt.hash`:
   - File: `src/common/controllers/user/userController.js`
   - Lines: 993, 1270, 1622, 1928, 2247, 2430, 2601, 2908, 3205, 5732, 5939, 7142, 7219, 7296
   - Blocking bcrypt operations reduce event-loop throughput for ALL concurrent users

4. **[MEDIUM TERM]** Enable PM2 cluster after OTP migration:
   ```bash
   npm install -g pm2
   pm2 start index.js -i max --name zero-carbon
   pm2 startup
   pm2 save
   ```

5. **[MEDIUM TERM]** Consider MongoDB Atlas upgrade (M10 or M20) before production traffic:
   - Free tier: 512 MB RAM, shared CPU, max 500 connections
   - Under 1 000 concurrent VUs, MongoDB Atlas free tier will be the second bottleneck
   - M10 ($57/month): 2 GB RAM, 1 vCPU, up to 1 500 connections

6. **[OPTIONAL]** Add a proper health-check endpoint for monitoring:
   ```
   GET /api/health → { status: 'ok', uptime: <seconds>, memUsage: <MB> }
   ```
