# Formula API — Common Module

## Overview

The Formula module is a reusable, module-aware system for managing calculation formulas across all product modules (`zero_carbon`, `esg_link`, and future modules). Formulas contain mathematical expressions with named variables and are scoped to a specific client, team, or globally.

**Base URL:** `/api/formulas`

---

## Module Purpose

| Module | Formula Usage |
|--------|--------------|
| `zero_carbon` | M2/M3 reduction project calculations |
| `esg_link` | ESG metric computations (label enforced = name) |
| Future | Any new module can register its own `moduleKey` |

---

## Routes

| Method | Path | Description | Roles |
|--------|------|-------------|-------|
| `POST` | `/api/formulas` | Create a formula | consultant, consultant_admin, super_admin |
| `GET` | `/api/formulas` | List formulas | all authenticated |
| `GET` | `/api/formulas/:formulaId` | Get a formula by ID | all authenticated |
| `PUT` | `/api/formulas/:formulaId` | Update a formula | consultant, consultant_admin, super_admin |
| `DELETE` | `/api/formulas/:formulaId/:mode?` | Delete / request deletion | consultant, consultant_admin, super_admin |
| `GET` | `/api/formulas/delete-requests` | List delete requests | consultant, consultant_admin, super_admin |
| `GET` | `/api/formulas/delete-requests/filter/query` | Filter delete requests | consultant, consultant_admin, super_admin |
| `GET` | `/api/formulas/delete-requests/:requestId` | Get a delete request | consultant, consultant_admin, super_admin |
| `POST` | `/api/formulas/delete-requests/:requestId/approve` | Approve delete request | super_admin, consultant_admin |
| `POST` | `/api/formulas/delete-requests/:requestId/reject` | Reject delete request | super_admin, consultant_admin |
| `POST` | `/api/formulas/attach/:clientId/:projectId` | Attach formula to Reduction project (M2) | consultant, consultant_admin, super_admin |

---

## Request Payloads

### POST `/api/formulas` — Create Formula

```json
{
  "name": "Carbon Reduction Formula",
  "label": "Carbon Reduction Formula",
  "description": "Calculates net carbon reduction for M2 methodology",
  "link": "https://docs.example.com/formulas/carbon",
  "unit": "tCO2e",
  "expression": "(A * B) - sqrt(C) / D",
  "variables": [
    {
      "name": "A",
      "label": "Activity Data",
      "unit": "kWh",
      "updatePolicy": "manual",
      "defaultValue": 0
    },
    {
      "name": "B",
      "label": "Emission Factor",
      "unit": "kgCO2/kWh",
      "updatePolicy": "annual_automatic",
      "defaultValue": 0.233
    }
  ],
  "version": 1,
  "moduleKey": "zero_carbon",
  "scopeType": "client",
  "clientId": "Greon001"
}
```

**Required fields:** `name`, `expression`, `moduleKey`, `scopeType`
**Conditionally required:** `clientId` when `scopeType = "client"`

**Transitional (deprecated):** `clientIds: ["Greon001"]` is still accepted for backward compatibility. The first element is used as `clientId`. Switch to `clientId` (string) ASAP.

---

### PUT `/api/formulas/:formulaId` — Update Formula

All fields are optional. Only provided fields are updated.

```json
{
  "name": "Updated Formula Name",
  "expression": "(A * B * 0.85) - C",
  "clientId": "Greon001",
  "variables": [...],
  "version": 2
}
```

**Note:** `addClientIds` / `removeClientIds` from the old API are removed. Each formula has a single `clientId`. To "add" a client, create a new formula for that client.

---

### DELETE `/api/formulas/:formulaId/:mode?` — Delete Formula

| Role | Behavior |
|------|---------|
| `consultant` | Creates a delete request (pending approval) |
| `consultant_admin` | Soft-deletes immediately (or hard with `?mode=hard`) |
| `super_admin` | Soft-deletes immediately (or hard with `?mode=hard`) |

Optional body for consultant:
```json
{ "reason": "Formula is no longer needed after Q2 update" }
```

Hard delete is blocked if the formula is attached to any active Reduction project.

---

### POST `/api/formulas/attach/:clientId/:projectId` — Attach to Reduction

```json
{
  "formulaId": "64ab12cd3ef45678901234ab",
  "version": 1,
  "variableKinds": {
    "A": "realtime",
    "B": "frozen",
    "C": "manual"
  },
  "frozenValues": {
    "B": 0.233
  }
}
```

