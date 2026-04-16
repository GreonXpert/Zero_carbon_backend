# Formula Module — Implementation Reference

## Why Formula Moved to a Common Module

The original formula system was embedded inside `src/modules/zero-carbon/reduction/`. This created a hard coupling between formula management and the reduction sub-module, making it impossible for ESGLink or future modules to reuse the formula concept without duplicating the code.

**Business requirement:** ESGLink needs formulas for metric computations. Rather than building a second, separate formula system, the formula domain was extracted into a shared common module that all product modules can consume.

**Result:** `src/modules/common/formula/` — a single, module-aware formula system that ZeroCarbon, ESGLink, and any future module can use.

---

## Old Structure vs New Structure

### Old (ZeroCarbon-specific)

```
src/modules/zero-carbon/reduction/
  controllers/FormulaController.js     ← all formula logic (900+ lines)
  models/Formula.js                    ← ReductionFormula schema, clientIds[]
  models/DeleteRequest.js              ← delete request workflow
  routes/FormulaR.js                   ← formula routes + attach route

src/modules/zero-carbon/workflow/notifications/
  formulaNotifications.js              ← notification helpers
```

### New (Common)

```
src/modules/common/formula/
  models/Formula.js                    ← Formula schema, clientId (single)
  models/DeleteRequest.js              ← delete request workflow
  controllers/FormulaController.js     ← thin HTTP adapter
  routes/FormulaR.js                   ← common CRUD + delete-request routes
  services/formulaService.js           ← all business logic
  utils/formulaValidation.js           ← pure validation helpers
  notifications/formulaNotifications.js ← notification helpers
  migrations/migrateFormulas.js        ← data migration script

src/modules/zero-carbon/reduction/
  models/Formula.js                    ← re-export → common model
  models/DeleteRequest.js              ← re-export → common model
  controllers/FormulaController.js     ← re-export → common controller
  controllers/attachFormulaToReduction.js ← reduction-specific (new file)
  routes/FormulaR.js                   ← delegates to common + adds attach route

src/modules/zero-carbon/workflow/notifications/
  formulaNotifications.js              ← re-export → common notifications
```

---

## Schema Explanation

### Formula Schema

| Field | Type | Notes |
|-------|------|-------|
| `name` | String (required) | Formula display name |
| `label` | String | Display label; for `esg_link`, auto-set = `name` |
| `description` | String | Human-readable explanation |
| `link` | String | Documentation/reference URL |
| `unit` | String | Output unit (e.g., tCO2e) |
| `expression` | String (required) | Math expression using variable names (e.g., `A * B`) |
| `variables` | Array | Variable definitions (name, label, unit, updatePolicy) |
| `version` | Number | Manual versioning, default 1 |
| `moduleKey` | String (required) | `zero_carbon` \| `esg_link` |
| `scopeType` | String (required) | `client` \| `team` \| `global` (only `client` is active now) |
| `clientId` | String | Required when `scopeType = "client"` |
| `createdByRole` | String | Captured at creation time for audit |
| `sourceFormulaId` | ObjectId | Set on migration clones; points to the original formula |
| `createdBy` | ObjectId (User) | Who created this formula |
| `isDeleted` | Boolean | Soft-delete flag |

**Collection:** `reduction_formulas` (unchanged for zero migration risk)
**Model Name:** `Formula` (changed from `ReductionFormula`)

### DeleteRequest Schema

| Field | Type | Notes |
|-------|------|-------|
| `formulaId` | ObjectId (ref: Formula) | Formula being requested for deletion |
| `requestedBy` | ObjectId (ref: User) | Consultant who submitted the request |
| `status` | Enum | `pending` \| `approved` \| `rejected` |
| `approvedBy` | ObjectId (ref: User) | Admin who acted on the request |
| `approvedAt` | Date | When the request was processed |
| `reason` | String | Optional reason from the consultant |

---

## Controller / Service Flow

```
HTTP Request
    ↓
reduction/routes/FormulaR.js
    ↓ (delegates to)
common/formula/routes/FormulaR.js
    ↓
common/formula/controllers/FormulaController.js
    ↓ (calls service functions)
common/formula/services/formulaService.js
    ↓ (uses models)
common/formula/models/Formula.js
common/formula/models/DeleteRequest.js
    ↓ (uses helpers)
common/formula/utils/formulaValidation.js
common/formula/notifications/formulaNotifications.js
```

