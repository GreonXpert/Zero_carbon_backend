# ESGLink Client Management — Implementation Notes

## Overview

This document describes the changes made to the `createClient` pipeline to support clients whose `accessibleModules` includes `esg_link`. All changes are **additive** — no existing ZeroCarbon logic was modified or removed. Clients that only have `zero_carbon` in `accessibleModules` follow the exact same path as before.

---

## Files Created

| File | Purpose |
|---|---|
| `src/modules/esg-link/utils/esgLinkAssessmentLevel.js` | Validation helper for `esgLinkAssessmentLevel` |
| `src/modules/esg-link/workflow/pdfTemplates.js` | HTML renderer for ESGLink client data PDF |
| `Document/Esg_link/clientManagementEsgLink.md` | This document |

## Files Modified

| File | What Changed |
|---|---|
| `src/modules/client-management/client/Client.js` | Added `esgLinkAssessmentLevel` field to `submissionData` sub-schema |
| `src/modules/client-management/client/clientController.js` | Modified `createLead`, `submitClientData`, `moveToProposal`, `moveToActive`; added new imports |

## Files NOT Changed

- `src/modules/zero-carbon/workflow/assessmentLevel.js`
- `src/modules/client-management/client/clientR.js`
- `src/modules/client-management/quota/` (all files)
- Any zero-carbon module files

---

## Schema Changes — `Client.js`

### `submissionData.esgLinkAssessmentLevel` (new field)

Added inside the `submissionData` sub-schema, after the existing `assessmentLevel` field:

```js
esgLinkAssessmentLevel: {
  module: {
    type: String,
    enum: ['esg_link_core'],
    default: null
  },
  frameworks: {
    type: [String],
    enum: ['BRSR', 'GRI', 'TCFD', 'CDP', 'SASB', 'UNGC', 'ISO_26000', 'SDG'],
    default: []
  }
}
```

**Rules:**
- `module` is optional — can be `null` or `"esg_link_core"`
- `frameworks` is optional and multi-select — zero or more of the 8 allowed values
- At least one of `module` (non-null) or `frameworks` (non-empty) must be present when an ESGLink client submits data

---

## New Files

### `src/modules/esg-link/utils/esgLinkAssessmentLevel.js`

Exports:
- `validateEsgLinkAssessmentLevel(obj)` → `string[]` (array of error messages, empty if valid)
- `ALLOWED_MODULES = ['esg_link_core']`
- `ALLOWED_FRAMEWORKS = ['BRSR', 'GRI', 'TCFD', 'CDP', 'SASB', 'UNGC', 'ISO_26000', 'SDG']`

### `src/modules/esg-link/workflow/pdfTemplates.js`

Exports:
- `renderEsgLinkClientDataHTML(client)` → HTML string

Renders: company info, primary/alternate contact, ESGLink assessment level (module + framework badges). Used at `submitClientData` stage to generate the PDF attachment.

---

## Stage-by-Stage Changes

### Stage 1 — Lead (`createLead`)

**New behaviour:**
- Accepts `accessibleModules` from `req.body` (array of `'zero_carbon'` and/or `'esg_link'`)
- Defaults to `['zero_carbon']` if not provided (backward compatible)
- Validates: non-empty array, each item in allowed list
- Saves `accessibleModules` on the new `Client` document
- Timeline note updated: `"Lead created by <name> with modules: [...]"`

**Backward compatibility:** Existing callers that omit `accessibleModules` get `['zero_carbon']` — same behaviour as before.

---

### Stage 2 — Data Submission (`submitClientData`)

**New branching logic** (after email validation, step 5):

```
const modules       = client.accessibleModules || ['zero_carbon'];
const hasZeroCarbon = modules.includes('zero_carbon');
const hasEsgLink    = modules.includes('esg_link');
```

| Client modules | ZeroCarbon validation | ESGLink validation | Required fields |
|---|---|---|---|
| `['zero_carbon']` | Runs (unchanged) | Skipped | `companyInfo`, `assessmentLevel`, ZC-specific fields |
| `['esg_link']` | Skipped | Runs | `companyInfo`, `esgLinkAssessmentLevel` |
| `['zero_carbon', 'esg_link']` | Runs (unchanged) | Runs | Both sets |

**`submissionData` save:** Both `assessmentLevel` (ZC) and `esgLinkAssessmentLevel` (ESGLink) are conditionally included.

**Email/PDF:**
- ZeroCarbon clients → PDF via `renderClientDataHTML` + `sendClientDataSubmittedEmail` (unchanged)
- ESGLink clients → PDF via `renderEsgLinkClientDataHTML` + `sendClientDataSubmittedEmail` (new)
- Both-module clients → both PDFs sent separately (each in their own try-catch)

---

### Stage 3 — Proposal (`moveToProposal`)

No stage/status changes — the toggle logic is already module-agnostic.

