# ESGLink Core — Step 2: Metric Library Implementation Reference

**Version:** 1.0  
**Date:** 2026-04-16  
**Author:** GreonXpert Engineering

---

## Business Purpose

Step 1 established the organisational node-edge skeleton (`EsgLinkBoundary`).  
Step 2 builds the **Metric Library** — the catalog of ESG metrics that consultants will later map onto boundary nodes.

Two kinds of metrics exist:
- **Global metrics** — platform-level, created by `consultant_admin` / `super_admin`, follow a `draft → published → retired` lifecycle.
- **Client-scoped custom metrics** — created by a `consultant` for one specific client, immediately published on creation.

Metrics are the foundation for Step 3 (boundary-node mapping + assignment) and future data collection stages.

---

## Architecture Overview

```
src/modules/esg-link/esgLink_core/
├── models/
│   ├── EsgLinkBoundary.js       (Step 1 — unchanged)
│   └── EsgMetric.js             ← NEW (Step 2)
│
├── utils/
│   ├── boundaryPermissions.js   (Step 1 — unchanged)
│   └── metricPermissions.js     ← NEW (Step 2)
│
├── services/
│   ├── boundaryService.js       (Step 1 — unchanged)
│   └── metricService.js         ← NEW (Step 2)
│
├── controllers/
│   ├── boundaryController.js    (Step 1 — unchanged)
│   └── metricController.js      ← NEW (Step 2)
│
└── routes/
    ├── boundaryR.js             (Step 1 — unchanged)
    └── metricR.js               ← NEW (Step 2)

src/common/models/AuditLog/AuditLog.js    ← MODIFIED (added esg_metric to MODULE_ENUM)
src/app/bootstrap/registerRoutes.js       ← MODIFIED (mounted esgLinkMetricR)

Document/esgLink/esgLink_core/
├── esgLink_core_step2_api_document.md    ← NEW
└── esgLink_core_step2_impleamentation.md ← NEW (this file)
```

---

## Files Changed / Added

### New Files

| File | Purpose |
|------|---------|
| `src/modules/esg-link/esgLink_core/models/EsgMetric.js` | Mongoose model — Metric Library schema and indexes |
| `src/modules/esg-link/esgLink_core/utils/metricPermissions.js` | Permission helpers: `canManageGlobalMetric`, `canManageClientMetric`, `canViewClientMetrics` |
| `src/modules/esg-link/esgLink_core/services/metricService.js` | `generateMetricCode`, `validateSubcategoryCode`, `hasDefinitionChange` |
| `src/modules/esg-link/esgLink_core/controllers/metricController.js` | 10 handler functions |
| `src/modules/esg-link/esgLink_core/routes/metricR.js` | Express router — all metric endpoints |
| `Document/esgLink/esgLink_core/esgLink_core_step2_api_document.md` | API specification |
| `Document/esgLink/esgLink_core/esgLink_core_step2_impleamentation.md` | This file |

### Modified Files

| File | Change |
|------|--------|
| `src/common/models/AuditLog/AuditLog.js` | Added `'esg_metric'` to `MODULE_ENUM` array |
| `src/app/bootstrap/registerRoutes.js` | Imported `metricR`; mounted at `/api/esglink/core` |

---

## Schema Design

### `EsgMetric` model

Collection: `esg_metrics`

#### Field groups

**Identity fields** (§2.1 + §1.1 + §1.2 + §1.3 of Metric Dictionary)

| Field | Type | Notes |
|-------|------|-------|
| `metricCode` | String | Auto-generated `ESG-{E/S/G}-{SUBCATEGORY}-{NNN}` |
| `metricName` | String | Required |
| `metricDescription` | String | Optional |
| `esgCategory` | `E`\|`S`\|`G` | Required |
| `subcategoryCode` | String | Required; validated against §1.3 register |
| `metricType` | `raw`\|`derived`\|`intensity`\|`client_defined` | Required |

**Scope fields**

| Field | Type | Notes |
|-------|------|-------|
| `isGlobal` | Boolean | `true` = platform-level; `false` = client-scoped |
| `clientId` | String | `null` for global; set for client-scoped |

**Measurement fields** (§2.2 minimal)

