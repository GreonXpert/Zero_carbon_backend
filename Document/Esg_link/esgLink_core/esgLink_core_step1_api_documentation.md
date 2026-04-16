# ESGLink Core Step 1 — Boundary Setup: API Documentation

**Version:** 1.0.0  
**Base URL:** `/api`  
**Authentication:** All endpoints require a valid JWT Bearer token via `Authorization: Bearer <token>`  
**Module gate:** All ESGLink Core endpoints require the client to have an active `esg_link` subscription (`accountDetails.esgLinkSubscription.subscriptionStatus ∈ ['active', 'grace_period']`).

---

## Roles & Permissions

All boundary endpoints enforce the following role rules (same model as ZeroCarbon flowcharts):

| Role | Access |
|------|--------|
| `super_admin` | Full access to all clients |
| `consultant_admin` | Access to clients they created or are assigned to |
| `consultant` | Access only to their currently assigned client |
| `client` | No access (Step 1 is consultant-only) |

---

## Endpoint Index

| # | Method | URL | Description |
|---|--------|-----|-------------|
| 1 | GET | `/api/flowchart/:clientId/boundary` | Fetch ZeroCarbon structure for import preview |
| 2 | GET | `/api/esglink/core/:clientId/boundary/import-availability` | Check if ZeroCarbon import is possible |
| 3 | POST | `/api/esglink/core/:clientId/boundary/import-from-zero-carbon` | Auto-import boundary from ZeroCarbon |
| 4 | POST | `/api/esglink/core/:clientId/boundary` | Create boundary manually |
| 5 | GET | `/api/esglink/core/:clientId/boundary` | Get active boundary |
| 6 | PATCH | `/api/esglink/core/:clientId/boundary/nodes/:nodeId` | Update a node |
| 7 | POST | `/api/esglink/core/:clientId/boundary/nodes` | Add node(s) |
| 8 | POST | `/api/esglink/core/:clientId/boundary/edges` | Add edge(s) |
| 9 | DELETE | `/api/esglink/core/:clientId/boundary/nodes/:nodeId` | Remove a node |
| 10 | DELETE | `/api/esglink/core/:clientId/boundary` | Soft-delete boundary |

---

## 1. GET `/api/flowchart/:clientId/boundary`

**Purpose:** Returns the structural skeleton of the client's ZeroCarbon Organisational Flowchart — nodes stripped of all emission/scope data + raw edges. Used by the frontend as an import preview before calling endpoint 3.

**Auth:** Required (ZeroCarbon module gate: `zero_carbon` subscription active)  
**Roles:** `super_admin`, `consultant_admin`, `consultant`

### URL Parameters
| Param | Type | Description |
|-------|------|-------------|
| `clientId` | string | The client's unique ID |

### Success Response — `200 OK`
```json
{
  "success": true,
  "message": "Flowchart boundary data fetched successfully",
  "data": {
    "clientId": "CLIENT_001",
    "chartVersion": 3,
    "sourceChartId": "64f2a3b1e4b0c12d4e5f6789",
    "nodeCount": 4,
    "edgeCount": 3,
    "nodes": [
      {
        "id": "node-1",
        "label": "Group HQ",
        "type": null,
        "position": { "x": 100, "y": 100 },
        "details": {
          "name": "Group HQ",
          "department": "",
          "location": "London",
          "entityType": ""
        }
      }
    ],
    "edges": [
      {
        "id": "edge-1",
        "source": "node-1",
        "target": "node-2",
        "label": ""
      }
    ]
  }
}
```

### Error Responses
| Status | Code | Description |
|--------|------|-------------|
| 400 | `NO_ZERO_CARBON_MODULE` | Client does not have `zero_carbon` module |
| 400 | `NO_ORGANIZATION_LEVEL` | Client's `assessmentLevel` doesn't include `organization` |
| 403 | — | Caller lacks permission for this client |
| 404 | — | Client not found |
| 404 | `FLOWCHART_NOT_FOUND` | No active organisational flowchart exists |

### Frontend Integration Notes
- Call this endpoint to show the user a **preview** of what will be imported before they confirm.
- The `nodeCount` and `edgeCount` in the response are useful for displaying a summary in the UI ("4 nodes, 3 edges will be imported").
- `type` on nodes may be `null` — the ZeroCarbon schema uses `TypeOfNode` (Emission Source/Reduction), not an entity type. When imported into ESGLink, these nodes default to type `"entity"`.

