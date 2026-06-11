# GreOn IQ Credit Wallet — API Test Cases

**Base URL:** `http://localhost:5000`  
**Auth:** All protected routes require `Authorization: Bearer <token>` header  
**Content-Type:** `application/json`

---

## How to Get a Token (Login First)

```
POST /api/users/login
Body: { "email": "admin@example.com", "password": "YourPassword@123" }
Response: { "token": "<JWT>" }
```

Use the returned token in all subsequent requests.

---

## ─────────────────────────────────────────────────────────
## SECTION A — Wallet Auto-Seeding (Creation Events)
## ─────────────────────────────────────────────────────────

### A1 — Create Consultant (Default 500 Credits)

```
POST /api/users/consultant
Auth: consultant_admin token
Body:
{
  "email": "consultant1@test.com",
  "password": "Test@12345",
  "contactNumber": "9876543210",
  "userName": "consultant_one",
  "address": "Chennai",
  "employeeId": "EMP001",
  "jobRole": "Junior Consultant",
  "branch": "South",
  "accessibleModules": ["zero_carbon"]
}
```

| # | Test | Expected |
|---|------|---------|
| A1-T1 | Submit valid body | `201` — `{ "message": "Consultant created successfully" }` |
| A1-T2 | Check wallet via `GET /api/greon-iq/quota` as that consultant | `balance: 500` |
| A1-T3 | Missing `employeeId` | `400` — `{ "field": "employeeId" }` |
| A1-T4 | Auth as `consultant` (not admin) | `403` |
| A1-T5 | Duplicate email | `409` — duplicate key error |

---

### A2 — Create Consultant with Custom Credits

```
POST /api/users/consultant
Auth: consultant_admin token
Body: { ...same as A1..., "initialCredits": 2000 }
```

| # | Test | Expected |
|---|------|---------|
| A2-T1 | Submit with `initialCredits: 2000` | `201` success |
| A2-T2 | Check wallet afterward | `balance: 2000` |
| A2-T3 | `initialCredits: 0` | Treated as invalid → falls back to default 500 |
| A2-T4 | `initialCredits: -100` | Treated as invalid → falls back to default 500 |

---

### A3 — Create Employee Head (Fixed 5,000 Credits)

```
POST /api/users/employee-head
Auth: client_admin token
Body:
{
  "email": "head1@clientco.com",
  "password": "Test@12345",
  "contactNumber": "9123456780",
  "userName": "emphead_one",
  "address": "Mumbai",
  "department": "Operations",
  "location": "HQ"
}
```

| # | Test | Expected |
|---|------|---------|
| A3-T1 | Submit valid body | `201` success |
| A3-T2 | Check wallet as that employee head | `balance: 5000` |
| A3-T3 | Auth as `employee` (not client_admin) | `403` |
| A3-T4 | Missing `department` | `400` validation error |
| A3-T5 | `initialCredits: 9999` in body | Ignored — balance is always **5000** (fixed) |

---

### A4 — Assign Consultant to Client (+500 to Consultant)

```
PATCH /api/clients/:clientId/assign-consultant
Auth: consultant_admin token
Body: { "consultantId": "<ObjectId of consultant>" }
```

| # | Test | Expected |
|---|------|---------|
| A4-T1 | Valid assignment | `200` success |
| A4-T2 | Check consultant wallet after | Previous balance **+500** |
| A4-T3 | Re-assign same consultant to same client | `400` — "already assigned" — **no duplicate credit** |
| A4-T4 | Invalid `consultantId` (not under this admin) | `400` — "Invalid consultant" |
| A4-T5 | Auth as `consultant` (not admin) | `403` |

---

### A5 — Activate Client → Opening Balance (+10,000 to client_admin)

```
PATCH /api/clients/:clientId/move-to-active
Auth: consultant_admin token
Body: { "subscriptionStartDate": "2026-06-01", "subscriptionEndDate": "2027-06-01" }
```