| Field | Type | Notes |
|-------|------|-------|
| `primaryUnit` | String | e.g. `GJ`, `tCO2e`, `%` |
| `allowedUnits` | String[] | Optional alternatives |
| `dataType` | String | `number`\|`text`\|`boolean`\|`enum`\|`date`\|`mixed` |

**Formula reference** (§2.5 minimal)

| Field | Type | Notes |
|-------|------|-------|
| `formulaId` | ObjectId → `ReductionFormula` | Required for `derived`/`intensity`; optional otherwise |

> Variable mode mapping (frozen/realtime/manual) is **NOT implemented in this step**.  
> See **Step 3 placeholder** section below.

**Lifecycle fields**

| Field | Type | Notes |
|-------|------|-------|
| `publishedStatus` | `draft`\|`published`\|`retired` | Global default: `draft`; client-scoped: `published` on create |
| `version` | Number | Starts at 1; bumped on definition changes |
| `publishedAt` | Date | Set when published |
| `retiredAt` | Date | Set when retired |

**Admin / governance metadata** (§2.10)

| Field | Type | Notes |
|-------|------|-------|
| `isBrsrCore` | Boolean | BRSR core metric flag |
| `regulatorySourceRef` | String | e.g. `BRSR-C-P6-E-001` |
| `notesForUi` | String | Internal UI hint |

**Ownership + soft-delete**

| Field | Notes |
|-------|-------|
| `createdBy` | ObjectId → User |
| `updatedBy` | ObjectId → User |
| `isDeleted` / `deletedAt` / `deletedBy` | Soft-delete pattern (same as boundary) |
| `createdAt` / `updatedAt` | Auto via `timestamps: true` |

#### Indexes

| Index | Purpose |
|-------|---------|
| `{ metricCode: 1 }` unique sparse | Prevent duplicate codes; sparse allows null during generation |
| `{ isGlobal: 1, publishedStatus: 1, isDeleted: 1 }` | Fast global list queries |
| `{ clientId: 1, publishedStatus: 1, isDeleted: 1 }` | Fast client-scoped list queries |
| `{ esgCategory: 1, subcategoryCode: 1 }` | Domain-filtered browsing |
| `{ isGlobal: 1, esgCategory: 1, subcategoryCode: 1, isDeleted: 1 }` | Code generation counter |
| `{ clientId: 1, esgCategory: 1, subcategoryCode: 1, isDeleted: 1 }` | Client code generation counter |

#### Excluded fields (deliberate)

The following fields from the Metric Dictionary spec are intentionally excluded from this stage and belong in future steps:

| Field group | Deferred to |
|-------------|-------------|
| `frequency`, `boundary_scope`, `roll_up_behavior` | Step 3 (mapping-level fields) |
| `source_type`, `zero_carbon_reference` | Data collection stage |
| `validation_rules`, `threshold_logic`, `anomaly_flag_behavior` | Threshold/validation stage |
| `evidence_requirement`, `evidence_type_notes` | Framework/disclosure stage |
| `framework_mappings`, `material_topic_ids`, `linked_ngrbc_principles` | Framework module |
| `default_owner_role`, `approval_level` | Step 3 (assignment) |
| `input_metric_ids` (derived inputs) | These live on the Formula model's `variables` |
| `is_client_defined` boolean | Redundant with `metricType === 'client_defined'` |

---

## Metric Code Generation

### Format

```
ESG-{esgCategory}-{subcategoryCode}-{NNN}
```

Examples: `ESG-E-EN-001`, `ESG-S-DI-003`, `ESG-G-ET-001`

### Scoping

| Metric kind | Sequence namespace |
|-------------|-------------------|
| Global (`isGlobal: true`) | Shared per `esgCategory + subcategoryCode` across all global metrics |
| Client-scoped (`isGlobal: false`) | Per `clientId + esgCategory + subcategoryCode` |

### Algorithm (`metricService.generateMetricCode`)

1. Count non-deleted metrics matching scope filter.
2. `seq = count + 1`; pad to 3 digits.
3. Check if `metricCode` already exists (race-condition safety).
4. If collision: `seq = count + 2`.
5. Return code string.

The unique sparse index on `metricCode` is the final safety net.