- `variableKinds`: Every variable in the formula must have a declared role
  - `frozen`: Fixed value, never changes
  - `realtime`: Provided by API/IoT on each data entry
  - `manual`: Entered manually on each data entry
- `frozenValues`: Required for all variables with role `frozen`

---

## Query Parameters

### GET `/api/formulas` — List Formulas

| Param | Type | Description |
|-------|------|-------------|
| `moduleKey` | string | Filter by module (`zero_carbon` \| `esg_link`) |
| `clientId` | string | Filter by client (super_admin / consultant_admin only) |

### GET `/api/formulas/delete-requests/filter/query`

| Param | Type | Description |
|-------|------|-------------|
| `status` | string | `pending` \| `approved` \| `rejected` |
| `formulaId` | string | Filter by formula ID |
| `requestedBy` | string | Filter by requesting user ID |
| `clientId` | string | Filter by client (looks up formulas for that client) |
| `fromDate` | ISO date | Requests from this date |
| `toDate` | ISO date | Requests to this date |

---

## Response Shape

### Formula Object

```json
{
  "success": true,
  "data": {
    "_id": "64ab12cd3ef45678901234ab",
    "name": "Carbon Reduction Formula",
    "label": "Carbon Reduction Formula",
    "description": "Calculates net carbon reduction for M2 methodology",
    "link": "https://docs.example.com/formulas/carbon",
    "unit": "tCO2e",
    "expression": "(A * B) - sqrt(C) / D",
    "variables": [...],
    "version": 1,
    "moduleKey": "zero_carbon",
    "scopeType": "client",
    "clientId": "Greon001",
    "createdBy": "64abc...",
    "createdByRole": "consultant",
    "sourceFormulaId": null,
    "isDeleted": false,
    "createdAt": "2025-01-15T10:00:00.000Z",
    "updatedAt": "2025-01-15T10:00:00.000Z"
  }
}
```

### Delete Request Object

```json
{
  "success": true,
  "data": {
    "_id": "64ab12cd...",
    "formulaId": "64ab12cd3ef45678901234ab",
    "requestedBy": { "_id": "...", "userName": "John Doe", "email": "john@example.com" },
    "requestedAt": "2025-01-15T10:00:00.000Z",
    "status": "pending",
    "approvedBy": null,
    "approvedAt": null,
    "reason": "No longer needed"
  }
}
```

---

## Validation Rules

1. `name` is required
2. `expression` is required and must be a valid `expr-eval` expression
3. `moduleKey` is required, must be `zero_carbon` or `esg_link`
4. `scopeType` is required, must be `client`, `team`, or `global`
5. `clientId` is required when `scopeType = "client"`
6. For `moduleKey = "esg_link"`: `label` is auto-set to equal `name` (regardless of what is sent)
7. Expression variable names must match `variables[].name` values

---

## Access Control by Role

| Role | Create | Read | Update | Delete | Delete Requests |
|------|--------|------|--------|--------|-----------------|
| `super_admin` | ✅ All | ✅ All | ✅ All | ✅ Direct (soft/hard) | ✅ All |
| `consultant_admin` | ✅ Team clients | ✅ Team formulas | ✅ Team formulas | ✅ Direct (soft/hard) | ✅ Team requests |
| `consultant` | ✅ Assigned clients | ✅ Assigned clients + team | ✅ Assigned clients | ⏳ Submit request | ✅ Own requests only |
| `client_admin` | ❌ | ✅ Own client only | ❌ | ❌ | ❌ |
| `auditor` | ❌ | ✅ Own client only | ❌ | ❌ | ❌ |

**Module restriction:** Users can only access formulas for modules in their `accessibleModules` list.

---

## moduleKey Behavior

- `zero_carbon`: Standard behavior. Used for M2/M3 reduction project formulas.
- `esg_link`: `label` field is auto-synchronized to equal `name` on create and update.
- Future modules: Add new enum value to `moduleKey` in `Formula.js` schema.

Filtering by moduleKey:
```
GET /api/formulas?moduleKey=zero_carbon
GET /api/formulas?moduleKey=esg_link
```

---

## scopeType Behavior

| scopeType | Description | clientId Required |
|-----------|-------------|------------------|
| `client` | Formula belongs to one specific client | ✅ Yes |
| `team` | Formula shared within consultant team | ❌ No (future) |
| `global` | Formula available to all clients | ❌ No (future) |