| # | Test | Expected |
|---|------|---------|
| A5-T1 | Valid activation | `200` — `{ "stage": "active" }` |
| A5-T2 | Check client_admin wallet after | Initial grant (10,000) **+ activation bonus (10,000) = 20,000** |
| A5-T3 | Activate again (already active) | `400` — stage error |
| A5-T4 | Auth as `consultant` | `403` |

---

## ─────────────────────────────────────────────────────────
## SECTION B — Credit Wallet Read Endpoints
## ─────────────────────────────────────────────────────────

### B1 — GET Own Wallet Balance

```
GET /api/greon-iq/quota
Auth: any allowed role token (consultant, client_admin, client_employee_head,
      consultant_admin, super_admin)
```

| # | Role | Expected Response |
|---|------|-----------------|
| B1-T1 | `consultant` | `200` — `{ "isUnlimited": false, "balance": <N>, "enabled": true/false }` |
| B1-T2 | `client_admin` | `200` — `{ "isUnlimited": false, "balance": <N> }` |
| B1-T3 | `client_employee_head` | `200` — `{ "isUnlimited": false, "balance": 5000 }` |
| B1-T4 | `consultant_admin` | `200` — `{ "isUnlimited": true, "balance": null }` |
| B1-T5 | `super_admin` | `200` — `{ "isUnlimited": true, "balance": null }` |
| B1-T6 | `auditor` | `403` — `GREON_IQ_ROLE_BLOCKED` |
| B1-T7 | `viewer` | `403` — `GREON_IQ_ROLE_BLOCKED` |
| B1-T8 | `employee` | `403` — `GREON_IQ_ROLE_BLOCKED` |
| B1-T9 | No token | `401` — Unauthorized |

---

### B2 — GET Own Usage Summary

```
GET /api/greon-iq/usage
Auth: any allowed role token
```

| # | Test | Expected |
|---|------|---------|
| B2-T1 | Fresh account (no queries yet) | `200` — `{ "balance": <N>, "lifetimeAdded": <N>, "lifetimeUsed": 0, "totalQueries": 0 }` |
| B2-T2 | After 1 query consuming 2 credits | `lifetimeUsed: 2`, `totalQueries: 1` |
| B2-T3 | `auditor` role | `403` — `GREON_IQ_ROLE_BLOCKED` |

---

### B3 — GET Credit Transaction History

```
GET /api/greon-iq/quota/transactions
Auth: consultant, client_admin, client_employee_head token
Query params: ?page=1&limit=20
```

| # | Test | Expected |
|---|------|---------|
| B3-T1 | Fresh account | `200` — `{ "transactions": [...initialGrant], "pagination": { "total": 1 } }` |
| B3-T2 | After receiving activation bonus | `transactions` includes both `initial_grant` and `activation_bonus` records |
| B3-T3 | After a query | `transactions` includes a `query_deduction` record with negative `amount` |
| B3-T4 | `?page=1&limit=5` with 10 records | `pagination.pages: 2`, `transactions.length: 5` |
| B3-T5 | `auditor` role | `403` — `GREON_IQ_ROLE_BLOCKED` |
| B3-T6 | Each transaction has `amount`, `balanceAfter`, `type`, `createdAt` | All fields present |

---

### B4 — GET Another User's Wallet (Admin View)

```
GET /api/greon-iq/quota/:userId
Auth: super_admin or consultant_admin token
Params: userId = ObjectId of target user
```

| # | Test | Expected |
|---|------|---------|
| B4-T1 | Valid `userId` of a consultant | `200` — `{ "balance": <N>, "lifetimeAdded": <N> }` |
| B4-T2 | `userId` of a `super_admin` | `200` — `{ "isUnlimited": true, "balance": null }` |
| B4-T3 | Non-existent `userId` | `404` — `USER_NOT_FOUND` |
| B4-T4 | Auth as `consultant` (not admin) | `403` — `FORBIDDEN` |
| B4-T5 | Auth as `client_admin` | `403` — `FORBIDDEN` |

