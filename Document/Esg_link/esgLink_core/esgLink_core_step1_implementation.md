# ESGLink Core Step 1 — Boundary Setup: Implementation Summary

**Date:** 2026-04-15  
**Module:** `esg-link` → `esgLink_core`  
**Feature:** Boundary Setup (Step 1 of ESGLink Core)

---

## Overview

This document covers the implementation of ESGLink Core Step 1: Boundary Setup. The Boundary is the ESGLink equivalent of the ZeroCarbon Organisational Flowchart — a node/edge graph representing a client's entity hierarchy for ESG data collection purposes.

All changes are **additive**. No existing ZeroCarbon logic was removed or altered.

---

## Files Created

### 1. `src/modules/esg-link/esgLink_core/models/EsgLinkBoundary.js`
Mongoose model defining the `EsgLinkBoundary` collection.

**Key design decisions:**
- `BoundaryNodeSchema` and `BoundaryEdgeSchema` use `{ _id: false }` — consistent with how ZeroCarbon's `NodeSchema` sub-documents are managed.
- Node `type` enum is ESGLink-specific: `entity | department | site | subsidiary | holding | custom`. This differs from ZeroCarbon's `TypeOfNode` (Emission Source / Reduction) since ESGLink nodes represent organisational entities, not emission points.
- `setupMethod` field distinguishes auto-imported vs manually created boundaries — important for audit and future re-sync logic.
- `importedFromFlowchartId` + `importedFromChartVersion` — tracks the source ZeroCarbon flowchart version at the time of import (for future drift detection).
- Compound index on `{ clientId: 1, isActive: 1 }` — ensures fast lookup of the active boundary per client.
- Soft-delete pattern (`isDeleted`, `deletedAt`, `deletedBy`) — matches the rest of the codebase.

---

### 2. `src/modules/esg-link/esgLink_core/utils/boundaryPermissions.js`
Thin permission wrapper exposing `canManageBoundary` and `canViewBoundary`.

**Decision:** Both functions delegate to `canManageFlowchart` from `src/common/utils/Permissions/permissions.js`. The permission model is identical (super_admin, consultant_admin for own clients, consultant if assigned). This avoids duplicating permission logic and ensures any future changes to `canManageFlowchart` automatically apply to boundary access.

---

### 3. `src/modules/esg-link/esgLink_core/services/boundaryService.js`
Two service functions consumed by both the controller and `getFlowchartBoundary`:

- **`checkZeroCarbonOrgAvailability(clientId)`** — validates all three prerequisites for import: `zero_carbon` module access, `organization` in `assessmentLevel`, and an active `Flowchart` document.
- **`extractBoundaryFromFlowchart(clientId)`** — loads the ZeroCarbon flowchart and strips all ZeroCarbon-specific data (scopeDetails, emissionFactors, apiKeyRequests, iotConnections, reductionSetup) from nodes. Only `id`, `label`, `type`, `position`, and safe `details` fields are kept.

**Decision:** Assessment level normalization includes the `'both'` → `['organization', 'process']` expansion — matching the same normalization logic used in `flowchartController.js`.

---

### 4. `src/modules/esg-link/esgLink_core/controllers/boundaryController.js`
Nine handler functions:

| Handler | Method | Purpose |
|---------|--------|---------|
| `importBoundaryFromZeroCarbon` | POST | Auto-import from ZeroCarbon org flowchart |
| `createBoundaryManually` | POST | Manual node/edge setup |
| `getBoundary` | GET | Fetch active boundary with populate |
| `updateBoundaryNode` | PATCH | Edit a single node; calls `markModified('nodes')` |
| `addNodeToBoundary` | POST | Append node(s) with duplicate ID check; calls `markModified('nodes')` |
| `appendNodeToBoundary` | PATCH | Safe-append node(s) to an existing boundary — preferred when metric mappings already exist; guarantees no existing node or `metricsDetails[]` is modified; calls `markModified('nodes')` |
| `addEdgeToBoundary` | POST | Append edge(s) with source/target validation; calls `markModified('edges')` |
| `removeNodeFromBoundary` | DELETE | Remove node + cascade-delete its edges; calls `markModified('nodes')` + `markModified('edges')` |
| `deleteBoundary` | DELETE | Soft-delete entire boundary |
| `checkBoundaryImportAvailability` | GET | Checks if ZeroCarbon import is possible |

