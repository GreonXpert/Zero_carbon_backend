# ESGLink Core — Step 2: Metric Library API Documentation

**Version:** 1.0  
**Base URL:** `/api/esglink/core`  
**Authentication:** Bearer JWT (all endpoints)  
**Module Gate:** Active `esg_link` subscription required on all routes

---

## Overview

The Metric Library is a platform-level catalog of ESG metrics.  
It supports two kinds of metrics:

| Kind | `isGlobal` | Created by | Published on |
|------|:----------:|------------|-------------|
| **Global metric** | `true` | `super_admin`, `consultant_admin` | Explicit `PATCH /publish` call |
| **Client-scoped custom metric** | `false` | `super_admin`, `consultant_admin`, assigned `consultant` | Immediately on creation |

Metrics are identified by auto-generated codes following the ESGLink coding scheme:  
`ESG-{E|S|G}-{SUBCATEGORY_CODE}-{NNN}` — e.g. `ESG-E-EN-001`.

> **Step 3 note:** Mapping metrics onto `esgLinkBoundary` nodes and assigning  
> contributor / reviewer / approver roles is implemented in **Step 3**, not here.

---

## Role & Permission Matrix

| Action | super_admin | consultant_admin | consultant | client_admin | contributor | reviewer | approver |
|--------|:-----------:|:----------------:|:----------:|:------------:|:-----------:|:--------:|:--------:|
| Create global metric | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Update global metric | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Publish global metric | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Retire global metric | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Delete metric (soft) | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Create client-scoped metric | ✓ | ✓ | ✓ (assigned client) | ✗ | ✗ | ✗ | ✗ |
| Update client-scoped metric | ✓ | ✓ | ✓ (assigned client) | ✗ | ✗ | ✗ | ✗ |
| Retire client-scoped metric | ✓ | ✓ | ✓ (assigned client) | ✗ | ✗ | ✗ | ✗ |
| List global metrics (all statuses) | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| List global metrics (published only) | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| List client-scoped metrics | ✓ | ✓ (own clients) | ✓ (assigned) | ✓ (own client) | ✗ | ✗ | ✗ |
| List available metrics for mapping | ✓ | ✓ | ✓ (assigned) | ✗ | ✗ | ✗ | ✗ |
| Get metric by ID | scoped | scoped | scoped | scoped | ✗ | ✗ | ✗ |

---

## Endpoint Index

| # | Method | Path | Handler |
|---|--------|------|---------|
| 1 | POST | `/api/esglink/core/metrics` | Create global metric |
| 2 | GET | `/api/esglink/core/metrics` | List global metrics |
| 3 | GET | `/api/esglink/core/metrics/:metricId` | Get metric by ID |
| 4 | PUT | `/api/esglink/core/metrics/:metricId` | Update metric |
| 5 | PATCH | `/api/esglink/core/metrics/:metricId/publish` | Publish metric |
| 6 | PATCH | `/api/esglink/core/metrics/:metricId/retire` | Retire metric |
| 7 | DELETE | `/api/esglink/core/metrics/:metricId` | Soft-delete metric |
| 8 | POST | `/api/esglink/core/:clientId/metrics` | Create client-scoped metric |
| 9 | GET | `/api/esglink/core/:clientId/metrics` | List client-scoped metrics |
| 10 | GET | `/api/esglink/core/:clientId/metrics/available` | List available metrics for mapping |

---

## Subcategory Code Register

Valid `subcategoryCode` values per `esgCategory`:

| esgCategory | Valid subcategoryCode values |
|-------------|------------------------------|
| `E` | `EN`, `GH`, `WA`, `WS`, `BD`, `AC` |
| `S` | `EW`, `OHS`, `DI`, `TN`, `HR`, `SC`, `SH`, `CSR`, `CS` |
| `G` | `ET`, `GB`, `CP`, `PP`, `OP` |

---

## Endpoints

---

### 1. Create Global Metric