### Service Layer Design

The service layer (`formulaService.js`) contains all business logic:
- All Mongoose queries live here, not in the controller
- Functions accept plain parameters (not `req`/`res`)
- Functions return `{ doc, error }` or `{ data, error, status }` objects
- This makes service functions fully testable in isolation

### Controller Design

The controller (`FormulaController.js`) is a thin HTTP adapter:
- Reads inputs from `req` (params, body, query, user)
- Calls service functions
- Maps service results to HTTP responses
- Contains no Mongoose queries

---

## Route Forwarding Strategy

```
registerRoutes.js:  app.use('/api/formulas', FormulaR)
                              ↓
reduction/routes/FormulaR.js:
  POST /attach/:clientId/:projectId  → attachFormulaToReduction.js (reduction-specific)
  ALL OTHERS → common/formula/routes/FormulaR.js
                              ↓
common/formula/routes/FormulaR.js:
  GET  /delete-requests        → FormulaController.getDeleteRequestedIds
  GET  /delete-requests/filter/query → FormulaController.filterDeleteRequested
  GET  /delete-requests/:id    → FormulaController.getDeleteRequestedById
  POST /delete-requests/:id/approve → FormulaController.approveDeleteRequest
  POST /delete-requests/:id/reject  → FormulaController.rejectDeleteRequest
  POST /                       → FormulaController.createFormula
  GET  /                       → FormulaController.listFormulas
  GET  /:formulaId             → FormulaController.getFormula
  PUT  /:formulaId             → FormulaController.updateFormula
  DELETE /:formulaId/:mode?    → FormulaController.deleteFormula
```

**Key decision:** `registerRoutes.js` does NOT need to change. The reduction `FormulaR.js` file became the pass-through adapter. This means zero impact to the existing route registration.

---

## Migration Strategy

**Script:** `src/modules/common/formula/migrations/migrateFormulas.js`

### Why Migration Is Needed

Old formulas stored `clientIds: [String]` (an array). The new schema uses `clientId: String` (singular). This change was made because sharing one formula document across multiple clients creates ambiguous ownership and makes module-scoped access control complex.

### Migration Algorithm

**Pass 1 — Formula documents:**
```
For each document in reduction_formulas where clientId is not yet set:
  If clientIds is empty → set clientId: null, moduleKey: 'zero_carbon', scopeType: 'client'
  If clientIds has one entry → patch in-place: clientId = clientIds[0]
    (preserves _id — existing Reduction refs still valid)
  If clientIds has multiple entries:
    → patch original in-place for clientIds[0]
    → create new clone document for each clientIds[1..n]
       (clone has new _id, sourceFormulaId = original._id)
```

**Pass 2 — Reduction reference fix (auto-fix):**
```
For each Reduction where m2.formulaRef.formulaId exists:
  Look up the formula by that _id
  If formula.clientId !== reduction.clientId:
    Find the clone where clientId = reduction.clientId AND sourceFormulaId = formula._id
    Update Reduction.m2.formulaRef.formulaId to the clone's _id

Same check for m3.baselineEmissions[].formulaId, m3.projectEmissions[].formulaId, etc.
```

### Running the Migration

```bash
# Dry run (safe, no writes)
node src/modules/common/formula/migrations/migrateFormulas.js

# Apply
node src/modules/common/formula/migrations/migrateFormulas.js --apply
```

**Run order:** Migration MUST be run BEFORE deploying the Phase 3 code changes (model rename). If deployed before migration, the new `clientId`-based queries will return empty results for unmigrated documents.

### Idempotency

The script is safe to re-run. Documents with `clientId` already set are skipped.

---

## Access Control Design

Access is enforced at two levels:

### 1. Route-level: `checkRole(...)`
```js
router.get('/', checkRole('consultant', 'consultant_admin', 'super_admin', 'client_admin', 'auditor'), ctrl.listFormulas);
```

### 2. Service-level: role-based query scoping
```
super_admin     → all formulas
consultant_admin → formulas created by their team (team = themselves + their consultants)
consultant      → formulas for assigned clients OR created by team
client_admin    → formulas for their own clientId only
auditor         → formulas for their own clientId only
```

This dual-layer prevents consultant A from seeing consultant B's formulas even if both are in the system.