**Email/PDF** (inside the existing non-blocking try-catch):
- ZeroCarbon clients → PDF via `renderClientDataHTML` + `sendProposalCreatedEmail` (unchanged)
- ESGLink clients → Plain email via `sendMail` (no PDF) to `client.leadInfo.email`
- Both-module clients → ZeroCarbon PDF sent; ESGLink plain email also sent

---

### Stage 4 — Quota (`markQuotaCreated`)

No changes. The `ConsultantClientQuota` model already has ESGLink user-type entries (`contributor`, `reviewer`, `approver`).

---

### Stage 5 — Active (`moveToActive`)

**New block** (after ZeroCarbon subscription initialization, step 4b):

```js
if (
  client.accessibleModules?.includes('esg_link') &&
  !client.accountDetails?.esgLinkSubscription?.subscriptionEndDate
) {
  client.set('accountDetails.esgLinkSubscription', {
    subscriptionStatus: 'active',
    isActive: true,
    subscriptionStartDate: new Date(),
    subscriptionEndDate: zcEnd || new Date(Date.now() + subscriptionDays * 24 * 60 * 60 * 1000),
  });
  client.markModified('accountDetails.esgLinkSubscription');
}
```

Uses the same guard pattern as `updateClientModuleAccess` (~line 5298) — checking `subscriptionEndDate` to safely handle Mongoose absent-subdoc virtualization.

---

## API Behaviour

### POST `/api/clients/lead`

| `accessibleModules` in body | Result |
|---|---|
| Not provided | `['zero_carbon']` — backward compatible |
| `["esg_link"]` | Lead with `accessibleModules: ["esg_link"]` |
| `["zero_carbon", "esg_link"]` | Lead with both modules |
| `["invalid_module"]` | `400` — validation error |

---

### POST `/api/clients/:clientId/submit-data`

**ESGLink-only client:**
```json
{
  "companyInfo": { "companyName": "Acme", "companyAddress": "...", "primaryContactPerson": { ... } },
  "esgLinkAssessmentLevel": { "module": "esg_link_core", "frameworks": ["BRSR", "GRI"] }
}
```
→ `200`. ZeroCarbon fields NOT required.

**Both-module client:**
```json
{
  "companyInfo": { ... },
  "assessmentLevel": ["organization"],
  "organizationalOverview": { ... },
  "emissionsProfile": { ... },
  "esgLinkAssessmentLevel": { "module": "esg_link_core", "frameworks": ["TCFD"] }
}
```
→ `200`. Both assessments saved. Both PDFs emailed.

**ESGLink, frameworks only (no module):**
```json
{ "companyInfo": { ... }, "esgLinkAssessmentLevel": { "frameworks": ["BRSR", "GRI"] } }
```
→ `200`. Valid — `module` is optional.

**ESGLink, module only (no frameworks):**
```json
{ "companyInfo": { ... }, "esgLinkAssessmentLevel": { "module": "esg_link_core" } }
```
→ `200`. Valid — `frameworks` defaults to `[]`.

**ESGLink, completely empty assessmentLevel:**
```json
{ "companyInfo": { ... }, "esgLinkAssessmentLevel": {} }
```
→ `400` — `esgLinkAssessmentLevel must include at least a module or one or more frameworks`.

---

## Testing Checklist

- [ ] `POST /api/clients/lead` without `accessibleModules` → ZeroCarbon lead created (backward compatible)
- [ ] `POST /api/clients/lead` with `accessibleModules: ["esg_link"]` → ESGLink lead
- [ ] `POST /api/clients/lead` with `accessibleModules: ["zero_carbon", "esg_link"]` → both modules
- [ ] `POST /api/clients/lead` with `accessibleModules: ["bad_value"]` → 400 error
- [ ] `POST /:id/submit-data` (ESGLink-only) with valid `esgLinkAssessmentLevel` → 200, PDF emailed
- [ ] `POST /:id/submit-data` (ESGLink-only) with `esgLinkAssessmentLevel: {}` → 400 error
- [ ] `POST /:id/submit-data` (ESGLink-only) with frameworks only → 200
- [ ] `POST /:id/submit-data` (ESGLink-only) with module only → 200
- [ ] `POST /:id/submit-data` (ZeroCarbon-only) without `esgLinkAssessmentLevel` → 200 (unchanged)
- [ ] `POST /:id/submit-data` (both modules) with all required fields → 200, both PDFs sent
- [ ] `PATCH /:id/move-to-proposal` (ESGLink-only) → plain email sent, no crash
- [ ] `PATCH /:id/move-to-proposal` (ZeroCarbon-only) → PDF email sent (unchanged)
- [ ] `PATCH /:id/move-to-active` (ESGLink client) → `esgLinkSubscription` initialized
- [ ] `PATCH /:id/move-to-active` (ZeroCarbon-only) → `esgLinkSubscription` NOT initialized