---

## ─────────────────────────────────────────────────────────
## SECTION C — Manual Credit Adjustment (Admin)
## ─────────────────────────────────────────────────────────

### C1 — POST Manual Adjust Credits

```
POST /api/greon-iq/quota/adjust
Auth: super_admin or consultant_admin token
Body:
{
  "targetUserId": "<ObjectId>",
  "amount": 500,
  "reason": "Top-up for Q3 project"
}
```

| # | Test | Expected |
|---|------|---------|
| C1-T1 | Positive `amount` (top-up) | `200` — `{ "newBalance": <prev+500>, "transactionId": "<id>" }` |
| C1-T2 | Negative `amount` (deduct) | `200` — balance reduces; transaction `amount` is negative |
| C1-T3 | `amount: 0` | `400` — `INVALID_AMOUNT` |
| C1-T4 | Negative `amount` larger than balance | `400` — `INSUFFICIENT_BALANCE` |
| C1-T5 | Missing `reason` | `400` — `MISSING_REASON` |
| C1-T6 | Missing `targetUserId` | `400` — `MISSING_TARGET_USER` |
| C1-T7 | `targetUserId` does not exist | `404` — `USER_NOT_FOUND` |
| C1-T8 | Auth as `consultant` (not admin) | `403` — `FORBIDDEN` |
| C1-T9 | Auth as `client_admin` | `403` — `FORBIDDEN` |
| C1-T10 | Adjust credits for a `super_admin` user | Still creates wallet if missing, then adjusts |
| C1-T11 | Check `GET /quota/transactions` after adjust | New `manual_adjustment` record appears |

---

## ─────────────────────────────────────────────────────────
## SECTION D — Query Execution & Credit Deduction
## ─────────────────────────────────────────────────────────

### D1 — POST Greon IQ Query (Deducts Credits)

```
POST /api/greon-iq/query
Auth: consultant, client_admin, or client_employee_head token
Body:
{
  "question": "What is our total Scope 1 emissions for 2025?",
  "clientId": "Greon001"
}
```

| # | Test | Expected |
|---|------|---------|
| D1-T1 | Valid query, balance > 0 | `200` — answer returned with `creditsUsed`, `creditsRemaining` in response |
| D1-T2 | Check `balance` via `GET /quota` after query | Balance reduced by the deducted credits |
| D1-T3 | Check `GET /quota/transactions` after | New `query_deduction` record with negative amount |
| D1-T4 | `auditor` role | `403` — `GREON_IQ_ROLE_BLOCKED` |
| D1-T5 | `viewer` role | `403` — `GREON_IQ_ROLE_BLOCKED` |
| D1-T6 | `consultant_admin` role | `200` — unlimited, `creditsUsed: 0`, balance unchanged |
| D1-T7 | `super_admin` role | `200` — unlimited, `creditsUsed: 0` |

---

### D2 — Query with Zero Balance (Quota Exhausted)

Pre-condition: Drain the user's wallet to 0 using `POST /quota/adjust` with a large negative amount.

```
POST /api/greon-iq/query
Auth: consultant token (with balance = 0)
Body: { "question": "...", "clientId": "Greon001" }
```

| # | Test | Expected |
|---|------|---------|
| D2-T1 | Balance = 0 before query | `429` — `{ "code": "QUOTA_EXHAUSTED" }` |
| D2-T2 | Top up via `POST /quota/adjust` (+100), then query | `200` — query succeeds |
| D2-T3 | `GET /quota` shows `enabled: false` when balance = 0 | `enabled: false` in response |

---

### D3 — Credit Cost by Token Tier