### Why Full User Fetch for Consultant

The auth middleware attaches a partial user object to `req.user`. `assignedClients` is not guaranteed to be present. The service layer explicitly calls `User.findById(userId)` to get the full document when `consultant` role needs `assignedClients` or `consultantAdminId`.

---

## Module-Aware Behavior

Each formula carries `moduleKey`. This enables:

1. **Filtering:** `GET /api/formulas?moduleKey=esg_link` returns only ESGLink formulas
2. **Future subscription checks:** `requireActiveModuleSubscription('esg_link')` can be added per route
3. **ESGLink label enforcement:** Checked in service before every create/update

To add a new module in the future:
1. Add the new key to `moduleKey` enum in `Formula.js`
2. Add to `VALID_MODULE_KEYS` in `formulaValidation.js`
3. Add any module-specific business rules in `formulaService.js`
4. The routes and controller require no changes

---

## ESGLink Special Handling

ESGLink formulas have a special constraint: `label` must always equal `name`.

**Implementation:** In `formulaService.js`, after all field updates are applied, the `coerceEsgLinkLabel` helper is called:

```js
// formulaValidation.js
function coerceEsgLinkLabel(moduleKey, name, label) {
  if (moduleKey === 'esg_link') {
    return name; // always force label = name
  }
  return label !== undefined ? label : '';
}
```

This runs on both create and update. The enforcement is in the service layer (not the Mongoose schema) so that clear validation error messages can be returned.

**Why label exists at all for ESGLink:** ESGLink formulas may be displayed in UI contexts where `name` serves as both the technical identifier and the display text. Keeping `label` = `name` avoids divergence while still having the field available for possible future differentiation.

---

## Future Scalability

The design supports adding new modules with zero structural changes:

| Extension Point | How to Extend |
|----------------|--------------|
| New module | Add `moduleKey` enum value + `VALID_MODULE_KEYS` entry |
| Team scope | Enable `scopeType: 'team'` in business logic when ready |
| Global scope | Enable `scopeType: 'global'` in business logic when ready |
| Module subscription gates | Add `requireActiveModuleSubscription('newModule')` in routes |
| Module-specific validation | Add an `if (moduleKey === 'newModule')` block in service |

The collection name (`reduction_formulas`) can be renamed to `common_formulas` in a future dedicated DB migration once all systems are stable.

---

## Affected Files

### New Files Created

| File | Description |
|------|-------------|
| `src/modules/common/formula/models/Formula.js` | Authoritative formula schema |
| `src/modules/common/formula/models/DeleteRequest.js` | Authoritative delete request schema |
| `src/modules/common/formula/controllers/FormulaController.js` | HTTP adapter |
| `src/modules/common/formula/routes/FormulaR.js` | Common routes (CRUD + delete requests) |
| `src/modules/common/formula/services/formulaService.js` | All business logic |
| `src/modules/common/formula/utils/formulaValidation.js` | Pure validation helpers |
| `src/modules/common/formula/notifications/formulaNotifications.js` | Notification helpers |
| `src/modules/common/formula/migrations/migrateFormulas.js` | Data migration script |
| `src/modules/zero-carbon/reduction/controllers/attachFormulaToReduction.js` | Extracted attach controller |
| `Document/Esg_link/common/api.formula.md` | API documentation |
| `Document/Esg_link/common/implementation.formula.md` | This file |

### Modified Files (Existing)

| File | Change |
|------|--------|
| `src/modules/zero-carbon/reduction/models/Formula.js` | Re-export to common model |
| `src/modules/zero-carbon/reduction/models/DeleteRequest.js` | Re-export to common model |
| `src/modules/zero-carbon/reduction/controllers/FormulaController.js` | Re-export to common controller |
| `src/modules/zero-carbon/reduction/routes/FormulaR.js` | Delegate to common + keep attach route |
| `src/modules/zero-carbon/workflow/notifications/formulaNotifications.js` | Re-export to common notifications |
| `src/modules/zero-carbon/reduction/models/Reduction.js` | `ref: 'ReductionFormula'` → `ref: 'Formula'` (3 places) |
| `src/modules/zero-carbon/reduction/models/NetReductionEntry.js` | `ref: 'ReductionFormula'` → `ref: 'Formula'` |
| `src/modules/zero-carbon/reduction/controllers/reductionController.js` | Added `require` for common Formula model in `computeInternalValue` |