---

## 2. GET `/api/esglink/core/:clientId/boundary/import-availability`

**Purpose:** Checks whether a ZeroCarbon org flowchart is available to import for this client, without actually importing. Use this to decide whether to show "Import from ZeroCarbon" or "Create manually" in the UI.

**Auth:** Required (ESGLink module gate)  
**Roles:** `super_admin`, `consultant_admin`, `consultant`

### URL Parameters
| Param | Type | Description |
|-------|------|-------------|
| `clientId` | string | The client's unique ID |

### Success Response — `200 OK` (import available)
```json
{
  "success": true,
  "data": {
    "clientId": "CLIENT_001",
    "importAvailable": true,
    "flowchartId": "64f2a3b1e4b0c12d4e5f6789",
    "chartVersion": 3
  }
}
```

### Success Response — `200 OK` (import NOT available)
```json
{
  "success": true,
  "data": {
    "clientId": "CLIENT_002",
    "importAvailable": false,
    "reason": "Client assessmentLevel does not include \"organization\"",
    "code": "NO_ORGANIZATION_LEVEL"
  }
}
```

Possible `code` values when `importAvailable: false`:

| Code | Meaning |
|------|---------|
| `CLIENT_NOT_FOUND` | Client does not exist |
| `NO_ZERO_CARBON_MODULE` | Client doesn't have `zero_carbon` module |
| `NO_ORGANIZATION_LEVEL` | `assessmentLevel` doesn't include `organization` |
| `FLOWCHART_NOT_FOUND` | No active ZeroCarbon org flowchart found |

### Frontend Integration Notes
- Call this on the boundary setup page load to decide which setup path to offer.
- If `importAvailable: true` → show primary CTA "Import from ZeroCarbon" + secondary option "Set up manually".
- If `importAvailable: false` → show only "Set up manually", optionally showing `reason` as a tooltip.

---

## 3. POST `/api/esglink/core/:clientId/boundary/import-from-zero-carbon`

**Purpose:** Creates an ESGLink Boundary by auto-importing the structural data from the client's existing ZeroCarbon Organisational Flowchart. No request body required.

**Auth:** Required (ESGLink module gate)  
**Roles:** `super_admin`, `consultant_admin`, `consultant`

### URL Parameters
| Param | Type | Description |
|-------|------|-------------|
| `clientId` | string | The client's unique ID |

### Request Body
None required.

### Success Response — `201 Created`
```json
{
  "success": true,
  "message": "Boundary imported from ZeroCarbon organisational flowchart (v3)",
  "data": {
    "boundaryId": "65a1b2c3d4e5f6789012345a",
    "clientId": "CLIENT_001",
    "setupMethod": "imported_from_zero_carbon",
    "nodeCount": 4,
    "edgeCount": 3,
    "version": 1,
    "importedFrom": {
      "flowchartId": "64f2a3b1e4b0c12d4e5f6789",
      "chartVersion": 3
    }
  }
}
```

### Error Responses
| Status | Code | Description |
|--------|------|-------------|
| 400 | `NO_ESG_LINK_MODULE` | Client doesn't have `esg_link` module |
| 400 | `NO_ZERO_CARBON_MODULE` | Client doesn't have `zero_carbon` module |
| 400 | `NO_ORGANIZATION_LEVEL` | `assessmentLevel` doesn't include `organization` |
| 403 | — | Caller lacks permission |
| 404 | — | Client not found |
| 404 | `FLOWCHART_NOT_FOUND` | No active ZeroCarbon org flowchart |
| 404 | `EXTRACTION_FAILED` | Failed to extract flowchart data |
| 409 | `BOUNDARY_ALREADY_EXISTS` | An active boundary already exists for this client |

### Frontend Integration Notes
- No request body needed — just call with the `clientId`.
- On `409 BOUNDARY_ALREADY_EXISTS`, the response includes `boundaryId` — you can redirect to the existing boundary view.
- After success, store `boundaryId` and redirect to the boundary editor/viewer.

---

## 4. POST `/api/esglink/core/:clientId/boundary`

**Purpose:** Creates an ESGLink Boundary manually with consultant-provided nodes and edges.

**Auth:** Required (ESGLink module gate)  
**Roles:** `super_admin`, `consultant_admin`, `consultant`

### URL Parameters
| Param | Type | Description |
|-------|------|-------------|
| `clientId` | string | The client's unique ID |

