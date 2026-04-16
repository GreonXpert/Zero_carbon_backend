# ESGLink Access Control — Implementation Guide

## Architecture Overview

ESGLink access control sits **alongside** the existing ZeroCarbon `accessControls` system. The two systems are fully independent:

| Field | Applies To | Roles Enforced |
|---|---|---|
| `User.accessControls` | ZeroCarbon modules | `viewer`, `auditor` |
| `User.esgAccessControls` | ESGLink modules | `contributor`, `reviewer`, `approver` |

Both use a fail-closed model: all permissions default to `false` and must be explicitly granted by `client_admin`.

---

## Files Changed

### 1. `src/common/utils/Permissions/accessControlPermission.js`

**What was added:**

- `ESG_VALID_MODULES` — Set of 5 ESGLink module keys
- `ESG_VALID_SECTIONS` — Section key arrays per ESGLink module
- `ALLOWED_FRAMEWORK_SECTIONS` — The 8 supported ESG framework names
- `CHECKLIST_ROLES` extended — now includes `contributor`, `reviewer`, `approver`
- `buildClosedEsgChecklist()` — returns a fully-closed `esgAccessControls` object
- `validateAndSanitizeEsgChecklist(rawChecklist, clientFrameworks)` — validates and sanitizes incoming payload; enforces framework subset constraint
- `hasEsgModuleAccess(user, moduleKey)` — module-level access check for ESGLink
- `hasEsgSectionAccess(user, moduleKey, sectionKey)` — section-level access check for ESGLink

**Why `CHECKLIST_ROLES` was extended:**

`isChecklistRole()` is called by both the ZeroCarbon (`hasModuleAccess`) and ESGLink (`hasEsgModuleAccess`) helpers. Adding the new roles to `CHECKLIST_ROLES` ensures checklist enforcement is applied for ESGLink roles too. Since `contributor`/`reviewer`/`approver` users have no `accessControls.modules` values (their ZeroCarbon checklist is empty/false by default), the ZeroCarbon fail-closed behaviour is preserved automatically.

---

### 2. `src/common/models/User.js`

**What was added:**

A new top-level field `esgAccessControls` placed after the existing `accessControls` block. The schema mirrors the ESGLink module/section structure exactly. All fields are `Boolean` with `default: false`.

Framework sections (`BRSR`, `GRI`, `TCFD`, `CDP`, `SASB`, `UNGC`, `ISO_26000`, `SDG`) are static boolean fields matching `ALLOWED_FRAMEWORK_SECTIONS`.

---

### 3. `src/common/controllers/user/userController.js`

**Imports updated:**

```javascript
const {
  validateAndSanitizeChecklist,
  VIEWER_DEFAULT_CHECKLIST,
  AUDITOR_DEFAULT_CHECKLIST,
  validateAndSanitizeEsgChecklist,  // 🆕
  buildClosedEsgChecklist,          // 🆕
} = require('../../utils/Permissions/accessControlPermission');
```

**`createContributor` / `createReviewer` / `createApprover`:**

After the `new User(...)` call, an ESGLink access control block resolves `esgAccessControls`:

1. If `req.body.esgAccessControls` is provided → fetches client's enabled frameworks → validates → assigns sanitized checklist
2. If not provided → assigns `buildClosedEsgChecklist()` (fully closed)

**`updateUser`:**

After the existing `accessControls` update block, a new `esgAccessControls` block:

1. Checks that the actor is `client_admin` or `super_admin` — otherwise strips silently
2. Verifies target user has `esg_link` in `accessibleModules` — otherwise returns 400
3. Fetches client frameworks → validates → assigns sanitized checklist

---

## Using the Access Helpers in Routes

### Module-level guard (middleware)

```javascript
const { hasEsgModuleAccess } = require('../../utils/Permissions/accessControlPermission');

// Inline in a controller:
if (!hasEsgModuleAccess(req.user, 'dataCollectionEsgLink')) {
  return res.status(403).json({ message: 'Access denied to dataCollectionEsgLink.' });
}
```

### Section-level guard

```javascript
const { hasEsgSectionAccess } = require('../../utils/Permissions/accessControlPermission');

// Inline in a controller — strip restricted fields from response:
if (!hasEsgSectionAccess(req.user, 'dataCollectionEsgLink', 'editHistory')) {
  delete responsePayload.editHistory;
}
```

### When not to check

For `client_admin`, `super_admin`, `consultant_admin`, `consultant` roles: `isChecklistRole()` returns `false`, so both helpers return `true` (pass-through). No explicit role check needed in route code.

---

## Framework Validation Flow

```
POST /api/users/contributor  (with esgAccessControls.modules.framework.sections.TCFD: true)
         │
         ▼
validateAndSanitizeEsgChecklist(rawChecklist, clientFrameworks)
         │
         ├─ Is 'TCFD' in ALLOWED_FRAMEWORK_SECTIONS? → No → 400 "Unknown framework"
         │
         ├─ Is 'TCFD' in clientFrameworks?           → No → 400 "Framework not enabled for client"
         │
         └─ Yes to both → sanitized checklist stored on user.esgAccessControls
```

`clientFrameworks` is sourced from:
```
Client.submissionData.esgLinkAssessmentLevel.frameworks
```

---

## Data Flow Summary

```
client_admin creates contributor
    │
    ├─ req.body.esgAccessControls provided?
    │    ├─ Yes → fetch Client.submissionData.esgLinkAssessmentLevel.frameworks
    │    │         → validateAndSanitizeEsgChecklist()
    │    │         → user.esgAccessControls = sanitized
    │    └─ No  → user.esgAccessControls = buildClosedEsgChecklist()
    │
    └─ user.save()

contributor accesses /esg-link/data-collection
    │
    └─ hasEsgModuleAccess(req.user, 'dataCollectionEsgLink')
         ├─ user.userType === 'contributor' → isChecklistRole() = true
         ├─ user.esgAccessControls.modules.dataCollectionEsgLink.enabled === true?
         │    ├─ true  → allowed
         │    └─ false → 403 Access denied
         └─ (for client_admin) isChecklistRole() = false → allowed
```

---

## Adding ESGLink Section Checks to New Routes

When building a new ESGLink route/controller that should respect section-level permissions:

```javascript
const { hasEsgSectionAccess, hasEsgModuleAccess } = require('../../../../common/utils/Permissions/accessControlPermission');

// Check module first, then section
if (!hasEsgModuleAccess(req.user, 'metrics')) {
  return res.status(403).json({ message: 'No access to metrics module.' });
}

// For section-level restriction within the response:
const response = { ...metricData };
if (!hasEsgSectionAccess(req.user, 'metrics', 'create')) {
  delete response.createEndpoint; // or block the entire POST
}
```