**POST** `/api/esglink/core/metrics`

**Auth:** Bearer JWT  
**Roles:** `super_admin`, `consultant_admin`

Creates a new global (platform-level) metric in `draft` state.  
`metricCode` is auto-generated as `ESG-{esgCategory}-{subcategoryCode}-{NNN}`.

#### Request Body

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `metricName` | String | ✓ | Human-readable metric name |
| `esgCategory` | String | ✓ | `E` \| `S` \| `G` |
| `subcategoryCode` | String | ✓ | Must match register for esgCategory |
| `metricType` | String | ✓ | `raw` \| `derived` \| `intensity` \| `client_defined` |
| `metricDescription` | String | — | Optional description |
| `primaryUnit` | String | — | e.g. `GJ`, `tCO2e`, `%` |
| `allowedUnits` | String[] | — | Optional alternative units |
| `dataType` | String | — | `number`\|`text`\|`boolean`\|`enum`\|`date`\|`mixed` (default: `number`) |
| `formulaId` | ObjectId | ✓ if `derived`/`intensity` | ID of ReductionFormula |
| `isBrsrCore` | Boolean | — | BRSR core flag (default: `false`) |
| `regulatorySourceRef` | String | — | e.g. `BRSR-C-P6-E-001` |
| `notesForUi` | String | — | Internal UI hint |

```json
{
  "metricName": "Total Energy Consumption",
  "metricDescription": "Total energy consumed across all facilities",
  "esgCategory": "E",
  "subcategoryCode": "EN",
  "metricType": "raw",
  "primaryUnit": "GJ",
  "allowedUnits": ["kWh", "MJ", "GJ"],
  "dataType": "number",
  "isBrsrCore": true,
  "regulatorySourceRef": "BRSR-C-P6-E-001"
}
```

#### Success Response — 201

```json
{
  "message": "Global metric created successfully",
  "metric": {
    "_id": "6650a1b2c3d4e5f678901234",
    "metricCode": "ESG-E-EN-001",
    "metricName": "Total Energy Consumption",
    "esgCategory": "E",
    "subcategoryCode": "EN",
    "metricType": "raw",
    "publishedStatus": "draft",
    "version": 1,
    "isGlobal": true,
    "createdAt": "2026-04-16T10:00:00.000Z"
  }
}
```

#### Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 400 | `MISSING_REQUIRED_FIELDS` | metricName / esgCategory / subcategoryCode / metricType missing |
| 400 | `INVALID_SUBCATEGORY` | subcategoryCode not valid for esgCategory |
| 400 | `FORMULA_REQUIRED` | formulaId missing when metricType is derived/intensity |
| 400 | `INVALID_FORMULA` | formulaId not found or deleted |
| 403 | — | Role not super_admin or consultant_admin |

---

### 2. List Global Metrics

**GET** `/api/esglink/core/metrics`

**Auth:** Bearer JWT  
**Roles:** All authenticated `esg_link` users (status filter varies by role)

Returns paginated list of global metrics.  
`super_admin` / `consultant_admin` can filter by any `publishedStatus`.  
All other roles see only `publishedStatus: published`.

#### Query Parameters

| Param | Type | Description |
|-------|------|-------------|
| `esgCategory` | String | Filter by `E` \| `S` \| `G` |
| `subcategoryCode` | String | Filter by subcategory |
| `metricType` | String | Filter by `raw` \| `derived` \| `intensity` \| `client_defined` |
| `publishedStatus` | String | `draft`\|`published`\|`retired` — admin only (non-admins locked to `published`) |
| `page` | Number | Page number (default: 1) |
| `limit` | Number | Results per page (default: 20, max: 100) |

#### Success Response — 200