**Decision — `deleteBoundary` role restriction:** Delete is restricted to `super_admin` and `consultant_admin` only (not `consultant`). A consultant can create and edit a boundary but cannot delete it — this prevents accidental loss of the ESG data foundation by field consultants.

**Decision — duplicate boundary prevention:** Both `importBoundaryFromZeroCarbon` and `createBoundaryManually` check for an existing active boundary and return `409 BOUNDARY_ALREADY_EXISTS` rather than silently overwriting. The client must explicitly delete the existing boundary before creating a new one.

---

### 5. `src/modules/esg-link/esgLink_core/routes/boundaryR.js`
Express router with `auth` middleware applied globally via `router.use(auth)`. Each route additionally applies `eslGate = requireActiveModuleSubscription('esg_link')`.

**Route ordering:** `GET /:clientId/boundary/import-availability` is registered **before** `GET /:clientId/boundary` to prevent Express from matching the former against the latter's `:clientId` segment.

---

## Files Modified

### 6. `src/modules/zero-carbon/organization/controllers/flowchartController.js`
**Change:** Added `getFlowchartBoundary` function at the bottom of the file (before `module.exports`) and exported it.

**What it does:** Returns the structural skeleton of the ZeroCarbon Organisational Flowchart — nodes stripped to `{ id, label, type, position, details: { name, department, location, entityType } }` and edges stripped to `{ id, source, target, label }`. All ZeroCarbon-specific sub-documents (scopeDetails, emissionFactors, apiKeyRequests, iotConnections, reductionSetup) are excluded.

**No existing code was changed** — only an additive function + export entry.

---

### 7. `src/modules/zero-carbon/organization/routes/flowchartR.js`
**Change:** Added `getFlowchartBoundary` to the destructured import and registered a new GET route:
```
GET /:clientId/boundary  →  zcGate, requireOrgFlowchartRead('view'), getFlowchartBoundary
```

**Route placement:** The new route is registered **before** `GET /:clientId` to prevent Express from treating `boundary` as a `clientId` value.

---

### 8. `src/app/bootstrap/registerRoutes.js`
**Change:** Added import of `esgLinkBoundaryR` and mounted it at `/api/esglink/core`:
```js
app.use('/api/esglink/core', esgLinkBoundaryR);
```

---

## Import Path Verification

All relative import paths have been verified:

| File | Import | Resolves To |
|------|--------|------------|
| `esgLink_core/services/boundaryService.js` | `../../../../modules/client-management/client/Client` | `src/modules/client-management/client/Client` ✓ |
| `esgLink_core/services/boundaryService.js` | `../../../../modules/zero-carbon/organization/models/Flowchart` | `src/modules/zero-carbon/organization/models/Flowchart` ✓ |
| `esgLink_core/utils/boundaryPermissions.js` | `../../../../common/utils/Permissions/permissions` | `src/common/utils/Permissions/permissions` ✓ |
| `esgLink_core/controllers/boundaryController.js` | `../../../../modules/client-management/client/Client` | `src/modules/client-management/client/Client` ✓ |
| `esgLink_core/routes/boundaryR.js` | `../../../../common/middleware/auth` | `src/common/middleware/auth` ✓ |
| `esgLink_core/routes/boundaryR.js` | `../../../../common/utils/Permissions/modulePermission` | `src/common/utils/Permissions/modulePermission` ✓ |

---

## Decisions & Deviations

1. **`canViewBoundary` delegates to `canManageFlowchart`** — The spec notes this is intentionally the same for Step 1 (consultant-only access). Client-user read access is explicitly deferred to a later step.