### Request Body
```json
{
  "nodes": [
    {
      "id": "n1",
      "label": "Group HQ",
      "type": "entity",
      "position": { "x": 100, "y": 100 },
      "details": {
        "name": "Group Headquarters",
        "department": "",
        "location": "London, UK",
        "entityType": "holding",
        "notes": "Parent entity"
      }
    },
    {
      "id": "n2",
      "label": "UK Operations",
      "type": "subsidiary",
      "position": { "x": 300, "y": 200 }
    }
  ],
  "edges": [
    {
      "id": "e1",
      "source": "n1",
      "target": "n2",
      "label": "owns"
    }
  ]
}
```

### Field Reference — Node Object
| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | ✅ | — | Unique node identifier |
| `label` | string | ✅ | — | Display name shown in diagram |
| `type` | string | ❌ | `"entity"` | One of: `entity`, `department`, `site`, `subsidiary`, `holding`, `custom` |
| `position.x` | number | ❌ | `0` | X coordinate for diagram layout |
| `position.y` | number | ❌ | `0` | Y coordinate for diagram layout |
| `details.name` | string | ❌ | `label` | Full name (defaults to label) |
| `details.department` | string | ❌ | `""` | Department name |
| `details.location` | string | ❌ | `""` | Physical location |
| `details.entityType` | string | ❌ | `""` | Entity classification |
| `details.notes` | string | ❌ | `""` | Free-text notes |

### Field Reference — Edge Object
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✅ | Unique edge identifier |
| `source` | string | ✅ | `id` of the source node (must exist in `nodes`) |
| `target` | string | ✅ | `id` of the target node (must exist in `nodes`) |
| `label` | string | ❌ | Edge label (e.g. "owns", "contains") |

### Success Response — `201 Created`
```json
{
  "success": true,
  "message": "ESGLink Core boundary created manually",
  "data": {
    "boundaryId": "65a1b2c3d4e5f6789012345b",
    "clientId": "CLIENT_002",
    "setupMethod": "manual",
    "nodeCount": 2,
    "edgeCount": 1,
    "version": 1
  }
}
```

### Error Responses
| Status | Code | Description |
|--------|------|-------------|
| 400 | `NO_ESG_LINK_MODULE` | Client doesn't have `esg_link` module |
| 400 | — | `nodes` is not an array, or node missing `id`/`label` |
| 400 | — | Edge `source` or `target` references a non-existent node id |
| 403 | — | Caller lacks permission |
| 404 | — | Client not found |
| 409 | `BOUNDARY_ALREADY_EXISTS` | Active boundary already exists |

### Error Response Examples
```json
{
  "message": "Invalid node data",
  "errors": ["nodes[0]: id is required", "nodes[1]: label is required"]
}
```
```json
{
  "message": "Invalid edge data",
  "errors": ["edges[0]: source \"node-999\" does not match any node id"]
}
```

---

## 5. GET `/api/esglink/core/:clientId/boundary`

**Purpose:** Fetches the client's current active ESGLink Boundary document, including full node and edge arrays and populated creator/modifier user info.

**Auth:** Required (ESGLink module gate)  
**Roles:** `super_admin`, `consultant_admin`, `consultant`

### URL Parameters
| Param | Type | Description |
|-------|------|-------------|
| `clientId` | string | The client's unique ID |

### Success Response — `200 OK`
```json
{
  "success": true,
  "data": {
    "_id": "65a1b2c3d4e5f6789012345a",
    "clientId": "CLIENT_001",
    "setupMethod": "imported_from_zero_carbon",
    "importedFromFlowchartId": "64f2a3b1e4b0c12d4e5f6789",
    "importedFromChartVersion": 3,
    "version": 2,
    "isActive": true,
    "isDeleted": false,
    "nodes": [
      {
        "id": "node-1",
        "label": "Group HQ",
        "type": "entity",
        "position": { "x": 100, "y": 100 },
        "details": {
          "name": "Group HQ",
          "department": "",
          "location": "London",
          "entityType": "",
          "notes": ""
        },
        "createdAt": "2026-04-15T10:00:00.000Z",
        "updatedAt": "2026-04-15T10:00:00.000Z"
      }
    ],
    "edges": [
      {
        "id": "edge-1",
        "source": "node-1",
        "target": "node-2",
        "label": ""
      }
    ],
    "createdBy": {
      "_id": "64a1b2c3d4e5f67890123456",
      "userName": "jane.consultant",
      "email": "jane@consultancy.com",
      "userType": "consultant"
    },
    "lastModifiedBy": {
      "_id": "64a1b2c3d4e5f67890123456",
      "userName": "jane.consultant",
      "email": "jane@consultancy.com"
    },
    "createdAt": "2026-04-15T10:00:00.000Z",
    "updatedAt": "2026-04-15T10:05:00.000Z"
  }
}
```

