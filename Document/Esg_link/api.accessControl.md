# ESGLink Access Control — API Reference

## Overview

ESGLink access control is a fine-grained, fail-closed permission checklist stored on the `User` document as `esgAccessControls`. It applies to users whose `accessibleModules` contains `'esg_link'` and whose `userType` is one of `contributor`, `reviewer`, or `approver` (checklist-enforced roles).

---

## Module & Section Reference

| Module Key | Sections |
|---|---|
| `dataCollectionEsgLink` | `list`, `detail`, `submit`, `editHistory` |
| `esgLinkBoundary` | `view`, `edit`, `assign` |
| `metrics` | `list`, `detail`, `create`, `edit` |
| `formula` | `list`, `detail`, `create`, `edit` |
| `framework` | `BRSR`, `GRI`, `TCFD`, `CDP`, `SASB`, `UNGC`, `ISO_26000`, `SDG` |

### Framework validation rule

Framework sections in `esgAccessControls.modules.framework.sections` can only be set to `true` if the framework is listed in the client's `submissionData.esgLinkAssessmentLevel.frameworks`. Attempting to enable a framework the client has not activated returns HTTP 400.

---

## Endpoints

### POST — Create Contributor

```
POST /api/users/contributor
Authorization: Bearer <client_admin token>
```

**Body:**

```json
{
  "email": "contributor@example.com",
  "password": "Secret123!",
  "contactNumber": "9876543210",
  "userName": "john_contributor",
  "address": "123 Main St",
  "esgAccessControls": {
    "modules": {
      "dataCollectionEsgLink": {
        "enabled": true,
        "sections": { "list": true, "detail": true, "submit": true, "editHistory": false }
      },
      "esgLinkBoundary": {
        "enabled": true,
        "sections": { "view": true, "edit": false, "assign": false }
      },
      "metrics": {
        "enabled": true,
        "sections": { "list": true, "detail": true, "create": false, "edit": false }
      },
      "formula": {
        "enabled": false,
        "sections": {}
      },
      "framework": {
        "enabled": true,
        "sections": { "BRSR": true, "GRI": true }
      }
    }
  }
}
```

> If `esgAccessControls` is omitted, a fully-closed (all `false`) checklist is applied automatically.

**Success Response — 201:**

```json
{
  "message": "Contributor created successfully",
  "contributor": {
    "id": "64f1a2b3c4d5e6f7a8b9c0d1",
    "email": "contributor@example.com",
    "userName": "john_contributor"
  }
}
```

---

### POST — Create Reviewer

```
POST /api/users/reviewer
Authorization: Bearer <client_admin token>
```

Same `esgAccessControls` body shape as Contributor. Reviewer default permissions: `canViewReports: true`, `canSubmitData: false`.

---

### POST — Create Approver

```
POST /api/users/approver
Authorization: Bearer <client_admin token>
```

Same `esgAccessControls` body shape. Approver default permissions: `canViewReports: true`, `canSubmitData: false`.

---

### PATCH — Update User's esgAccessControls

```
PATCH /api/users/:userId
Authorization: Bearer <client_admin or super_admin token>
```

**Body (partial — only include what you want to update):**

```json
{
  "esgAccessControls": {
    "modules": {
      "dataCollectionEsgLink": {
        "enabled": true,
        "sections": { "list": true, "detail": true, "submit": false, "editHistory": false }
      },
      "framework": {
        "enabled": true,
        "sections": { "BRSR": true }
      }
    }
  }
}
```

**Success Response — 200:**

```json
{
  "message": "User updated successfully",
  "user": { ... }
}
```

---

## Error Responses

### Framework not enabled for client — 400

```json
{
  "success": false,
  "message": "Framework \"TCFD\" is not enabled for this client. Client's enabled frameworks: BRSR, GRI. Please enable the framework for this client before granting user access to it."
}
```

### Unknown framework key — 400

```json
{
  "success": false,
  "message": "Unknown framework \"XYZ\". Allowed frameworks: BRSR, GRI, TCFD, CDP, SASB, UNGC, ISO_26000, SDG"
}
```

### User does not have esg_link module — 400

```json
{
  "success": false,
  "message": "Cannot set esgAccessControls for a user without esg_link module access."
}
```

### Invalid payload shape — 400

```json
{
  "success": false,
  "message": "esgAccessControls.modules must be an object."
}
```

---

## Validation Rules Summary

| Rule | Behaviour |
|---|---|
| Unknown module key | Silently stripped |
| Unknown framework key | 400 error |
| Framework `true` but not in client's enabled list | 400 error |
| `esgAccessControls` set on non-esg_link user | 400 error |
| `esgAccessControls` omitted on create | Defaults to fully-closed checklist |
| Non-admin sets `esgAccessControls` on update | Silently stripped |

---

## Default (Fail-Closed) Checklist

When no `esgAccessControls` is provided at creation time, the following structure is stored (all `false`):

```json
{
  "modules": {
    "dataCollectionEsgLink": { "enabled": false, "sections": { "list": false, "detail": false, "submit": false, "editHistory": false } },
    "esgLinkBoundary":       { "enabled": false, "sections": { "view": false, "edit": false, "assign": false } },
    "metrics":               { "enabled": false, "sections": { "list": false, "detail": false, "create": false, "edit": false } },
    "formula":               { "enabled": false, "sections": { "list": false, "detail": false, "create": false, "edit": false } },
    "framework":             { "enabled": false, "sections": { "BRSR": false, "GRI": false, "TCFD": false, "CDP": false, "SASB": false, "UNGC": false, "ISO_26000": false, "SDG": false } }
  }
}
```