2. **Node `type` field mapping from ZeroCarbon** — The ZeroCarbon `NodeSchema` does not have a `type` field matching the ESGLink enum (`entity | department | site | subsidiary | holding | custom`). When importing, `node.type` from the ZeroCarbon flowchart will be `undefined`, so it defaults to `'entity'`. This is correct — ZeroCarbon node types are emission-oriented (`Emission Source | Reduction`), not organisational-entity-oriented.

3. **`node.details.name` and `node.details.entityType` from ZeroCarbon** — The ZeroCarbon `NodeSchema` has `details.nodeType` (not `name`) and no `entityType`. When importing, both default to `''`. The `label` field (which ZeroCarbon does have, required) is used as the fallback for `details.name`.

4. **`edge.label` from ZeroCarbon** — The ZeroCarbon `EdgeSchema` only stores `id`, `source`, `target` — no `label`. When importing, `edge.label` defaults to `''`. This is safe and handled defensively.

5. **`_bumpVersion` helper** — The private helper defined in `boundaryController.js` is declared but version bumping is done inline in each handler for clarity. This is intentional — the spec shows inline `boundary.version = (boundary.version || 1) + 1` patterns throughout.

---

## Testing Notes

### Pre-requisites
- A client with `accessibleModules: ['zero_carbon', 'esg_link']`
- That client must have `submissionData.assessmentLevel` including `'organization'`
- An active `Flowchart` document for that client
- A valid JWT for a `super_admin`, `consultant_admin`, or `consultant` user

### Postman / curl Examples

**1. Check ZeroCarbon import availability**
```bash
curl -X GET http://localhost:3000/api/esglink/core/{clientId}/boundary/import-availability \
  -H "Authorization: Bearer {token}"
```

**2. Import boundary from ZeroCarbon**
```bash
curl -X POST http://localhost:3000/api/esglink/core/{clientId}/boundary/import-from-zero-carbon \
  -H "Authorization: Bearer {token}"
```

**3. Create boundary manually**
```bash
curl -X POST http://localhost:3000/api/esglink/core/{clientId}/boundary \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{
    "nodes": [
      { "id": "n1", "label": "HQ", "type": "entity", "position": { "x": 100, "y": 100 } },
      { "id": "n2", "label": "Operations", "type": "department", "position": { "x": 300, "y": 100 } }
    ],
    "edges": [
      { "id": "e1", "source": "n1", "target": "n2", "label": "contains" }
    ]
  }'
```

**4. Get boundary**
```bash
curl -X GET http://localhost:3000/api/esglink/core/{clientId}/boundary \
  -H "Authorization: Bearer {token}"
```

**5. Update a node**
```bash
curl -X PATCH http://localhost:3000/api/esglink/core/{clientId}/boundary/nodes/n1 \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{ "label": "Global HQ", "details": { "location": "London" } }'
```

**6. Add a node**
```bash
curl -X POST http://localhost:3000/api/esglink/core/{clientId}/boundary/nodes \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{ "node": { "id": "n3", "label": "Finance", "type": "department" } }'
```

**7. Add an edge**
```bash
curl -X POST http://localhost:3000/api/esglink/core/{clientId}/boundary/edges \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{ "edge": { "id": "e2", "source": "n1", "target": "n3" } }'
```

**8. Remove a node**
```bash
curl -X DELETE http://localhost:3000/api/esglink/core/{clientId}/boundary/nodes/n3 \
  -H "Authorization: Bearer {token}"
```

**9. Delete boundary**
```bash
curl -X DELETE http://localhost:3000/api/esglink/core/{clientId}/boundary \
  -H "Authorization: Bearer {token}"
```

**10. Get ZeroCarbon boundary structure (used internally by import)**
```bash
curl -X GET http://localhost:3000/api/flowchart/{clientId}/boundary \
  -H "Authorization: Bearer {token}"
```