| Scenario | Total Tokens | Expected `creditsUsed` |
|----------|-------------|----------------------|
| Very short answer | ≤ 500 | **1** |
| Short answer with table | 501–1,200 | **2** |
| Detailed answer | 1,201–3,500 | **4** |
| Complex cross-module analysis | 3,501–10,000 | **10** |
| Very large report | 11,000 | **11** |
| Extended report | 20,000 | **20** |

---

## ─────────────────────────────────────────────────────────
## SECTION E — Role Gate (Access Control)
## ─────────────────────────────────────────────────────────

### E1 — All GreOn IQ Endpoints Role Matrix

Test `GET /api/greon-iq/quota` with each role token:

| Role | Expected |
|------|---------|
| `super_admin` | `200` ✅ |
| `consultant_admin` | `200` ✅ |
| `consultant` | `200` ✅ |
| `client_admin` | `200` ✅ |
| `client_employee_head` | `200` ✅ |
| `auditor` | `403` ❌ `GREON_IQ_ROLE_BLOCKED` |
| `viewer` | `403` ❌ `GREON_IQ_ROLE_BLOCKED` |
| `employee` | `403` ❌ `GREON_IQ_ROLE_BLOCKED` |
| `contributor` | `403` ❌ `GREON_IQ_ROLE_BLOCKED` |
| `reviewer` | `403` ❌ `GREON_IQ_ROLE_BLOCKED` |
| `approver` | `403` ❌ `GREON_IQ_ROLE_BLOCKED` |
| `support` | `403` ❌ `GREON_IQ_ROLE_BLOCKED` |
| `supportManager` | `403` ❌ `GREON_IQ_ROLE_BLOCKED` |

---

## ─────────────────────────────────────────────────────────
## SECTION F — Legacy / Deprecated Endpoints (Must Return 410)
## ─────────────────────────────────────────────────────────

| Endpoint | Expected |
|---------|---------|
| `POST /api/greon-iq/quota/allocate` | `410` — `{ "code": "DEPRECATED" }` |
| `GET /api/greon-iq/quota/user-policy` | `410` — `{ "code": "DEPRECATED" }` |
| `DELETE /api/greon-iq/quota/allocate/:id` | `410` — `{ "code": "DEPRECATED" }` |

---

## ─────────────────────────────────────────────────────────
## SECTION G — Full End-to-End Scenario (Golden Path)
## ─────────────────────────────────────────────────────────

Run these steps **in order** to verify the complete credit lifecycle:

```
Step 1.  Login as consultant_admin → get token A
Step 2.  POST /api/users/consultant (token A) → new consultant created, wallet seeded 500
Step 3.  Login as consultant → get token B
Step 4.  GET /api/greon-iq/quota (token B) → balance: 500, enabled: true
Step 5.  PATCH /api/clients/Greon001/assign-consultant (token A, consultantId) → +500
Step 6.  GET /api/greon-iq/quota (token B) → balance: 1000
Step 7.  PATCH /api/clients/Sandbox_Greon001/move-to-active (token A) → client_admin created
Step 8.  Login as client_admin → get token C
Step 9.  GET /api/greon-iq/quota (token C) → balance: 20000 (10000 initial + 10000 bonus)
Step 10. POST /api/greon-iq/query (token C) → query runs, credits deducted
Step 11. GET /api/greon-iq/quota (token C) → balance reduced by creditsUsed
Step 12. GET /api/greon-iq/quota/transactions (token C) → see initial_grant, activation_bonus, query_deduction
Step 13. POST /api/greon-iq/quota/adjust (token A, targetUserId=client_admin._id, amount=-20000) → balance: 0
Step 14. POST /api/greon-iq/query (token C) → 429 QUOTA_EXHAUSTED
Step 15. POST /api/greon-iq/quota/adjust (token A, amount=+500) → top-up
Step 16. POST /api/greon-iq/query (token C) → 200 success again
```

All steps should pass without errors. This validates creation, seeding, bonus, deduction, exhaustion, and recovery.
