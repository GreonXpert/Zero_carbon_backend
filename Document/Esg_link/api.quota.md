# ESGLink Quota System — API Reference

## Overview

The quota system controls how many users of each type a consultant can create for a given client. Quotas are stored in `ConsultantClientQuota`, keyed by `(clientId, consultantId)`. All ESGLink user types (`contributor`, `reviewer`, `approver`) are fully integrated into this system.

---

## User Type → Quota Key Mapping

| `userType` | Quota Key | Module |
|---|---|---|
| `client_employee_head` | `employeeHead` | ZeroCarbon |
| `employee` | `employee` | ZeroCarbon |
| `viewer` | `viewer` | Multi-module |
| `auditor` | `auditor` | Multi-module |
| `contributor` | `contributor` | ESGLink |
| `reviewer` | `reviewer` | ESGLink |
| `approver` | `approver` | ESGLink |

---

## Quota Value Convention

| Value | Meaning |
|---|---|
| `null` | Unlimited — no cap enforced |
| `0` | Blocked — creation denied |
| `N > 0` | Hard cap — at most N users of this type |

---

## Endpoints

### GET — Resource Quota Status

```
GET /api/quota/clients/:clientId/quota
Authorization: Bearer <token>
Roles: super_admin | consultant_admin | consultant | client_admin (read-only)
```

Returns flowchart/resource limits + all userType quota status (including ESGLink types).

**Response — 200:**

```json
{
  "success": true,
  "data": {
    "clientId": "CLIENT_001",
    "consultantId": "64f1...",
    "limits": {
      "flowchartNodes": 100,
      "reductionProjects": null
    },
    "userTypeQuotas": {
      "contributor": { "maxCount": 5, "usedCount": 2, "concurrentLoginLimit": null },
      "reviewer":    { "maxCount": 2, "usedCount": 1, "concurrentLoginLimit": 1 },
      "approver":    { "maxCount": 1, "usedCount": 0, "concurrentLoginLimit": null }
    },
    "userTypeStatus": {
      "contributor": { "maxCount": 5, "usedCount": 2, "remaining": 3, "canCreate": true, "unlimited": false },
      "reviewer":    { "maxCount": 2, "usedCount": 1, "remaining": 1, "canCreate": true, "unlimited": false },
      "approver":    { "maxCount": 1, "usedCount": 0, "remaining": 1, "canCreate": true, "unlimited": false }
    }
  }
}
```

---

### GET — User Type Quota Status

```
GET /api/quota/clients/:clientId/quota/user-types
Authorization: Bearer <token>
Roles: super_admin | consultant_admin | consultant | client_admin (read-only)
```

Returns only the userType quota section (all 7 types).

**Response — 200:**

```json
{
  "success": true,
  "data": {
    "clientId": "CLIENT_001",
    "consultantId": "64f1...",
    "userTypeStatus": {
      "employeeHead": { "maxCount": 1,  "usedCount": 1, "remaining": 0, "canCreate": false },
      "employee":     { "maxCount": 50, "usedCount": 12, "remaining": 38, "canCreate": true },
      "viewer":       { "maxCount": 5,  "usedCount": 2, "remaining": 3, "canCreate": true },
      "auditor":      { "maxCount": 2,  "usedCount": 0, "remaining": 2, "canCreate": true },
      "contributor":  { "maxCount": 5,  "usedCount": 2, "remaining": 3, "canCreate": true },
      "reviewer":     { "maxCount": 2,  "usedCount": 1, "remaining": 1, "canCreate": true },
      "approver":     { "maxCount": 1,  "usedCount": 0, "remaining": 1, "canCreate": true }
    }
  }
}
```

---

### PATCH — Update User Type Quotas

```
PATCH /api/quota/clients/:clientId/quota/user-types
Authorization: Bearer <token>
Roles: super_admin | consultant_admin
```

**Body:**

```json
{
  "userTypeQuotas": {
    "contributor": { "maxCount": 10, "concurrentLoginLimit": 2 },
    "reviewer":    { "maxCount": 3 },
    "approver":    { "maxCount": null }
  },
  "notes": "ESGLink team expansion Q1"
}
```

> Only `maxCount` and `concurrentLoginLimit` are editable. `usedCount` is managed atomically by the system.

**Success Response — 200:**

```json
{
  "success": true,
  "message": "User type quotas updated successfully.",
  "data": { ... }
}
```

---

### POST — Reset User Type Quotas

```
POST /api/quota/clients/:clientId/quota/user-types/reset
Authorization: Bearer <token>
Roles: super_admin only
```

Resets `maxCount` to `1` and `concurrentLoginLimit` to `null` for **all** user types. `usedCount` is **NOT** reset — it reflects actual existing users.

**Response — 200:**

```json
{
  "success": true,
  "message": "User type quotas reset to defaults (maxCount=1, concurrentLoginLimit=unlimited).",
  "data": { ... }
}
```

---

### POST — Sync Used Counts

```
POST /api/quota/clients/:clientId/quota/user-types/sync-counts
Authorization: Bearer <token>
Roles: super_admin | consultant_admin
```

Recalculates `usedCount` from live DB counts for all 7 user types (including ESGLink). Use after bulk operations, migrations, or manual corrections.

**Response — 200:**

```json
{
  "success": true,
  "message": "usedCounts synced from live user counts.",
  "synced": {
    "employeeHead": 1,
    "employee": 12,
    "viewer": 2,
    "auditor": 0,
    "contributor": 3,
    "reviewer": 1,
    "approver": 1
  },
  "data": { ... }
}
```

---

## Error Responses

### Quota Exceeded — 429

Returned when `createContributor` / `createReviewer` / `createApprover` is called and the quota is full:

```json
{
  "message": "Contributor quota exceeded for this client.",
  "quota": {
    "limit": 5,
    "used": 5,
    "remaining": 0
  }
}
```

### Invalid Quota Key — 400

```json
{
  "success": false,
  "message": "Invalid userType quota keys: unknownKey. Allowed: employeeHead, employee, viewer, auditor, contributor, reviewer, approver"
}
```

### No Consultant Assigned — 400

```json
{
  "success": false,
  "message": "No consultant is currently assigned to this client."
}
```

---

## Concurrent Login Limit

`concurrentLoginLimit` controls how many active sessions a user of that type can have simultaneously. Checked at login (OTP verification step).

| Value | Behaviour |
|---|---|
| `null` | Unlimited sessions |
| `0` | Treated as unlimited (legacy) |
| `N > 0` | Max N active sessions |

**Error when limit reached — 429:**

```json
{
  "success": false,
  "message": "Concurrent session limit reached (2). Please log out from another device first."
}
```