---

## Permission Behavior

### Helper functions (`metricPermissions.js`)

```javascript
canManageGlobalMetric(user)
// Synchronous — checks user.userType only
// Allowed: super_admin, consultant_admin

canManageClientMetric(user, clientId)
// Async — calls canManageFlowchart for consultant role
// Allowed: super_admin, consultant_admin, consultant (if assigned to client)

canViewClientMetrics(user, clientId)
// Async — superset of canManageClientMetric
// Allowed: all of above + client_admin for their own clientId
```

### Permission gate pattern

Follows the same `_guardPermission(perm, res)` pattern as `boundaryController.js`:
- `perm.allowed === false` with `reason === 'Client not found'` → 404
- All other failures → 403

### Key permission rules

| Scenario | Behaviour |
|----------|-----------|
| `consultant` tries to create global metric | 403 |
| `consultant` creates client-scoped metric for wrong client | 403 (canManageFlowchart rejects) |
| `client_admin` calls `/metrics` (global list) | Only published metrics returned (status locked) |
| `client_admin` calls `/:clientId/metrics/available` | 403 (consultant-level required) |
| `client_admin` gets metric by ID (global) | Allowed — global metrics visible to all esg_link users |
| `client_admin` gets metric by ID (client-scoped, own) | Allowed |
| `client_admin` gets metric by ID (client-scoped, other client) | 403 |

---

## Formula Integration

### What is implemented

- `formulaId` (ObjectId ref `ReductionFormula`) is stored on the metric.
- Required when `metricType` is `derived` or `intensity`.
- Validated at create and update time: formula must exist and not be deleted.
- `GET /metrics/:metricId` populates `formula` for derived/intensity metrics:
  - Returns: `_id`, `name`, `expression`, `variables` from the formula document.

### What is NOT implemented (Step 3)

```
// ── STEP 3 PLACEHOLDER ─────────────────────────────────────────
// Variable mode mapping is NOT implemented in this step.
//
// In Step 3, when a metric is mapped onto a boundary node,
// the mapping document will store per-variable modes:
//
//   variableKinds: Map {
//     "A": "frozen" | "realtime" | "manual"
//   }
//
// Following the same pattern as Reduction.m2.formulaRef.variableKinds.
// ─────────────────────────────────────────────────────────────────
```

### Important constraint

The `ReductionFormula` model lives in `zero-carbon/reduction/models/Formula.js`.  
It is referenced by ObjectId only — **no changes are made to the formula module** in this step.  
Formula ownership validation (clientIds array) is not enforced in this step; the formula must only exist and not be deleted.

---

## Audit Log Integration

### Module name

`'esg_metric'` is added to `MODULE_ENUM` in `AuditLog.js`.

### Log events summary

| Controller method | `action` | `subAction` | `severity` |
|-------------------|----------|-------------|:----------:|
| `createGlobalMetric` | `create` | `global_metric_created` | `info` |
| `createClientMetric` | `create` | `client_metric_created` | `info` |
| `updateMetric` (general) | `update` | `metric_updated` | `info` |
| `updateMetric` (formula changed) | `update` | `formula_ref_changed` | `info` |
| `publishMetric` | `update` | `metric_published` | `info` |
| `retireMetric` | `update` | `metric_retired` | `warning` |
| `deleteMetric` | `delete` | `metric_deleted` | `warning` |

### Pattern used

`logEventFireAndForget(...)` from `auditLogService.js` — fire-and-forget, consistent with all other ESGLink and ZeroCarbon controllers.  
A logging failure never blocks the main API response.

---

## Versioning Behavior

### Version increment rules

The `version` counter starts at 1 on creation.

**Increments when** any of these definition-level fields change (`hasDefinitionChange` in `metricService.js`):
- `metricName`
- `metricDescription`
- `primaryUnit`
- `allowedUnits`
- `dataType`
- `formulaId`

**Does not increment when** only admin metadata changes:
- `isBrsrCore`
- `regulatorySourceRef`
- `notesForUi`

**Does not increment for** lifecycle transitions (publish, retire, delete).

### `updatedAt`

Auto-managed by Mongoose `timestamps: true` — updates on every `.save()` call.

### No historical restatement