### Error Responses
| Status | Code | Description |
|--------|------|-------------|
| 403 | — | Caller lacks permission |
| 404 | `BOUNDARY_NOT_FOUND` | No active boundary exists for this client |

---

## 6. PATCH `/api/esglink/core/:clientId/boundary/nodes/:nodeId`

**Purpose:** Updates a single node's `label`, `type`, `position`, or `details`. The boundary `version` is incremented on every successful update.

**Auth:** Required (ESGLink module gate)  
**Roles:** `super_admin`, `consultant_admin`, `consultant`

### URL Parameters
| Param | Type | Description |
|-------|------|-------------|
| `clientId` | string | The client's unique ID |
| `nodeId` | string | The node's `id` field (not MongoDB `_id`) |

### Request Body
Provide only the fields to update. All fields are optional.
```json
{
  "label": "Updated HQ Name",
  "type": "holding",
  "position": { "x": 150, "y": 150 },
  "details": {
    "location": "New York",
    "notes": "Relocated HQ"
  }
}
```

**Note:** `details` is merged (partial update) — only the fields you provide are overwritten. Fields not included in the request are preserved.

### Success Response — `200 OK`
```json
{
  "success": true,
  "message": "Node \"node-1\" updated",
  "data": {
    "boundaryId": "65a1b2c3d4e5f6789012345a",
    "version": 3,
    "node": {
      "id": "node-1",
      "label": "Updated HQ Name",
      "type": "holding",
      "position": { "x": 150, "y": 150 },
      "details": {
        "name": "Group HQ",
        "department": "",
        "location": "New York",
        "entityType": "",
        "notes": "Relocated HQ"
      },
      "createdAt": "2026-04-15T10:00:00.000Z",
      "updatedAt": "2026-04-15T10:10:00.000Z"
    }
  }
}
```

### Error Responses
| Status | Code | Description |
|--------|------|-------------|
| 403 | — | Caller lacks permission |
| 404 | `BOUNDARY_NOT_FOUND` | No active boundary exists |
| 404 | — | Node `nodeId` not found in boundary |

---

## 7. POST `/api/esglink/core/:clientId/boundary/nodes`

**Purpose:** Adds one or more new nodes to the existing boundary. Accepts either a single node object (`"node": {...}`) or an array (`"nodes": [...]`).

**Auth:** Required (ESGLink module gate)  
**Roles:** `super_admin`, `consultant_admin`, `consultant`

### URL Parameters
| Param | Type | Description |
|-------|------|-------------|
| `clientId` | string | The client's unique ID |

### Request Body — Single Node
```json
{
  "node": {
    "id": "n3",
    "label": "Finance",
    "type": "department",
    "position": { "x": 400, "y": 100 }
  }
}
```

### Request Body — Multiple Nodes
```json
{
  "nodes": [
    { "id": "n3", "label": "Finance", "type": "department" },
    { "id": "n4", "label": "IT", "type": "department" }
  ]
}
```

### Success Response — `201 Created`
```json
{
  "success": true,
  "message": "1 node(s) added to boundary",
  "data": {
    "boundaryId": "65a1b2c3d4e5f6789012345a",
    "version": 4,
    "addedNodes": [
      {
        "id": "n3",
        "label": "Finance",
        "type": "department",
        "position": { "x": 400, "y": 100 },
        "details": { "name": "Finance", "department": "", "location": "", "entityType": "", "notes": "" }
      }
    ]
  }
}
```

### Error Responses
| Status | Code | Description |
|--------|------|-------------|
| 400 | — | No node(s) provided in request body |
| 400 | — | Node missing `id` or `label` |
| 400 | — | Node `id` already exists in the boundary |
| 403 | — | Caller lacks permission |
| 404 | `BOUNDARY_NOT_FOUND` | No active boundary exists |

---

## 8. POST `/api/esglink/core/:clientId/boundary/edges`