```json
{
  "total": 42,
  "page": 1,
  "limit": 20,
  "metrics": [
    {
      "_id": "6650a1b2c3d4e5f678901234",
      "metricCode": "ESG-E-EN-001",
      "metricName": "Total Energy Consumption",
      "esgCategory": "E",
      "subcategoryCode": "EN",
      "metricType": "raw",
      "publishedStatus": "published",
      "primaryUnit": "GJ",
      "version": 1,
      "isGlobal": true,
      "createdAt": "2026-04-16T10:00:00.000Z"
    }
  ]
}
```

---

### 3. Get Metric by ID

**GET** `/api/esglink/core/metrics/:metricId`

**Auth:** Bearer JWT  
**Roles:** `super_admin`, `consultant_admin`, `consultant` (assigned), `client_admin` (own client for client-scoped)

Fetches a single metric. For `derived` / `intensity` metrics with a `formulaId`, the formula is populated in the response.

#### URL Parameters

| Param | Description |
|-------|-------------|
| `metricId` | MongoDB ObjectId of the metric |

#### Success Response — 200

```json
{
  "metric": {
    "_id": "6650a1b2c3d4e5f678901234",
    "metricCode": "ESG-E-GH-003",
    "metricName": "GHG Intensity per Revenue",
    "esgCategory": "E",
    "subcategoryCode": "GH",
    "metricType": "intensity",
    "isGlobal": true,
    "publishedStatus": "published",
    "primaryUnit": "tCO2e/INR Cr",
    "version": 1,
    "formulaId": "6650a2c3d4e5f67890123456",
    "formula": {
      "_id": "6650a2c3d4e5f67890123456",
      "name": "GHG Intensity Formula",
      "expression": "(A + B) / C",
      "variables": [
        { "name": "A", "label": "Scope 1 Emissions", "unit": "tCO2e" },
        { "name": "B", "label": "Scope 2 Emissions", "unit": "tCO2e" },
        { "name": "C", "label": "Turnover", "unit": "INR Cr" }
      ]
    },
    "createdAt": "2026-04-16T10:00:00.000Z"
  }
}
```

> **Note:** `formula.variables` lists the variable definitions from the formula model.  
> Variable mode mapping (frozen / realtime / manual) is implemented in **Step 3**.

#### Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_ID` | metricId is not a valid ObjectId |
| 403 | — | User does not have access to this client-scoped metric |
| 404 | `METRIC_NOT_FOUND` | Metric not found or deleted |

---

### 4. Update Metric

**PUT** `/api/esglink/core/metrics/:metricId`

**Auth:** Bearer JWT  
**Roles:** Global → `super_admin`, `consultant_admin`; Client-scoped → + assigned `consultant`

Updates allowed fields on a metric. Definition-level changes bump `version`.  
Cannot update retired metrics. `metricCode`, `esgCategory`, `subcategoryCode`, `metricType`, `isGlobal`, `clientId` are immutable.

#### Updatable Fields

| Field | Version bump? | Notes |
|-------|:------------:|-------|
| `metricName` | ✓ | |
| `metricDescription` | ✓ | |
| `primaryUnit` | ✓ | |
| `allowedUnits` | ✓ | |
| `dataType` | ✓ | |
| `formulaId` | ✓ | Triggers `formula_ref_changed` subAction in audit log |
| `isBrsrCore` | ✗ | Admin metadata only |
| `regulatorySourceRef` | ✗ | Admin metadata only |
| `notesForUi` | ✗ | Admin metadata only |

#### Request Body

```json
{
  "metricName": "Total Energy Consumption (Updated)",
  "primaryUnit": "MJ",
  "allowedUnits": ["GJ", "kWh", "MJ"]
}
```

#### Success Response — 200

```json
{
  "message": "Metric updated successfully",
  "metric": {
    "_id": "6650a1b2c3d4e5f678901234",
    "metricCode": "ESG-E-EN-001",
    "metricName": "Total Energy Consumption (Updated)",
    "publishedStatus": "draft",
    "version": 2,
    "updatedAt": "2026-04-16T11:00:00.000Z"
  }
}
```

#### Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 400 | `METRIC_RETIRED` | Cannot update a retired metric |
| 400 | `NO_UPDATE_FIELDS` | No updatable fields in request body |
| 400 | `INVALID_FORMULA` | formulaId not found or deleted |
| 403 | — | Permission denied |
| 404 | `METRIC_NOT_FOUND` | Metric not found or deleted |

---

### 5. Publish Metric

**PATCH** `/api/esglink/core/metrics/:metricId/publish`

**Auth:** Bearer JWT  
**Roles:** `super_admin`, `consultant_admin`

Transitions a global metric from `draft` → `published`.  
Only valid for global metrics (client-scoped metrics are auto-published on creation).

#### Success Response — 200

```json
{
  "message": "Metric published successfully",
  "metric": {
    "_id": "6650a1b2c3d4e5f678901234",
    "metricCode": "ESG-E-EN-001",
    "metricName": "Total Energy Consumption",
    "publishedStatus": "published",
    "publishedAt": "2026-04-16T12:00:00.000Z"
  }
}
```

#### Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_OPERATION` | Metric is client-scoped (not global) |
| 400 | `INVALID_STATUS_TRANSITION` | Metric is already published or retired |
| 403 | — | Role not super_admin or consultant_admin |
| 404 | `METRIC_NOT_FOUND` | Metric not found or deleted |

---

### 6. Retire Metric

**PATCH** `/api/esglink/core/metrics/:metricId/retire`

**Auth:** Bearer JWT  
**Roles:** Global → `super_admin`, `consultant_admin`; Client-scoped → + assigned `consultant`

Transitions a metric from `published` → `retired`.  
Retired metrics cannot be updated or published again.

> **Important:** This does not check or remove existing boundary mappings.  
> The Step 3 mapping layer is responsible for handling retired metrics in mappings.

#### Success Response — 200

```json
{
  "message": "Metric retired successfully",
  "note": "Any existing boundary mappings referencing this metric should be reviewed in Step 3.",
  "metric": {
    "_id": "6650a1b2c3d4e5f678901234",
    "metricCode": "ESG-E-EN-001",
    "metricName": "Total Energy Consumption",
    "publishedStatus": "retired",
    "retiredAt": "2026-04-16T13:00:00.000Z"
  }
}
```

#### Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_STATUS_TRANSITION` | Metric is in draft status (retire requires published) |
| 403 | — | Permission denied |
| 404 | `METRIC_NOT_FOUND` | Metric not found or deleted |

---

### 7. Soft-Delete Metric

**DELETE** `/api/esglink/core/metrics/:metricId`

**Auth:** Bearer JWT  
**Roles:** `super_admin`, `consultant_admin`

Soft-deletes a metric (`isDeleted: true`). The metric is hidden from all list and get endpoints.  
Deletion is permanent in effect — metrics are not restored in v1.

#### Success Response — 200

```json
{
  "message": "Metric deleted successfully",
  "deletedAt": "2026-04-16T14:00:00.000Z"
}
```

#### Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 403 | — | Role not super_admin or consultant_admin |
| 404 | `METRIC_NOT_FOUND` | Metric not found or already deleted |

---

### 8. Create Client-Scoped Custom Metric

**POST** `/api/esglink/core/:clientId/metrics`

**Auth:** Bearer JWT  
**Roles:** `super_admin`, `consultant_admin`, `consultant` (assigned to `clientId`)

Creates a client-scoped custom metric.  
`metricType` is always forced to `client_defined`.  
`publishedStatus` is immediately set to `published` on creation (no draft step).

#### URL Parameters

| Param | Description |
|-------|-------------|
| `clientId` | String client ID (e.g. `Greon008`) |

#### Request Body

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `metricName` | String | ✓ | |
| `esgCategory` | String | ✓ | `E` \| `S` \| `G` |
| `subcategoryCode` | String | ✓ | Must match register |
| `metricDescription` | String | — | |
| `primaryUnit` | String | — | |
| `allowedUnits` | String[] | — | |
| `dataType` | String | — | default: `number` |
| `formulaId` | ObjectId | — | Optional formula reference |