Full historical version snapshots are not stored in this stage.  
`version` is a monotonic integer for ordering/comparison.  
All audit log entries reference the metric by `entityId` and carry the operation in `changeSummary`.

---

## Route Registration

`metricR.js` is mounted alongside `boundaryR.js`:

```javascript
app.use('/api/esglink/core', esgLinkBoundaryR);
app.use('/api/esglink/core', esgLinkMetricR);
```

### Route ordering safety

Within `metricR.js`, literal paths are registered **before** parameterised paths:

```
/metrics         ← registered first (literal)
/metrics/:metricId
/:clientId/metrics/available   ← registered before /:clientId/metrics
/:clientId/metrics
```

This prevents Express from interpreting the word `metrics` as a `:clientId` parameter when the metric router is mounted at the same base path as the boundary router.

---

## Assumptions and Decisions

| Assumption / Decision | Rationale |
|-----------------------|-----------|
| Client-scoped metrics are immediately published | User confirmed: simpler workflow for consultant custom metrics |
| `metricType` forced to `client_defined` for client-scoped | Ensures clean classification; caller cannot override |
| `metricCode` is immutable after creation | Codes are referenced in reporting/disclosure; changing them would break traceability |
| `esgCategory` and `subcategoryCode` are immutable | Same reason — these determine namespace and code prefix |
| No encryption on `EsgMetric` fields | Metric definitions are library catalog data, not sensitive operational client data. Compare: `EsgLinkBoundary` encrypts nodes/edges because they represent the client's org structure. |
| Formula not moved out of Zero Carbon | Per explicit user instruction — formula commonisation is out of scope for this step |
| No assignment fields on `EsgMetric` | Assignment (contributor/reviewer/approver) belongs to the mapping layer, not the metric definition |
| `is_client_defined` boolean not added | Redundant with `metricType === 'client_defined'`; avoids sync inconsistency |

---

## Step 3 Placeholders

The following features are **explicitly not implemented** in this step and are documented here as placeholders for Step 3 (metric-to-boundary mapping + assignment).

### 1. Metric → boundary node mapping

```
// NOT IMPLEMENTED — Step 3
//
// A separate model (e.g. EsgMetricMapping) or embedded array in EsgLinkBoundary
// will store the mapping:
//
// {
//   boundaryId:   ObjectId → EsgLinkBoundary,
//   nodeId:       String (boundary node id),
//   metricId:     ObjectId → EsgMetric,
//   assignedAt:   Date,
//   assignedBy:   ObjectId → User,
// }
```

### 2. Contributor / reviewer / approver assignment

```
// NOT IMPLEMENTED — Step 3
//
// Assignment lives at the mapping level (node + metric pair), not the metric definition.
// Proposed shape per mapping:
//
// {
//   contributor:  ObjectId → User (single),
//   reviewers:    [ObjectId → User],
//   approvers:    [ObjectId → User],
// }
//
// Visibility rules:
//   contributor → sees only their assigned node + metric
//   reviewer    → sees metrics assigned to them for review
//   approver    → sees metrics pending their approval
```

### 3. Variable mode mapping

```
// NOT IMPLEMENTED — Step 3
//
// When a derived/intensity metric is mapped to a node, each formula variable
// will be assigned a mode following the Reduction M2 pattern:
//
//   variableKinds: Map { varName → 'frozen' | 'realtime' | 'manual' }
//   variables: Map { varName → { value, updatePolicy, policy, history } }
//
// Reference: src/modules/zero-carbon/reduction/models/Reduction.js → m2.formulaRef
```

---

## Testing Notes

### Prerequisites

1. At least one active `esg_link` client with `accessibleModules: ['esg_link']`
2. A `consultant_admin` token for global metric operations
3. A `consultant` token assigned to the test client (for client-scoped operations)
4. An existing `ReductionFormula` document ID (for derived/intensity metrics)

### Test sequence

See **Test Cases** section in `esgLink_core_step2_api_document.md` for full Postman-style examples and recommended testing order.

### Audit log verification

```http
GET /api/audit-logs?module=esg_metric
Authorization: Bearer <super_admin_token>
```

Expected: all metric operations appear with correct `action`, `subAction`, and `severity`.