**Purpose:** Adds one or more new edges to the existing boundary. Source and target node IDs must already exist in the boundary. Accepts either `"edge": {...}` or `"edges": [...]`.

**Auth:** Required (ESGLink module gate)  
**Roles:** `super_admin`, `consultant_admin`, `consultant`

### URL Parameters
| Param | Type | Description |
|-------|------|-------------|
| `clientId` | string | The client's unique ID |

### Request Body — Single Edge
```json
{
  "edge": {
    "id": "e2",
    "source": "n1",
    "target": "n3",
    "label": "contains"
  }
}
```

### Request Body — Multiple Edges
```json
{
  "edges": [
    { "id": "e2", "source": "n1", "target": "n3" },
    { "id": "e3", "source": "n1", "target": "n4" }
  ]
}
```

### Success Response — `201 Created`
```json
{
  "success": true,
  "message": "1 edge(s) added to boundary",
  "data": {
    "boundaryId": "65a1b2c3d4e5f6789012345a",
    "version": 5,
    "addedEdges": [
      { "id": "e2", "source": "n1", "target": "n3", "label": "contains" }
    ]
  }
}
```

### Error Responses
| Status | Code | Description |
|--------|------|-------------|
| 400 | — | No edge(s) provided |
| 400 | — | Edge missing `id`, `source`, or `target` |
| 400 | — | Edge `id` already exists in boundary |
| 400 | — | `source` or `target` node not found in boundary |
| 403 | — | Caller lacks permission |
| 404 | `BOUNDARY_NOT_FOUND` | No active boundary exists |

---

## 9. DELETE `/api/esglink/core/:clientId/boundary/nodes/:nodeId`

**Purpose:** Removes a node from the boundary. **Also removes all edges** where that node is the `source` or `target` — cascade deletion prevents orphaned edges.

**Auth:** Required (ESGLink module gate)  
**Roles:** `super_admin`, `consultant_admin`, `consultant`

### URL Parameters
| Param | Type | Description |
|-------|------|-------------|
| `clientId` | string | The client's unique ID |
| `nodeId` | string | The node's `id` field |

### Success Response — `200 OK`
```json
{
  "success": true,
  "message": "Node \"n3\" removed from boundary",
  "data": {
    "boundaryId": "65a1b2c3d4e5f6789012345a",
    "version": 6,
    "removedNodeId": "n3",
    "removedEdges": ["e2"]
  }
}
```

The `removedEdges` array lists the `id`s of all edges that were cascade-deleted.

### Error Responses
| Status | Code | Description |
|--------|------|-------------|
| 403 | — | Caller lacks permission |
| 404 | `BOUNDARY_NOT_FOUND` | No active boundary exists |
| 404 | — | Node `nodeId` not found in boundary |

### Frontend Integration Notes
- Always check `removedEdges` in the response and remove those edges from the diagram UI.
- If the diagram has edge references that depend on the deleted node, clean them up client-side after this call.

---

## 10. DELETE `/api/esglink/core/:clientId/boundary`

**Purpose:** Soft-deletes the entire ESGLink Boundary for a client. The document is marked `isActive: false, isDeleted: true` — it is not removed from the database. After deletion, a new boundary can be created (import or manual).

**Auth:** Required (ESGLink module gate)  
**Roles:** `super_admin`, `consultant_admin` only (consultants cannot delete)

### URL Parameters
| Param | Type | Description |
|-------|------|-------------|
| `clientId` | string | The client's unique ID |

### Success Response — `200 OK`
```json
{
  "success": true,
  "message": "ESGLink Core boundary soft-deleted",
  "data": {
    "boundaryId": "65a1b2c3d4e5f6789012345a",
    "deletedAt": "2026-04-15T11:00:00.000Z"
  }
}
```

### Error Responses
| Status | Code | Description |
|--------|------|-------------|
| 403 | — | Caller is a `consultant` (insufficient role) |
| 403 | — | `consultant_admin` lacks permission for this client |
| 404 | `BOUNDARY_NOT_FOUND` | No active boundary exists to delete |

### Frontend Integration Notes
- After successful deletion, redirect the user to the boundary setup page (import or manual).
- This action is irreversible from the API perspective (no restore endpoint in Step 1). Confirm with the user before calling.

---

## Common Error Shapes

All error responses follow this shape:
```json
{
  "message": "Human-readable description",
  "code": "MACHINE_READABLE_CODE",
  "errors": ["optional array of field-level validation errors"]
}
```