```json
{
  "metricName": "Custom Water Recycling Rate",
  "esgCategory": "E",
  "subcategoryCode": "WA",
  "primaryUnit": "%",
  "dataType": "number"
}
```

#### Success Response — 201

```json
{
  "message": "Client-scoped metric created successfully",
  "metric": {
    "_id": "6650a1b2c3d4e5f678901299",
    "metricCode": "ESG-E-WA-001",
    "metricName": "Custom Water Recycling Rate",
    "esgCategory": "E",
    "subcategoryCode": "WA",
    "metricType": "client_defined",
    "publishedStatus": "published",
    "clientId": "Greon008",
    "version": 1,
    "createdAt": "2026-04-16T10:00:00.000Z"
  }
}
```

#### Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 400 | `MISSING_REQUIRED_FIELDS` | metricName / esgCategory / subcategoryCode missing |
| 400 | `INVALID_SUBCATEGORY` | subcategoryCode not valid for esgCategory |
| 400 | `INVALID_FORMULA` | formulaId not found or deleted |
| 403 | `MODULE_NOT_ACCESSIBLE` | Client does not have esg_link module access |
| 403 | — | Permission denied |
| 404 | `CLIENT_NOT_FOUND` | clientId not found |

---

### 9. List Client-Scoped Metrics

**GET** `/api/esglink/core/:clientId/metrics`

**Auth:** Bearer JWT  
**Roles:** `super_admin`, `consultant_admin`, `consultant` (assigned), `client_admin` (own)

Returns paginated list of client-scoped metrics for `clientId`.

#### URL Parameters

| Param | Description |
|-------|-------------|
| `clientId` | String client ID |

#### Query Parameters

Same as endpoint 2: `esgCategory`, `subcategoryCode`, `metricType`, `publishedStatus`, `page`, `limit`.

#### Success Response — 200

```json
{
  "total": 3,
  "page": 1,
  "limit": 20,
  "metrics": [
    {
      "_id": "6650a1b2c3d4e5f678901299",
      "metricCode": "ESG-E-WA-001",
      "metricName": "Custom Water Recycling Rate",
      "esgCategory": "E",
      "subcategoryCode": "WA",
      "metricType": "client_defined",
      "publishedStatus": "published",
      "clientId": "Greon008",
      "version": 1
    }
  ]
}
```

---

### 10. List Available Metrics for Mapping

**GET** `/api/esglink/core/:clientId/metrics/available`

**Auth:** Bearer JWT  
**Roles:** `super_admin`, `consultant_admin`, `consultant` (assigned)

Returns the combined set of metrics a consultant can map onto boundary nodes in **Step 3**:
- All global metrics with `publishedStatus: published`
- All client-scoped metrics for this client (any status — consultant sees their own drafts)

#### URL Parameters

| Param | Description |
|-------|-------------|
| `clientId` | String client ID |

#### Query Parameters

| Param | Type | Description |
|-------|------|-------------|
| `esgCategory` | String | Optional domain filter |
| `subcategoryCode` | String | Optional subcategory filter |
| `metricType` | String | Optional type filter |
| `page` | Number | default: 1 |
| `limit` | Number | default: 50, max: 100 |

#### Success Response — 200

```json
{
  "total": 45,
  "page": 1,
  "limit": 50,
  "globalCount": 42,
  "clientScopedCount": 3,
  "metrics": [
    {
      "_id": "6650a1b2c3d4e5f678901234",
      "metricCode": "ESG-E-EN-001",
      "metricName": "Total Energy Consumption",
      "esgCategory": "E",
      "subcategoryCode": "EN",
      "metricType": "raw",
      "publishedStatus": "published",
      "isGlobal": true
    },
    {
      "_id": "6650a1b2c3d4e5f678901299",
      "metricCode": "ESG-E-WA-001",
      "metricName": "Custom Water Recycling Rate",
      "esgCategory": "E",
      "subcategoryCode": "WA",
      "metricType": "client_defined",
      "publishedStatus": "published",
      "isGlobal": false,
      "clientId": "Greon008"
    }
  ]
}
```

#### Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 403 | — | Permission denied (client_admin cannot use this endpoint) |
| 404 | `CLIENT_NOT_FOUND` | clientId not found |

---

## Audit Log Behavior

All metric operations are logged to the `AuditLog` collection with `module: 'esg_metric'`.

| Operation | `action` | `subAction` | `severity` |
|-----------|----------|-------------|:----------:|
| Create global metric | `create` | `global_metric_created` | `info` |
| Create client-scoped metric | `create` | `client_metric_created` | `info` |
| Update metric (general) | `update` | `metric_updated` | `info` |
| Update metric (formula changed) | `update` | `formula_ref_changed` | `info` |
| Publish metric | `update` | `metric_published` | `info` |
| Retire metric | `update` | `metric_retired` | `warning` |
| Soft-delete metric | `delete` | `metric_deleted` | `warning` |

Audit logs are queryable via `GET /api/audit-logs?module=esg_metric`.

---

## Versioning Rules

| Change Type | `version` bump | `updatedAt` update |
|-------------|:-:|:-:|
| Definition fields: `metricName`, `metricDescription`, `primaryUnit`, `allowedUnits`, `dataType`, `formulaId` | ✓ | ✓ |
| Admin metadata only: `isBrsrCore`, `regulatorySourceRef`, `notesForUi` | ✗ | ✓ |
| Publish / retire / delete | ✗ | ✓ |

---

## Common Error Shapes

```json
{ "message": "string", "code": "ERROR_CODE" }
{ "message": "Permission denied", "reason": "Not assigned to this client" }
{ "message": "Client not found", "code": "CLIENT_NOT_FOUND" }
```

---

## Test Cases

### Recommended testing order

1. Create a global metric (as `consultant_admin`) → verify draft status + auto code
2. Try creating global metric as `consultant` → expect 403
3. Publish the metric → verify `publishedStatus: published`
4. List global metrics as `client_admin` → only published visible
5. Create client-scoped metric (as `consultant`) → verify immediate `published` status
6. List available metrics for client → see global published + client scoped
7. Update metric definition → verify version increment
8. Update only `notesForUi` → verify no version bump
9. Retire a published metric → verify status + audit log
10. Try retiring a draft metric → expect 400 INVALID_STATUS_TRANSITION
11. Get metric by ID with `derived` type → verify formula populated
12. Soft-delete → verify hidden from list endpoints
13. Check `GET /api/audit-logs?module=esg_metric` → all actions present

### Sample: Create global metric

```http
POST /api/esglink/core/metrics
Authorization: Bearer <consultant_admin_token>
Content-Type: application/json

{
  "metricName": "Total Energy Consumption",
  "esgCategory": "E",
  "subcategoryCode": "EN",
  "metricType": "raw",
  "primaryUnit": "GJ",
  "isBrsrCore": true
}
```

### Sample: Create derived metric with formula

```http
POST /api/esglink/core/metrics
Authorization: Bearer <consultant_admin_token>
Content-Type: application/json

{
  "metricName": "GHG Intensity per Revenue",
  "esgCategory": "E",
  "subcategoryCode": "GH",
  "metricType": "intensity",
  "primaryUnit": "tCO2e/INR Cr",
  "formulaId": "6650a2c3d4e5f67890123456"
}
```

### Sample: List available metrics for consultant mapping

```http
GET /api/esglink/core/Greon008/metrics/available?esgCategory=E
Authorization: Bearer <consultant_token>
```

### Sample: Publish a draft metric

```http
PATCH /api/esglink/core/metrics/6650a1b2c3d4e5f678901234/publish
Authorization: Bearer <consultant_admin_token>
```