### Unchanged Files

| File | Reason |
|------|--------|
| `src/app/bootstrap/registerRoutes.js` | Re-export chain handles transparently |
| `src/modules/zero-carbon/reduction/controllers/netReductionController.js` | Uses `require('../models/Formula')` which now re-exports common model |
| `src/common/middleware/auth.js` | No change needed |
| All emission factor / flowchart / other routes | No formula references |

---

## Testing Checklist

### Formula CRUD

- [ ] `consultant` can create formula for `zero_carbon` assigned client → `201` with correct `moduleKey`/`clientId`
- [ ] `consultant` can create formula for `esg_link` assigned client → `label` auto-set to `name`
- [ ] `consultant_admin` can create formula → formula appears in team list
- [ ] `super_admin` can create, view, update, delete any formula
- [ ] `client_admin` receives `403` on create, update, delete
- [ ] `auditor` receives `403` on create, update, delete
- [ ] Unauthenticated request returns `401`
- [ ] Invalid `moduleKey` returns `400`
- [ ] Missing `clientId` when `scopeType=client` returns `400`
- [ ] Invalid expression returns `400`
- [ ] `client_admin` can list/get formulas for their own client only
- [ ] `auditor` can list/get formulas for their own client only
- [ ] `consultant` cannot access formulas for a non-assigned client → `403`

### ESGLink

- [ ] Create formula with `moduleKey: "esg_link"` → `label` in response equals `name`
- [ ] Update `name` of esg_link formula → `label` updated to match
- [ ] Sending custom `label` with esg_link formula → `label` overridden to `name`

### Backward Compatibility

- [ ] `POST /api/formulas` with `clientIds: ["Greon001"]` (old format) still creates formula with `clientId: "Greon001"`
- [ ] Old reduction data entry flow (M2 methodology) still works after model rename
- [ ] `Reduction.m2.formulaRef.formulaId.populate()` resolves correctly
- [ ] `NetReductionEntry.formulaId.populate()` resolves correctly

### Delete Request Flow

- [ ] Consultant sends `DELETE /api/formulas/:id` → `200` with pending request
- [ ] Same consultant sends again → `200` "already pending"
- [ ] `consultant_admin` approves → formula soft-deleted, consultant notified
- [ ] `consultant_admin` rejects → formula preserved, consultant notified
- [ ] `consultant_admin` direct `DELETE` → formula soft-deleted, pending requests auto-approved
- [ ] `super_admin` hard `DELETE` on attached formula → `409` blocked
- [ ] `super_admin` hard `DELETE` on unattached formula → formula removed

### Attach Formula to Reduction

- [ ] `POST /api/formulas/attach/:clientId/:projectId` with M2 project → formula attached
- [ ] Attach to M1 or M3 project → `400`
- [ ] Missing `variableKinds` for a variable → `400`
- [ ] Frozen variable without `frozenValues` → `400`

### Migration

- [ ] `node migrateFormulas.js` (dry run) produces correct report
- [ ] Single-client formula: patched in-place, same `_id`
- [ ] Multi-client formula: original + N-1 clones, each with correct `clientId`
- [ ] Clones have `sourceFormulaId` set
- [ ] Reduction m2 refs fixed where `formula.clientId !== reduction.clientId`
- [ ] Re-running migration: all documents skipped (idempotent)

---

## Risks and Manual Checks

| Risk | Mitigation | Manual Check |
|------|-----------|-------------|
| Model rename causes OverwriteModelError | Phase 4 re-exports ensure only one registration at runtime | Check app startup logs for model registration errors |
| Migration deployed after code cutover | Script must run first; startup warning if any doc has `clientIds` but no `clientId` | Check DB for `clientId: { $exists: false }` in `reduction_formulas` after deploy |
| Reduction ref mismatch after migration | Pass 2 auto-fixes refs | Verify by querying Reduction docs where `m2.formulaRef.formulaId` populates `formula.clientId !== reduction.clientId` |
| ESGLink module access | Users must have `esg_link` in `accessibleModules` | Test with user who has only `zero_carbon` — should get `403` on esg_link formula |
| `expr-eval` security | Expression evaluated server-side in reduction calculations | Expressions are created by trusted consultant roles only, not end users |