**Currently active:** Only `client` scope is used in business logic. `team` and `global` are schema-ready for future use.

---

## ESGLink label = name Rule

For any formula with `moduleKey: "esg_link"`:
- On **create**: `label` is automatically set to the value of `name` regardless of what is sent
- On **update**: If `name` changes, `label` is updated to match automatically
- This is enforced in the service layer (`coerceEsgLinkLabel` in `formulaValidation.js`)

Example: If you send `{ name: "GHG Intensity", label: "Custom Label", moduleKey: "esg_link" }`, the stored document will have `label: "GHG Intensity"`.

---

## Backward Compatibility Notes

| Old Behavior | New Behavior | Notes |
|--------------|-------------|-------|
| `clientIds: ["Greon001"]` | `clientId: "Greon001"` | Old `clientIds[]` still accepted (first element used); log warning emitted |
| `addClientIds: ["Greon002"]` | Not supported — create new formula | Each formula is per-client |
| `removeClientIds: [...]` | Not supported — soft delete formula | |
| Model name: `ReductionFormula` | `Formula` | Old reduction models re-export transparently |
| Route: `/api/formulas` | `/api/formulas` | Unchanged — no URL change |

---

## Error Response Examples

```json
// 400 Bad Request — validation
{ "success": false, "message": "moduleKey must be one of: zero_carbon, esg_link" }
{ "success": false, "message": "clientId is required when scopeType is \"client\"" }
{ "success": false, "message": "Invalid expression: unexpected token '+'" }

// 403 Forbidden
{ "success": false, "message": "Forbidden" }
{ "success": false, "message": "This formula does not belong to your client." }

// 404 Not Found
{ "success": false, "message": "Formula not found" }
{ "success": false, "message": "Request not found or already processed" }

// 409 Conflict — hard delete blocked
{ "success": false, "message": "Cannot hard delete: formula is attached to active reduction projects." }

// 500 Internal Server Error
{ "success": false, "message": "Failed to create formula", "error": "..." }
```

---

## Migration Notes

Old formula documents used `clientIds: [String]` (array). The migration script at:
`src/modules/common/formula/migrations/migrateFormulas.js`

migrates them to `clientId: String` as follows:
- Single-client formulas: patched in-place (same `_id` preserved)
- Multi-client formulas: original patched for first client; new clone documents created for additional clients with `sourceFormulaId` pointing to the original
- Reduction project references are automatically fixed in the migration's second pass

---

## Sample Examples

### Create a ZeroCarbon Formula
```http
POST /api/formulas
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "M2 Net Reduction",
  "expression": "A * B",
  "variables": [
    { "name": "A", "label": "Activity Data", "unit": "kWh", "updatePolicy": "manual" },
    { "name": "B", "label": "Emission Factor", "unit": "kgCO2/kWh", "updatePolicy": "annual_automatic" }
  ],
  "moduleKey": "zero_carbon",
  "scopeType": "client",
  "clientId": "Greon001"
}
```

### Create an ESGLink Formula (label auto-synced)
```http
POST /api/formulas
Authorization: Bearer <token>

{
  "name": "GHG Intensity",
  "expression": "E / R",
  "variables": [
    { "name": "E", "label": "Total Emissions", "unit": "tCO2e" },
    { "name": "R", "label": "Revenue", "unit": "USD" }
  ],
  "moduleKey": "esg_link",
  "scopeType": "client",
  "clientId": "Greon001"
}
// Response: label = "GHG Intensity" (auto-set equal to name)
```

### List Formulas with Filter
```http
GET /api/formulas?moduleKey=zero_carbon&clientId=Greon001
Authorization: Bearer <token>
```

### Soft Delete (admin)
```http
DELETE /api/formulas/64ab12cd3ef45678901234ab
Authorization: Bearer <admin-token>
```

### Hard Delete (admin, if not attached)
```http
DELETE /api/formulas/64ab12cd3ef45678901234ab/hard
Authorization: Bearer <admin-token>
```

### Consultant Requests Deletion
```http
DELETE /api/formulas/64ab12cd3ef45678901234ab
Authorization: Bearer <consultant-token>

{ "reason": "Formula outdated after methodology update" }
```

### Approve Delete Request
```http
POST /api/formulas/delete-requests/64req.../approve
Authorization: Bearer <admin-token>
```