## Common HTTP Status Codes

| Status | Meaning |
|--------|---------|
| 200 | Success (read/update/delete) |
| 201 | Created (new resource) |
| 400 | Bad request / validation error |
| 403 | Forbidden (wrong role or no permission for this client) |
| 404 | Not found (client, boundary, or node) |
| 409 | Conflict (boundary already exists) |
| 500 | Server error |



# TEST CASES 

Below is the simple copy-paste Postman format for both ESGLink Core boundary cases.

Use these env vars in Postman:

* `{{base_url}}` = your backend base URL
* `{{clientId}}` = target clientId
* tokens already available from you:

  * `{{super_admin_token}}`
  * `{{consultant_admin_token}}`
  * `{{consultant_token}}`
  * `{{client_admin_token}}`

The boundary routes are:

* `GET /api/esglink/core/:clientId/boundary/import-availability`
* `POST /api/esglink/core/:clientId/boundary/import-from-zero-carbon`
* `POST /api/esglink/core/:clientId/boundary`
* `GET /api/esglink/core/:clientId/boundary`
* `DELETE /api/esglink/core/:clientId/boundary` 

Use `{{consultant_admin_token}}` first. `{{super_admin_token}}` also works. `{{consultant_token}}` should work only if that consultant is assigned to the client. Based on the current permission helper, `client_admin_token` is not the safe token for create/import here because boundary permissions currently reuse the ZeroCarbon flowchart manage/view permission logic. 

Also note:

* Import from ZeroCarbon works only if the client has both `esg_link` and `zero_carbon`, the client assessment level includes `organization` or `both`, and there is an active ZeroCarbon organization flowchart.  
* Only one active boundary can exist per client, so if one already exists, create/import returns `BOUNDARY_ALREADY_EXISTS`.  
* Imported save copies only structural nodes and edges into ESGLink Core, not scope details, emission factors, API/IoT config, etc. 

## 1) Check whether import from ZeroCarbon is possible

```http
GET {{base_url}}/api/esglink/core/{{clientId}}/boundary/import-availability
Authorization: Bearer {{consultant_admin_token}}
Content-Type: application/json
```

Expected success response:

```json
{
  "success": true,
  "data": {
    "clientId": "GREON001",
    "importAvailable": true,
    "flowchartId": "67fxxxxx",
    "chartVersion": 1
  }
}
```

Possible failure reasons:

* `NO_ZERO_CARBON_MODULE`
* `NO_ORGANIZATION_LEVEL`
* `FLOWCHART_NOT_FOUND`
* `CLIENT_NOT_FOUND`  

## 2) Import organization boundary from ZeroCarbon into ESGLink Core

This request both fetches and saves the boundary.

```http
POST {{base_url}}/api/esglink/core/{{clientId}}/boundary/import-from-zero-carbon
Authorization: Bearer {{consultant_admin_token}}
Content-Type: application/json
```

Body:

```json
{}
```

Expected success response:

```json
{
  "success": true,
  "message": "Boundary imported from ZeroCarbon organisational flowchart (v1)",
  "data": {
    "boundaryId": "67fxxxxx",
    "clientId": "GREON001",
    "setupMethod": "imported_from_zero_carbon",
    "nodeCount": 6,
    "edgeCount": 5,
    "version": 1,
    "importedFrom": {
      "flowchartId": "67exxxxx",
      "chartVersion": 1
    }
  }
}
```

This endpoint creates the ESGLink boundary with:

* `setupMethod: imported_from_zero_carbon`
* copied `nodes`
* copied `edges`
* version `1` 

## 3) Get the saved ESGLink Core boundary

Use this after import or manual create.

```http
GET {{base_url}}/api/esglink/core/{{clientId}}/boundary
Authorization: Bearer {{consultant_admin_token}}
Content-Type: application/json
```

Expected success response:

```json
{
  "success": true,
  "data": {
    "_id": "67fxxxxx",
    "clientId": "GREON001",
    "setupMethod": "imported_from_zero_carbon",
    "nodes": [],
    "edges": [],
    "version": 1,
    "isActive": true
  }
}
```

If nothing exists yet, you get:

```json
{
  "message": "No active boundary found for this client",
  "code": "BOUNDARY_NOT_FOUND"
}
```



---

# 4) Normal manual boundary create

Use this when you want to create the boundary directly, without importing from ZeroCarbon.

