# ESGLink Module Expansion — Full Frontend Integration Guide

**Date:** 2026-04-12  
**Backend Version:** Post-ESGLink expansion  
**Audience:** Frontend development team  
**Purpose:** Complete reference for building ESGLink UI — every endpoint, every field, every role rule, every error code

---

## Table of Contents

1. [What Changed at a High Level](#1-what-changed-at-a-high-level)
2. [Module System Explained](#2-module-system-explained)
3. [New User Types](#3-new-user-types)
4. [Role & Access Rules Summary](#4-role--access-rules-summary)
5. [All New API Endpoints — Full Detail](#5-all-new-api-endpoints--full-detail)
   - 5.1 Create ESGLink Contributor
   - 5.2 Create ESGLink Reviewer
   - 5.3 Create ESGLink Approver
   - 5.4 Update User Module Access
   - 5.5 Update Client Module Access
   - 5.6 Manage ESGLink Subscription
   - 5.7 Review ESGLink Subscription Request
   - 5.8 Get ESGLink Pending Approvals
6. [Updated Existing Endpoints](#6-updated-existing-endpoints)
   - 6.1 Create Auditor (now accepts accessibleModules)
   - 6.2 Create Viewer (now accepts accessibleModules)
   - 6.3 Update Assessment Level (security fix — now requires role)
7. [ESGLink Subscription Workflow (Full Flow)](#7-esglink-subscription-workflow-full-flow)
8. [Auth Middleware — What Changes for ESGLink Users](#8-auth-middleware--what-changes-for-esglink-users)
9. [Model Field Reference](#9-model-field-reference)
10. [Error Reference](#10-error-reference)
11. [Migration Note for Existing Data](#11-migration-note-for-existing-data)
12. [UI Checklist for Frontend Team](#12-ui-checklist-for-frontend-team)

---

## 1. What Changed at a High Level

The backend now supports **two product modules** within the same application:

| Module | Value | Description |
|--------|-------|-------------|
| ZeroCarbon | `zero_carbon` | Existing module — carbon tracking and reduction |
| ESGLink | `esg_link` | New module — ESG reporting and data contribution |

### Key concepts

1. **Every user has an `accessibleModules` array** — controls which modules they can log into/access.
2. **Every client has an `accessibleModules` array** — controls which modules the organisation has licensed.
3. **Each module has its own subscription** — `zero_carbon` uses the existing subscription fields; `esg_link` has a new `esgLinkSubscription` sub-document.
4. **Three new user types** for ESGLink: `contributor`, `reviewer`, `approver`.
5. **Existing user types** (`auditor`, `viewer`) now work for **both modules** — controlled by their `accessibleModules` field.
6. **All new ESGLink user creation goes through `client_admin`** — same as existing ZeroCarbon user creation.

---

## 2. Module System Explained

### 2.1 How modules are stored

**On the User document:**
```json
{
  "accessibleModules": ["zero_carbon"]          // default for all existing users
  "accessibleModules": ["esg_link"]             // ESGLink-only user
  "accessibleModules": ["zero_carbon", "esg_link"]  // dual-module user
}
```

**On the Client document:**
```json
{
  "accessibleModules": ["zero_carbon"]          // ZeroCarbon-only client
  "accessibleModules": ["zero_carbon", "esg_link"]  // both modules
}
```

### 2.2 How the backend enforces module access

On every protected API request, `middleware/auth.js` checks:
- For each module in `req.user.accessibleModules`, the corresponding client subscription must be `active` or `grace_period`.
- `zero_carbon` → checks `client.accountDetails.subscriptionStatus`
- `esg_link` → checks `client.accountDetails.esgLinkSubscription.subscriptionStatus`

If a module subscription is inactive → **403 Forbidden**.

### 2.3 Default for existing users

All users and clients created before the ESGLink expansion default to `['zero_carbon']`. No existing behaviour changes unless a user is explicitly assigned `esg_link`.

### 2.4 Frontend implication

- When a user logs in, check `user.accessibleModules` in the login response to decide which module tabs/dashboards to show.
- If `accessibleModules` contains `esg_link` → show ESGLink navigation.
- If `accessibleModules` contains `zero_carbon` → show ZeroCarbon navigation.
- If both → show both.

---

## 3. New User Types

| userType | Module | Created by | Default permissions |
|----------|--------|------------|---------------------|
| `contributor` | `esg_link` | `client_admin` | `canSubmitData: true`, all others `false` |
| `reviewer` | `esg_link` | `client_admin` | `canViewReports: true`, all others `false` |
| `approver` | `esg_link` | `client_admin` | `canViewReports: true`, all others `false` |

All three are created with:
- `accessibleModules: ['esg_link']` (hardcoded — cannot be changed at creation time)
- `isActive: true`
- `companyName` inherited from the `client_admin`'s company

### Existing types now multi-module

| userType | Now works for |
|----------|--------------|
| `auditor` | `zero_carbon`, `esg_link`, or both — controlled by `accessibleModules` field on the user |
| `viewer` | `zero_carbon`, `esg_link`, or both — same |

---

## 4. Role & Access Rules Summary

### Who can create which users

| Actor | Can create |
|-------|-----------|
| `super_admin` | `consultant_admin`, `supportManager` |
| `consultant_admin` | `consultant` |
| `client_admin` | `client_employee_head`, `employee`, `auditor`, `viewer`, `contributor`*, `reviewer`*, `approver`* |
| `client_employee_head` | `employee` |
| `supportManager` | `support` |

*ESGLink users (`contributor`, `reviewer`, `approver`) can only be created if the client has `esg_link` in `accessibleModules` AND the ESGLink subscription is `active` or `grace_period`.

### Who can update module access

| Operation | super_admin | consultant_admin (managing) | Others |
|-----------|-------------|----------------------------|--------|
| Update client `accessibleModules` | Any client | Own clients only | ❌ |
| Update user `accessibleModules` | Any user | Own clients' users only | ❌ |

**"Managing consultant_admin"** = the `consultant_admin` whose `_id` matches `client.leadInfo.consultantAdminId`. Only that specific `consultant_admin` can manage that client — not all `consultant_admin`s.

### Who can update assessment level

| Role | Access |
|------|--------|
| `super_admin` | Any client |
| `consultant_admin` (managing) | Own clients only |
| All others | ❌ 403 |

### Who can manage ESGLink subscription

| Actor | What they can do |
|-------|-----------------|
| `consultant` (assigned to client) | **Request** suspend or reactivate (creates a pending request — does not apply immediately) |
| `consultant_admin` (managing) | **Directly** suspend, reactivate, renew, extend (applied immediately) |
| `super_admin` | **Directly** any action on any client |

---

## 5. All New API Endpoints — Full Detail

> **Base URL:** All routes assume the existing base path (e.g., `/api/users`, `/api/clients`)
> **Auth:** All protected routes require `Authorization: Bearer <token>` header.

---

### 5.1 Create ESGLink Contributor

**`POST /api/users/contributor`**

Creates a new user with `userType: contributor` for the ESGLink module.

**Who can call this:** `client_admin` only.  
**Prerequisites:**
- The `client_admin`'s client must have `esg_link` in `accessibleModules`
- The client's `esgLinkSubscription.subscriptionStatus` must be `active` or `grace_period`
- The client's contributor quota must not be exhausted

**Request body:**
```json
{
  "email": "john.contributor@acme.com",
  "password": "SecurePass123!",
  "contactNumber": "0501234567",
  "userName": "john_contributor",
  "address": "123 Business Park, Dubai"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `email` | string | ✅ | Must be unique across all users |
| `password` | string | ✅ | Plain text — backend hashes with bcrypt |
| `contactNumber` | string | ✅ | |
| `userName` | string | ✅ | Must be unique across all users |
| `address` | string | ✅ | |

**Success response — 201:**
```json
{
  "message": "Contributor created successfully",
  "contributor": {
    "id": "64f2a1b3c9e4f12345678901",
    "email": "john.contributor@acme.com",
    "userName": "john_contributor"
  }
}
```

**Error responses:**

| Status | `message` | Reason |
|--------|-----------|--------|
| `400` | `"email, password, contactNumber, userName and address are required"` | Missing required field |
| `403` | `"Only Client Admin can create ESGLink users"` | Caller is not `client_admin` |
| `403` | `"Your organisation does not have access to the ESGLink module"` | Client `accessibleModules` doesn't include `esg_link` |
| `403` | `"Your organisation's ESGLink subscription is not active"` | ESGLink subscription is suspended/expired |
| `404` | `"Client not found"` | Client record missing |
| `409` | `"Email or Username already exists"` | Duplicate email or userName |
| `429` | `"Contributor quota exceeded for this client."` | Quota limit reached |
| `500` | `"Failed to create Contributor"` | Server error |

---

### 5.2 Create ESGLink Reviewer

**`POST /api/users/reviewer`**

Creates a new user with `userType: reviewer` for the ESGLink module.

**Who can call this:** `client_admin` only.  
**Same prerequisites as Contributor.**

**Request body:** Same fields as Contributor (email, password, contactNumber, userName, address).

**Success response — 201:**
```json
{
  "message": "Reviewer created successfully",
  "reviewer": {
    "id": "64f2a1b3c9e4f12345678902",
    "email": "sara.reviewer@acme.com",
    "userName": "sara_reviewer"
  }
}
```

**Error responses:** Same as Contributor (with quota message `"Reviewer quota exceeded for this client."`).

---

### 5.3 Create ESGLink Approver

**`POST /api/users/approver`**

Creates a new user with `userType: approver` for the ESGLink module.

**Who can call this:** `client_admin` only.  
**Same prerequisites as Contributor.**

**Request body:** Same fields as Contributor (email, password, contactNumber, userName, address).

**Success response — 201:**
```json
{
  "message": "Approver created successfully",
  "approver": {
    "id": "64f2a1b3c9e4f12345678903",
    "email": "ali.approver@acme.com",
    "userName": "ali_approver"
  }
}
```

**Error responses:** Same as Contributor (with quota message `"Approver quota exceeded for this client."`).

---

### 5.4 Update User Module Access

**`PATCH /api/users/:userId/module-access`**

Updates which modules a specific user can access.

**Who can call this:**
- `super_admin` — can update any user
- `consultant_admin` — can only update users in clients they manage; the target module must already exist in the client's `accessibleModules`

**URL param:** `userId` — MongoDB `_id` of the user to update.

**Request body:**
```json
{
  "accessibleModules": ["zero_carbon", "esg_link"]
}
```

| Field | Type | Required | Allowed values |
|-------|------|----------|----------------|
| `accessibleModules` | string[] | ✅ | `"zero_carbon"`, `"esg_link"` |

**Success response — 200:**
```json
{
  "message": "User module access updated successfully",
  "userId": "64f2a1b3c9e4f12345678901",
  "accessibleModules": ["zero_carbon", "esg_link"]
}
```

**Error responses:**

| Status | `message` | Reason |
|--------|-----------|--------|
| `400` | `"accessibleModules array is required"` | Field missing or empty |
| `400` | `"Invalid module(s): unknown_module"` | Module value not in allowed list |
| `403` | `"Only Super Admin or Consultant Admin can update module access"` | Wrong role |
| `403` | `"You can only update module access for users in clients you manage"` | `consultant_admin` trying to edit another admin's client |
| `403` | `"Client Greon001 does not have access to module: esg_link"` | Client hasn't been given the module yet |
| `404` | `"User not found"` | Invalid `userId` |
| `500` | `"Failed to update module access"` | Server error |

---

### 5.5 Update Client Module Access

**`PATCH /api/clients/:clientId/module-access`**

Assigns or updates which product modules a client organisation can access.

**Who can call this:**
- `super_admin` — any client
- `consultant_admin` — only clients they manage (verified via `client.leadInfo.consultantAdminId`)

**URL param:** `clientId` — the client's business ID (e.g., `"Greon001"`).

**Request body:**
```json
{
  "accessibleModules": ["zero_carbon", "esg_link"]
}
```

**Important:** When `esg_link` is added for the first time, the backend automatically initialises an `esgLinkSubscription` sub-document with `subscriptionStatus: "active"` and `isActive: true`. The frontend should then prompt the consultant to set proper subscription dates via the ESGLink subscription management endpoint.

**Success response — 200:**
```json
{
  "message": "Client module access updated successfully.",
  "accessibleModules": ["zero_carbon", "esg_link"],
  "addedModules": ["esg_link"]
}
```

| Response field | Description |
|----------------|-------------|
| `accessibleModules` | The full updated list |
| `addedModules` | Modules that were newly added (not previously present) |

**Error responses:**

| Status | `message` | Reason |
|--------|-----------|--------|
| `400` | `"accessibleModules must be a non-empty array."` | Field missing or empty |
| `400` | `"Invalid module(s): unknown. Allowed: zero_carbon, esg_link."` | Invalid module value |
| `403` | `"Only Super Admin or Consultant Admin can update client module access."` | Wrong role |
| `403` | `"You are not authorized to update this client's module access."` | `consultant_admin` not managing this client |
| `404` | `"Client not found."` | Invalid `clientId` |
| `500` | `"Failed to update client module access."` | Server error |

---

### 5.6 Manage ESGLink Subscription

**`PATCH /api/clients/:clientId/subscription/esglink`**

Manages the ESGLink subscription for a client. Behaviour differs by caller role.

**URL param:** `clientId` — the client's business ID.

**Request body:**
```json
{
  "action": "suspend",
  "reason": "Invoice overdue",
  "extensionDays": 30
}
```

| Field | Type | Required | Allowed values | Notes |
|-------|------|----------|----------------|-------|
| `action` | string | ✅ | `suspend`, `reactivate`, `renew`, `extend` | |
| `reason` | string | ❌ | Any string | Optional note |
| `extensionDays` | number | ✅ for `extend` | Positive integer | How many days to add. For `renew`, defaults to 365 if omitted |

#### Behaviour by actor role

**Consultant (assigned to the client):**
- Can only use actions: `suspend`, `reactivate`
- Creates a **pending request** — does NOT apply immediately
- Returns `202 Accepted`

**Consultant Admin (managing this client) / Super Admin:**
- Can use all 4 actions: `suspend`, `reactivate`, `renew`, `extend`
- Applied **immediately** — returns `200 OK`
- Automatically approves any matching pending consultant request

**Success response — 202 (consultant request):**
```json
{
  "message": "ESGLink subscription suspend request sent to Consultant Admin.",
  "pendingRequest": {
    "action": "suspend",
    "status": "pending",
    "reason": "Invoice overdue",
    "requestedBy": "64f2a1b3c9e4f12345678901",
    "requestedAt": "2026-04-12T10:00:00.000Z"
  }
}
```

**Success response — 200 (admin direct action):**
```json
{
  "message": "ESGLink subscription suspend action completed successfully.",
  "esgLinkSubscription": {
    "subscriptionStatus": "suspended",
    "isActive": false,
    "suspensionReason": "Invoice overdue",
    "suspendedBy": "64f2a1b3c9e4f00000000001",
    "suspendedAt": "2026-04-12T10:00:00.000Z",
    "subscriptionStartDate": null,
    "subscriptionEndDate": null,
    "pendingSubscriptionRequest": null
  }
}
```

**Error responses:**

| Status | `message` | Reason |
|--------|-----------|--------|
| `400` | `"Invalid action. Use: suspend, reactivate, renew, or extend"` | Unknown action value |
| `400` | `"This client does not have the ESGLink module."` | Client `accessibleModules` missing `esg_link` |
| `400` | `"ESGLink subscription is already suspended."` | Already in that state |
| `400` | `"ESGLink subscription is already active."` | Already in that state |
| `400` | `"Cannot extend: ESGLink subscriptionEndDate is not set."` | No end date to extend from |
| `400` | `"extensionDays must be a positive number."` | Bad `extensionDays` value |
| `400` | `"There is already a pending ESGLink subscription request for this client."` | Consultant duplicate request |
| `403` | `"You are not assigned to this client."` | Consultant not assigned |
| `403` | `"Consultants can only request suspension or reactivation."` | Consultant used renew/extend |
| `403` | `"Only Consultant Admin and Super Admin can directly manage ESGLink subscriptions."` | Wrong role |
| `404` | `"Client not found."` | Invalid `clientId` |
| `500` | `"Failed to manage ESGLink subscription."` | Server error |

---

### 5.7 Review ESGLink Subscription Request

**`PATCH /api/clients/:clientId/subscription/esglink/review`**

Approves or rejects a pending ESGLink subscription request made by a consultant.

**Who can call this:** `consultant_admin` (managing this client only) or `super_admin`.

**URL param:** `clientId` — the client's business ID.

**Request body:**
```json
{
  "decision": "approve",
  "reviewComment": "Approved — invoice settled"
}
```

| Field | Type | Required | Allowed values |
|-------|------|----------|----------------|
| `decision` | string | ✅ | `approve`, `reject` |
| `reviewComment` | string | ❌ | Any string |

#### What happens on approve

| Pending action | Result |
|----------------|--------|
| `suspend` | `subscriptionStatus` → `"suspended"`, `isActive` → `false` |
| `reactivate` | `subscriptionStatus` → `"active"`, `isActive` → `true`, suspension fields cleared |

#### What happens on reject

- `subscriptionStatus` reverts to `"active"`
- Pending request recorded as `"rejected"` with `reviewedBy`, `reviewedAt`, `reviewComment`

**Success response — 200:**
```json
{
  "message": "ESGLink subscription request approved successfully.",
  "esgLinkSubscription": {
    "subscriptionStatus": "suspended",
    "pendingSubscriptionRequest": {
      "action": "suspend",
      "status": "approved",
      "reason": "Invoice overdue",
      "requestedBy": "64f2a1b3c9e4f12345678901",
      "requestedAt": "2026-04-12T10:00:00.000Z",
      "reviewedBy": "64f2a1b3c9e4f00000000001",
      "reviewedAt": "2026-04-12T11:00:00.000Z",
      "reviewComment": "Approved — invoice settled"
    }
  }
}
```

**Error responses:**

| Status | `message` | Reason |
|--------|-----------|--------|
| `400` | `"decision must be 'approve' or 'reject'."` | Invalid decision value |
| `400` | `"No pending ESGLink subscription request found."` | Nothing to review |
| `400` | `"This client has no ESGLink subscription."` | ESGLink never initialised on this client |
| `403` | `"Only Consultant Admin and Super Admin can review ESGLink subscription requests."` | Wrong role |
| `403` | `"You are not authorized to review this client's ESGLink subscription."` | `consultant_admin` not managing this client |
| `404` | `"Client not found."` | Invalid `clientId` |
| `500` | `"Server error."` | Server error |

---

### 5.8 Get ESGLink Pending Approvals

**`GET /api/clients/subscription/esglink/pending-approvals`**

Returns all clients that have a pending ESGLink subscription request waiting for review.

**Who can call this:**
- `super_admin` — sees all clients with pending ESGLink requests
- `consultant_admin` — sees only clients they manage (where `client.leadInfo.consultantAdminId === req.user._id`)

**Request body:** None. No query params needed.

**Success response — 200:**
```json
{
  "count": 2,
  "requests": [
    {
      "clientId": "Greon001",
      "companyName": "Acme Industries",
      "stage": "active",
      "status": "active",
      "esgLinkSubscriptionStatus": "pending_suspension",
      "esgLinkSubscriptionEndDate": "2026-12-31T00:00:00.000Z",
      "pendingRequest": {
        "action": "suspend",
        "status": "pending",
        "reason": "Invoice overdue",
        "requestedAt": "2026-04-12T10:00:00.000Z",
        "requestedBy": {
          "_id": "64f2a1b3c9e4f12345678901",
          "userName": "john_consultant",
          "email": "john@acme.com",
          "userType": "consultant"
        }
      }
    }
  ]
}
```

**Error responses:**

| Status | `message` | Reason |
|--------|-----------|--------|
| `403` | `"Only Consultant Admin and Super Admin can view ESGLink pending approvals."` | Wrong role |
| `500` | `"Failed to fetch ESGLink pending approvals."` | Server error |

---

## 6. Updated Existing Endpoints

### 6.1 Create Auditor — Now accepts `accessibleModules`

**`POST /api/users/auditor`** (existing endpoint)

New optional field in request body:

```json
{
  "email": "...",
  "password": "...",
  "contactNumber": "...",
  "userName": "...",
  "address": "...",
  "auditPeriod": "...",
  "auditScope": "...",
  "accessControls": { ... },
  "accessibleModules": ["esg_link"]
}
```

| `accessibleModules` value | Effect |
|--------------------------|--------|
| `["zero_carbon"]` | ZeroCarbon auditor |
| `["esg_link"]` | ESGLink auditor |
| `["zero_carbon", "esg_link"]` | Dual-module auditor |
| Omitted | Defaults to the client's current `accessibleModules` |

**Validation:** Each requested module must exist in `client.accessibleModules` AND its subscription must be active. Returns `403` otherwise.

---

### 6.2 Create Viewer — Now accepts `accessibleModules`

**`POST /api/users/viewer`** (existing endpoint)

Same new optional field as Auditor — `accessibleModules`.  
Same validation rules apply.

---

### 6.3 Update Assessment Level — Now requires role

**`PATCH /api/clients/:clientId/assessment-level`** (existing endpoint)

**BREAKING SECURITY FIX:** This endpoint previously had no role check. It now requires:
- `super_admin` (any client) OR
- `consultant_admin` who manages this specific client

Any other role (including `consultant`, `client_admin`, `employee`) will receive `403 Forbidden`.

**New error responses added:**
```json
{ "message": "Only Super Admin or Consultant Admin can update assessment levels." }
{ "message": "You are not authorized to update this client's assessment level." }
```

---

## 7. ESGLink Subscription Workflow (Full Flow)

### Full lifecycle diagram

```
[Consultant Admin adds esg_link to client via PATCH /module-access]
    ↓
esgLinkSubscription initialized: { status: "active", isActive: true }
    ↓
[Consultant Admin sets subscription dates via PATCH /subscription/esglink { action: "renew", extensionDays: 365 }]
    ↓
ESGLink users can now be created and can log in
    ↓

--- SUSPEND FLOW (initiated by consultant) ---

Consultant → PATCH /subscription/esglink { action: "suspend" }
    ↓
esgLinkSubscription.subscriptionStatus = "pending_suspension"
esgLinkSubscription.pendingSubscriptionRequest = { action: "suspend", status: "pending", ... }
    ↓
GET /subscription/esglink/pending-approvals → Consultant Admin sees pending request
    ↓
    ├── PATCH /subscription/esglink/review { decision: "approve" }
    │       ↓
    │   status = "suspended", isActive = false
    │   ESGLink users get 403 on next request
    │
    └── PATCH /subscription/esglink/review { decision: "reject" }
            ↓
        status = "active", request recorded as rejected

--- SUSPEND FLOW (initiated directly by consultant_admin/super_admin) ---

PATCH /subscription/esglink { action: "suspend" }
    ↓ (applies immediately)
status = "suspended", isActive = false
ESGLink users get 403 on next request

--- REACTIVATE ---

PATCH /subscription/esglink { action: "reactivate" }
    ↓
status = "active", isActive = true
suspension fields cleared

--- RENEW ---

PATCH /subscription/esglink { action: "renew", extensionDays: 365 }
    ↓
subscriptionStartDate = now
subscriptionEndDate = now + extensionDays
status = "active"

--- EXTEND ---

PATCH /subscription/esglink { action: "extend", extensionDays: 90 }
    ↓
subscriptionEndDate += extensionDays
(if was "expired", status = "active")

--- CRON-BASED AUTO-EXPIRY ---

Runs daily at midnight
    ↓
Finds clients where esgLinkSubscription.subscriptionEndDate <= now AND status = "active"
    ↓
    ├── daysSinceExpiry <= 30 → status = "grace_period" → email sent to client admin
    └── daysSinceExpiry > 30  → status = "expired", isActive = false
                               (ZeroCarbon users UNAFFECTED — only ESGLink access blocked)
```

### Subscription status values

| Status | What it means | ESGLink users can log in? |
|--------|--------------|--------------------------|
| `active` | Subscription current | ✅ Yes |
| `grace_period` | Expired but within 30-day grace | ✅ Yes (with warning) |
| `pending_suspension` | Consultant requested suspension, awaiting review | ✅ Yes (not yet suspended) |
| `suspended` | Manually suspended by admin | ❌ No — 403 |
| `expired` | Past end date, grace period over | ❌ No — 403 |

---

## 8. Auth Middleware — What Changes for ESGLink Users

When an ESGLink user (contributor/reviewer/approver) makes any authenticated request:

1. JWT is validated as before.
2. `req.user.accessibleModules` is read (defaults to `['zero_carbon']` if missing).
3. For each module in `accessibleModules`:
   - `zero_carbon` → check `client.accountDetails.subscriptionStatus` is `active` or `grace_period`
   - `esg_link` → check `client.accountDetails.esgLinkSubscription.subscriptionStatus` is `active` or `grace_period`
4. If ANY module subscription is not active → **403**.

**Sandbox clients bypass all subscription checks** (unchanged behaviour).

**Frontend implication:** If an ESGLink user gets a `403` mid-session (not on login), it likely means their ESGLink subscription was suspended or expired. Show a specific message like "Your ESGLink subscription is not active. Contact your administrator."

---

## 9. Model Field Reference

### User — new fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `accessibleModules` | `string[]` | `['zero_carbon']` | Which modules this user can access. Enum: `zero_carbon`, `esg_link` |

### User — new `userType` values

| Value | Role |
|-------|------|
| `contributor` | ESGLink data contributor |
| `reviewer` | ESGLink reviewer |
| `approver` | ESGLink approver |

### Client — new root-level fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `accessibleModules` | `string[]` | `['zero_carbon']` | Which modules this client has licensed |

### Client — new `accountDetails.esgLinkSubscription` sub-document

| Field | Type | Description |
|-------|------|-------------|
| `subscriptionStartDate` | Date | When the ESGLink subscription started |
| `subscriptionEndDate` | Date | When the ESGLink subscription expires |
| `subscriptionStatus` | string | `active` \| `suspended` \| `expired` \| `grace_period` \| `pending_suspension` |
| `subscriptionType` | string | Optional subscription plan name |
| `isActive` | boolean | Whether ESGLink subscription is currently active |
| `suspensionReason` | string | Reason for suspension (if suspended) |
| `suspendedBy` | ObjectId | User who suspended (if suspended) |
| `suspendedAt` | Date | When suspension happened |
| `pendingSubscriptionRequest` | object | See below |

### `pendingSubscriptionRequest` fields (inside `esgLinkSubscription`)

| Field | Type | Description |
|-------|------|-------------|
| `action` | string | `suspend` \| `reactivate` \| `renew` \| `extend` |
| `status` | string | `pending` \| `approved` \| `rejected` |
| `reason` | string | Text reason provided by requester |
| `requestedBy` | ObjectId → User | Who made the request |
| `requestedAt` | Date | When request was made |
| `reviewedBy` | ObjectId → User | Who reviewed it |
| `reviewedAt` | Date | When it was reviewed |
| `reviewComment` | string | Admin comment on the review |

---

## 10. Error Reference

### Common HTTP status codes used

| Code | Meaning |
|------|---------|
| `200` | Success |
| `201` | Created |
| `202` | Accepted (for pending requests — action queued, not applied yet) |
| `400` | Bad request — missing/invalid input |
| `403` | Forbidden — wrong role, missing module, inactive subscription |
| `404` | Not found — user/client doesn't exist |
| `409` | Conflict — duplicate email or userName |
| `429` | Too many requests — quota exceeded |
| `500` | Internal server error |

### Module-related 403s from auth middleware

These are returned on any authenticated request when a subscription is inactive:

```json
{ "message": "Your zero_carbon subscription is not active" }
{ "message": "Your esg_link subscription is not active" }
```

---

## 11. Migration Note for Existing Data

Existing users and clients in the database may not have the `accessibleModules` field. The backend schema default (`['zero_carbon']`) handles this transparently for new requests. However, a migration script is provided to explicitly backfill the field:

```bash
# Dry run — shows what would be updated without writing anything
node migrations/migrate_module_access.js

# Apply — writes the changes
node migrations/migrate_module_access.js --apply
```

**Frontend does not need to do anything** — the backend handles missing `accessibleModules` gracefully by defaulting to `['zero_carbon']`.

---

## 12. UI Checklist for Frontend Team

### Login flow

- [ ] After login, read `user.accessibleModules` from response
- [ ] If `['zero_carbon']` → show only ZeroCarbon UI
- [ ] If `['esg_link']` → show only ESGLink UI
- [ ] If both → show module switcher or combined navigation

### Client Admin — ESGLink user management

- [ ] Check `client.accessibleModules` includes `esg_link` before showing ESGLink user creation UI
- [ ] Check `client.accountDetails.esgLinkSubscription.subscriptionStatus` is `active` or `grace_period`
- [ ] Show contributor/reviewer/approver creation forms when above conditions are met
- [ ] Show quota remaining for each type (from quota status endpoint)
- [ ] Handle `429` — show "Quota exceeded" message

### Consultant Admin — module access management

- [ ] Add a "Manage Modules" section on client detail page
- [ ] `PATCH /api/clients/:clientId/module-access` to grant `esg_link`
- [ ] After granting, prompt to set ESGLink subscription dates
- [ ] `PATCH /api/clients/:clientId/subscription/esglink { action: "renew", extensionDays: 365 }`

### Consultant — subscription request

- [ ] Consultant can request `suspend` or `reactivate` only
- [ ] Show pending state (`subscriptionStatus === "pending_suspension"`) visually
- [ ] Disable duplicate request when one is already pending
- [ ] Backend returns `202` for requests (not `200`) — handle this distinction

### Consultant Admin — subscription approval

- [ ] Add notification badge for pending ESGLink approvals
- [ ] `GET /api/clients/subscription/esglink/pending-approvals` to list requests
- [ ] Approve or reject via `PATCH /api/clients/:clientId/subscription/esglink/review`

### Assessment level — role gate

- [ ] `PATCH /api/clients/:clientId/assessment-level` now returns `403` for non-admin roles
- [ ] Only show this UI control to `super_admin` and `consultant_admin`

### Mid-session subscription expiry handling

- [ ] If any API returns `403` with message `"Your esg_link subscription is not active"` → show ESGLink-specific subscription warning
- [ ] Do not log user out — their ZeroCarbon access may still be valid
- [ ] Redirect to the appropriate module or show a module-selection screen

---

*Document generated after ESGLink module implementation. All field names, endpoint paths, and status codes are directly derived from the running backend code.*