```http
POST {{base_url}}/api/esglink/core/{{clientId}}/boundary
Authorization: Bearer {{consultant_admin_token}}
Content-Type: application/json
```

Body:

```json
{
  "nodes": [
    {
      "id": "org-root",
      "label": "Main Organisation",
      "type": "entity",
      "position": { "x": 250, "y": 50 },
      "details": {
        "name": "Main Organisation",
        "department": "",
        "location": "Head Office",
        "entityType": "holding",
        "notes": "Top level entity"
      }
    },
    {
      "id": "site-kochi",
      "label": "Kochi Office",
      "type": "site",
      "position": { "x": 100, "y": 220 },
      "details": {
        "name": "Kochi Office",
        "department": "Operations",
        "location": "Kochi",
        "entityType": "site",
        "notes": ""
      }
    },
    {
      "id": "dept-finance",
      "label": "Finance Department",
      "type": "department",
      "position": { "x": 420, "y": 220 },
      "details": {
        "name": "Finance Department",
        "department": "Finance",
        "location": "Head Office",
        "entityType": "department",
        "notes": ""
      }
    }
  ],
  "edges": [
    {
      "id": "edge-1",
      "source": "org-root",
      "target": "site-kochi",
      "label": "has site"
    },
    {
      "id": "edge-2",
      "source": "org-root",
      "target": "dept-finance",
      "label": "has department"
    }
  ]
}
```

Expected success response:

```json
{
  "success": true,
  "message": "ESGLink Core boundary created manually",
  "data": {
    "boundaryId": "67fxxxxx",
    "clientId": "GREON001",
    "setupMethod": "manual",
    "nodeCount": 3,
    "edgeCount": 2,
    "version": 1
  }
}
```

Manual create validation:

* every node needs `id` and `label`
* every edge needs `id`, `source`, `target`
* every edge source/target must match a node id 

---

# 5) Get manual boundary after save

```http
GET {{base_url}}/api/esglink/core/{{clientId}}/boundary
Authorization: Bearer {{consultant_admin_token}}
Content-Type: application/json
```

---

# 6) Delete existing boundary before testing the second case

Because only one active boundary is allowed, use this if you first imported and then want to test manual create, or vice versa. Delete is only for `super_admin` or `consultant_admin`. 

```http
DELETE {{base_url}}/api/esglink/core/{{clientId}}/boundary
Authorization: Bearer {{consultant_admin_token}}
Content-Type: application/json
```

Expected success response:

```json
{
  "success": true,
  "message": "ESGLink Core boundary soft-deleted",
  "data": {
    "boundaryId": "67fxxxxx",
    "deletedAt": "2026-04-15T10:00:00.000Z"
  }
}
```

---

# 7) Optional: add node after boundary already exists

```http
POST {{base_url}}/api/esglink/core/{{clientId}}/boundary/nodes
Authorization: Bearer {{consultant_admin_token}}
Content-Type: application/json
```

Body:

```json
{
  "node": {
    "id": "dept-hr",
    "label": "HR Department",
    "type": "department",
    "position": { "x": 650, "y": 220 },
    "details": {
      "name": "HR Department",
      "department": "HR",
      "location": "Head Office",
      "entityType": "department",
      "notes": ""
    }
  }
}
```

# 8) Optional: add edge after boundary already exists

```http
POST {{base_url}}/api/esglink/core/{{clientId}}/boundary/edges
Authorization: Bearer {{consultant_admin_token}}
Content-Type: application/json
```

Body:

```json
{
  "edge": {
    "id": "edge-3",
    "source": "org-root",
    "target": "dept-hr",
    "label": "has department"
  }
}
```

These endpoints accept either a single `node` / `edge` object or `nodes` / `edges` array.  

---

# Best testing order

1. `GET /boundary/import-availability`
2. `POST /boundary/import-from-zero-carbon`
3. `GET /boundary`

For manual test:

1. `DELETE /boundary`
2. `POST /boundary`
3. `GET /boundary`

---

# Safest token to use

Use this first in Postman:

```text
Bearer {{consultant_admin_token}}
```

If needed:

```text
Bearer {{super_admin_token}}
```

---

If you want, next I can format this into a cleaner Postman collection style text with request names exactly like:

* `ESGLink - Check Import Availability`
* `ESGLink - Import Boundary from ZeroCarbon`
* `ESGLink - Create Boundary Manually`
* `ESGLink - Get Boundary`
* `ESGLink - Delete Boundary`
