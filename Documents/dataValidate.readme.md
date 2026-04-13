# Threshold Verification & Approval Flow — Developer Reference

## Overview

This document describes the **Threshold Verification and Approval Flow** added to the ZeroCarbon backend. When a `consultant_admin` configures a threshold percentage for a client's scope/project, any incoming emission or net-reduction data that deviates beyond that threshold from the historical average is **intercepted before saving**, held in a `PendingApproval` record, and the `consultant_admin` is notified. Only after explicit approval is the entry finalized in the main collection.

---

## Architecture Chosen

**Service-layer interception with a separate PendingApproval collection.**

- Verification is a pure service (`thresholdVerificationService.js`) called by each controller before any Mongoose document is created.
- No pre-save hooks are used (avoids unintended side-effects on bulk operations).
- Anomalous entries are stored in a dedicated `PendingApproval` collection — they never touch `DataEntry` or `NetReductionEntry` until approved.
- This prevents anomalous values from affecting dashboards, cumulative calculations, or summary queries.

---

## Files Created

| File | Path | Purpose |
|------|------|---------|
| ThresholdConfig model | `models/ThresholdConfig/ThresholdConfig.js` | Stores per-client, per-scope threshold configuration |
| PendingApproval model | `models/PendingApproval/PendingApproval.js` | Holds intercepted entries awaiting approval |
| normalizationService | `services/verification/normalizationService.js` | Converts raw values to daily baseline |
| historicalAverageService | `services/verification/historicalAverageService.js` | Queries approved historical records, computes average |
| thresholdVerificationService | `services/verification/thresholdVerificationService.js` | Orchestrates the full check, returns decision |
| thresholdVerificationController | `controllers/verification/thresholdVerificationController.js` | HTTP handlers for config CRUD and approval actions |
| verificationRoutes | `router/verification/verificationRoutes.js` | Route definitions |
| thresholdNotifications | `utils/notifications/thresholdNotifications.js` | Notification helpers for anomaly and outcome events |

---

## Files Modified

| File | What Changed |
|------|-------------|
| `controllers/Organization/dataCollectionController.js` | Added threshold check in `saveOneEntry()`, `saveAPIData()`, `saveIoTData()`. Updated `saveManualData` and `uploadCSVData` response to include `pendingApprovals`. |
| `controllers/Reduction/netReductionController.js` | Added threshold check in M1, M2 (inside `saveManualNetReduction()`), and M3 (`saveM3NetReduction()`). |
| `index.js` | Added import and mount of `/api/verification` routes. |

---

## How Threshold Logic Works

### 1. Configuration

A `consultant_admin` creates a `ThresholdConfig` record per:
- `clientId` — the client this config applies to
- `scopeIdentifier` — for DataEntry: the emission scope ID; for NetReduction: the `projectId`
- `flowType` — `'dataEntry'` or `'netReduction'`
- `nodeId` (optional) — restrict to a specific node; if `null`, applies to all nodes with that scope

Key config fields:
| Field | Description | Default |
|-------|-------------|---------|
| `thresholdPercentage` | Allowed deviation % before anomaly triggers | required |
| `isActive` | Enable/disable without deleting | `true` |
| `baselineSampleSize` | Number of historical records to average | `10` |
| `appliesToInputTypes` | Restrict to specific input types (empty = all) | `[]` |

### 2. Daily Normalization

All values are normalized to a **daily baseline** before comparison, so entries from different collection frequencies are fairly compared.

| Frequency | Divisor |
|-----------|---------|
| `real-time` | 1 |
| `daily` | 1 |
| `weekly` | 7 |
| `monthly` | 30 |
| `quarterly` | 90 |
| `half-yearly` | 182 |
| `annually` | 365 |

If frequency is unknown, defaults to `monthly` (divisor: 30).

**Formula:**
```
dailyValue = rawValue / divisor
```

### 3. Historical Average Computation

For **DataEntry**:
- Query: `DataEntry.find({ clientId, nodeId, scopeIdentifier, approvalStatus: { $in: ['auto_approved', 'approved'] }, isSummary: false }).sort({ timestamp: -1 }).limit(baselineSampleSize)`
- Raw value per entry = **sum of all values in the `dataValues` Map**
- Each raw value is normalized to daily, then averaged

For **NetReductionEntry**:
- Query: `NetReductionEntry.find({ clientId, projectId, calculationMethodology }).sort({ timestamp: -1 }).limit(baselineSampleSize)`
- Raw value per entry = `entry.netReduction`

### 4. Anomaly Detection Formula

```
deviation = |incomingDailyValue - historicalAverageDailyValue|
deviationPercentage = (deviation / historicalAverageDailyValue) * 100

if deviationPercentage > thresholdPercentage → ANOMALY
```

**Example:**
- Historical average daily = 2 units
- Threshold = 50%
- Max allowed deviation = 1 (2 × 0.5)
- Incoming raw value = 25 units (monthly), daily normalized = 25/30 = 0.833
- Deviation = |0.833 - 2| = 1.167
- Deviation % = (1.167 / 2) × 100 = 58.35%
- 58.35% > 50% → ANOMALY triggered

### 5. Safety Guards (Skip Check)

| Condition | Action |
|-----------|--------|
| No ThresholdConfig for scope | Save normally |
| `isActive: false` | Save normally |
| `sampleCount < 3` (insufficient history) | Save normally |
| `historicalAverage === 0` | Save normally (avoids division by zero) |
| `appliesToInputTypes` set, inputType not in list | Save normally |
| `_bypassThreshold: true` (approval finalization) | Save normally |
| Threshold check throws an error | Log error, save normally (non-fatal) |

---

## Flow of Control

### Normal Save (No Anomaly)

```
Request → Controller → thresholdVerificationService.checkDataEntry()
  → ThresholdConfig not found OR deviation ≤ threshold
  → { shouldRequireApproval: false }
  → DataEntry / NetReductionEntry saved normally
  → Response: { success: true, ... }
```

### Anomalous Save (Threshold Exceeded)

```
Request → Controller → thresholdVerificationService.checkDataEntry()
  → deviation > threshold
  → { shouldRequireApproval: true, meta: {...} }
  → PendingApproval.create({ status: 'Pending_Approval', originalPayload, verificationMeta })
  → notifyConsultantAdminOfAnomaly() → Notification.create()
  → return { intercepted: true, pendingApproval }
  → DataEntry NOT saved
  → Response: { success: false, intercepted: true, pendingApprovalId, verificationMeta }
```

### Approval Finalization

```
consultant_admin → POST /api/verification/pending-approvals/:id/approve
  → Load PendingApproval (status must be 'Pending_Approval')
  → Reconstruct DataEntry / NetReductionEntry from originalPayload
  → Save to target collection
  → Trigger emission calculation (async, DataEntry) or NR summary (async, NetReduction)
  → PendingApproval.status = 'Approved', finalizedEntryId set
  → notifySubmitterOfOutcome('Approved')
  → Response: { success: true, finalizedEntryId, finalizedCollection }
```

### Rejection

```
consultant_admin → POST /api/verification/pending-approvals/:id/reject { reason }
  → Load PendingApproval
  → PendingApproval.status = 'Rejected', rejectionReason set
  → DataEntry / NetReductionEntry NOT saved
  → notifySubmitterOfOutcome('Rejected')
  → Response: { success: true, status: 'Rejected', rejectionReason }
```

---

## API Endpoints

All endpoints are mounted at `/api/verification`.

### Threshold Configuration

#### Create / Upsert Config
```
POST /api/verification/threshold-config
Authorization: consultant_admin only

Body:
{
  "clientId": "Greon001",
  "scopeIdentifier": "scope1_stationary_combustion",
  "nodeId": null,                    // null = all nodes
  "flowType": "dataEntry",           // "dataEntry" | "netReduction"
  "thresholdPercentage": 50,         // 0.1 to 10000
  "isActive": true,
  "baselineSampleSize": 10,          // 3 to 50
  "appliesToInputTypes": []          // empty = all types, or ["manual", "API"]
}

Response 200:
{
  "success": true,
  "message": "Threshold config saved",
  "data": { ThresholdConfig document }
}
```

#### List Configs for a Client
```
GET /api/verification/threshold-config/:clientId?flowType=dataEntry&isActive=true
Authorization: consultant_admin, super_admin

Response 200:
{
  "success": true,
  "count": 3,
  "data": [ ...ThresholdConfig documents ]
}
```

#### Update Config
```
PATCH /api/verification/threshold-config/:id
Authorization: consultant_admin only

Body (any of):
{
  "thresholdPercentage": 75,
  "isActive": false,
  "baselineSampleSize": 15,
  "appliesToInputTypes": ["manual", "API"]
}

Response 200:
{
  "success": true,
  "message": "Threshold config updated",
  "data": { updated ThresholdConfig }
}
```

#### Deactivate Config
```
DELETE /api/verification/threshold-config/:id
Authorization: consultant_admin only

Response 200:
{
  "success": true,
  "message": "Threshold config deactivated",
  "data": { ThresholdConfig with isActive: false }
}
```

---

### Pending Approvals

#### List Pending Approvals
```
GET /api/verification/pending-approvals?clientId=Greon001&flowType=dataEntry&status=Pending_Approval&page=1&limit=20
Authorization: consultant_admin, super_admin

Response 200:
{
  "success": true,
  "total": 5,
  "page": 1,
  "pages": 1,
  "data": [ ...PendingApproval documents with populated submittedBy/reviewedBy ]
}
```

#### Get Pending Approval Detail
```
GET /api/verification/pending-approvals/:id
Authorization: consultant_admin, super_admin

Response 200:
{
  "success": true,
  "data": {
    "_id": "...",
    "flowType": "dataEntry",
    "clientId": "Greon001",
    "nodeId": "node_01",
    "scopeIdentifier": "scope1_stationary_combustion",
    "status": "Pending_Approval",
    "inputType": "manual",
    "originalPayload": { ...full data payload to be saved on approval },
    "verificationMeta": {
      "normalizedIncomingValue": 12.5,
      "historicalAverageDailyValue": 2.0,
      "deviationPercentage": 525.0,
      "thresholdPercentage": 50,
      "sampleCount": 10,
      "frequency": "monthly",
      "anomalyReason": "Incoming daily value (12.5) deviates 525.00% from historical average (2.0000), exceeding threshold of 50%"
    },
    "submittedBy": { "userName": "...", "email": "...", "userType": "employee" },
    "submittedAt": "2026-04-11T...",
    "reviewedBy": null,
    "reviewedAt": null,
    "rejectionReason": null,
    "finalizedEntryId": null,
    "finalizedCollection": null
  }
}
```

#### Approve
```
POST /api/verification/pending-approvals/:id/approve
Authorization: consultant_admin only

Body: {} (no body required)

Response 200:
{
  "success": true,
  "message": "Entry approved and saved successfully",
  "data": {
    "pendingApprovalId": "...",
    "finalizedEntryId": "...",
    "finalizedCollection": "DataEntry",
    "status": "Approved"
  }
}
```

#### Reject
```
POST /api/verification/pending-approvals/:id/reject
Authorization: consultant_admin only

Body:
{
  "reason": "Value appears to be a data entry error. Historical range is 1-3 units."
}

Response 200:
{
  "success": true,
  "message": "Entry rejected. No data was saved to the main collection.",
  "data": {
    "pendingApprovalId": "...",
    "status": "Rejected",
    "rejectionReason": "Value appears to be a data entry error..."
  }
}
```

---

## Integration Guide — How Each Input Source Is Covered

### Manual Data Entry
**File:** `dataCollectionController.js` → `saveOneEntry()` → `saveManualData()`

The `saveOneEntry()` function (used for all manual, CSV, and OCR paths) now runs the threshold check before creating a `DataEntry` document. If intercepted:
- The row is skipped and added to `pendingApprovals[]` in the response
- Response shape gains new fields:
  - `pendingApprovalCount: number`
  - `pendingApprovals: [{ index, pendingApprovalId, reason, deviationPercentage, thresholdPercentage }]`

### CSV Upload
**File:** `dataCollectionController.js` → `saveOneEntry()` → `uploadCSVData()`

Same as Manual — uses `saveOneEntry()`. CSV response also gains `pendingApprovals` array with `rowNumber` per intercepted row.

### OCR (saveOCRData, confirmOCRSave)
**File:** `ocrDataCollectionController.js` → calls `saveOneEntry()`

OCR flows call `saveOneEntry()` which now has the check built in. No changes needed to OCR controller — behavior automatically inherited.

### API Data
**File:** `dataCollectionController.js` → `saveAPIData()`

API entries bypass `saveOneEntry()` and create `DataEntry` directly. Threshold check was added inline before `new DataEntry()`. When intercepted, responds with HTTP 202:
```json
{
  "success": false,
  "intercepted": true,
  "message": "Anomaly detected in API data. Entry held for consultant_admin approval.",
  "pendingApprovalId": "...",
  "verificationMeta": { ... }
}
```

### IoT Data
**File:** `dataCollectionController.js` → `saveIoTData()`

Same as API — threshold check added inline before `new DataEntry()`. Same HTTP 202 response shape when intercepted.

### Net Reduction — M1 (Methodology 1)
**File:** `netReductionController.js` → `saveManualNetReduction()` M1 branch

Each row in the batch is checked individually after `net = round6(inputValue × rate)`. Intercepted rows go to `pendingApprovals[]`, passed rows go to `docsToInsert[]`. Response gains:
- `pendingApprovalCount: number`
- `pendingApprovals: [{ row, pendingApprovalId, reason }]`

### Net Reduction — M2 (Methodology 2)
**File:** `netReductionController.js` → `saveManualNetReduction()` M2 branch

Each row is checked after `evaluateM2WithPolicy()` returns `finalNet`. Same handling as M1.

### Net Reduction — M3 (Methodology 3)
**File:** `netReductionController.js` → `saveM3NetReduction()`

Single entry per request. Threshold check runs after M3 calculation yields `NwU_now`. If intercepted, returns HTTP 202 with same shape as API/IoT.

---

## Approval Lifecycle

```
Submitted Entry
       │
       ▼
Threshold Check
  ├── PASS (deviation ≤ threshold, no config, insufficient history)
  │       │
  │       └──► Normal save → DataEntry / NetReductionEntry
  │
  └── FAIL (deviation > threshold)
          │
          ▼
    PendingApproval { status: 'Pending_Approval' }
          │
          ▼
    Notification → consultant_admin (high priority)
          │
    consultant_admin reviews
          │
      ┌───┴───┐
      │       │
   Approve  Reject
      │       │
      ▼       ▼
  DataEntry  PendingApproval
  / NREntry  { status: 'Rejected'
  created      rejectionReason }
      │       │
      ▼       ▼
  Notify    Notify
  submitter submitter
  (approved)(rejected)
```

---

## Notification Lifecycle

### When Anomaly Is Detected
- **Target**: `consultant_admin` of the client (`client.leadInfo.consultantAdminId`)
- **Priority**: `high`
- **systemAction**: `anomaly_detected`
- **Content**: client, scope, incoming value, historical average, deviation %, threshold %, frequency, input type
- **relatedEntity**: `{ type: 'PendingApproval', id: pendingApproval._id }`

### When Entry Is Approved
- **Target**: original submitter (`pendingApproval.submittedBy`)
- **Priority**: `medium`
- **systemAction**: `anomaly_approved`
- **Content**: approval confirmation with scope identifier

### When Entry Is Rejected
- **Target**: original submitter
- **Priority**: `high`
- **systemAction**: `anomaly_rejected`
- **Content**: rejection with reason

---

## Schema Changes

### New Collections

#### `ThresholdConfig`
```js
{
  _id:                  ObjectId
  clientId:             String      // indexed
  scopeIdentifier:      String      // indexed (projectId for NR)
  nodeId:               String|null // null = all nodes
  flowType:             'dataEntry' | 'netReduction'
  thresholdPercentage:  Number      // 0.1 – 10000
  isActive:             Boolean     // default: true
  baselineSampleSize:   Number      // 3 – 50, default: 10
  appliesToInputTypes:  [String]    // empty = all
  createdBy:            ObjectId ref User
  createdByType:        String
  updatedBy:            ObjectId ref User
  createdAt:            Date
  updatedAt:            Date
}
```
**Unique index**: `{ clientId, scopeIdentifier, flowType, nodeId }`

#### `PendingApproval`
```js
{
  _id:                    ObjectId
  flowType:               'dataEntry' | 'netReduction'
  clientId:               String      // indexed
  nodeId:                 String      // DataEntry context
  scopeIdentifier:        String      // DataEntry context
  projectId:              String      // NetReduction context
  calculationMethodology: String      // NetReduction context
  status:                 'Pending_Approval' | 'Approved' | 'Rejected'  // indexed
  inputType:              String
  originalPayload:        Mixed       // full payload to replay on approval
  verificationMeta: {
    normalizedIncomingValue:     Number
    historicalAverageDailyValue: Number
    deviationPercentage:         Number
    thresholdPercentage:         Number
    sampleCount:                 Number
    frequency:                   String
    anomalyReason:               String
  }
  submittedBy:            ObjectId ref User
  submittedByType:        String
  submittedAt:            Date
  reviewedBy:             ObjectId ref User
  reviewedAt:             Date
  rejectionReason:        String
  notificationId:         ObjectId ref Notification
  finalizedEntryId:       ObjectId    // set after approval
  finalizedCollection:    String      // 'DataEntry' | 'NetReductionEntry'
  createdAt:              Date
  updatedAt:              Date
}
```

### Existing Collections — No Schema Changes

- `DataEntry.js` — unchanged. The existing `approvalStatus` field is for post-save tracking only. Anomalous entries are NOT stored here.
- `NetReductionEntry.js` — unchanged. Has no approval field.

---

## Response Shape Changes

### DataEntry — Manual & CSV

New fields added to existing response when any entries are intercepted:

```json
{
  "success": true/false,
  "savedCount": 8,
  "failedCount": 0,
  "pendingApprovalCount": 2,
  "results": [...],
  "errors": [],
  "pendingApprovals": [
    {
      "index": 3,
      "pendingApprovalId": "...",
      "reason": "Incoming daily value deviates 525.00% from historical average...",
      "deviationPercentage": 525.0,
      "thresholdPercentage": 50
    }
  ]
}
```

When no threshold config exists or no anomaly: `pendingApprovals` is `[]` and `pendingApprovalCount` is `0`. Fully backward compatible.

### DataEntry — API & IoT

When intercepted (HTTP 202 instead of 201):
```json
{
  "success": false,
  "intercepted": true,
  "message": "Anomaly detected in API data. Entry held for consultant_admin approval.",
  "pendingApprovalId": "...",
  "verificationMeta": { ... }
}
```

### NetReduction — M1 & M2

Same `pendingApprovals[]` array added to batch response.

### NetReduction — M3

When intercepted (HTTP 202):
```json
{
  "success": false,
  "intercepted": true,
  "message": "Anomaly detected in M3 net reduction. Entry held for consultant_admin approval.",
  "pendingApprovalId": "...",
  "verificationMeta": { ... }
}
```

---

## Migration

**No database migration required.** The two new collections (`ThresholdConfig`, `PendingApproval`) are created automatically by MongoDB on first write. All existing entries in `DataEntry` and `NetReductionEntry` are unaffected.

---

## Assumptions & Limitations

1. **NetReduction frequency**: No collection frequency is configured for NR projects (no `DataCollectionConfig` equivalent). Defaults to `'monthly'` for normalization. If NR frequency is later added to the schema, update `historicalAverageService.js → getNetReductionHistoricalAverage()`.

2. **DataEntry comparable value**: Sum of all `dataValues` Map values. This matches the `dataEntryCumulative.incomingTotalValue` pattern already used in the project.

3. **OCR flows**: `ocrDataCollectionController.js` calls `saveOneEntry()`, so OCR paths inherit the threshold check automatically without any changes to the OCR controller.

4. **Minimum baseline**: The check is skipped if fewer than 3 approved historical entries exist for the stream. This allows new scopes to build history without false anomalies.

5. **`_bypassThreshold` flag**: Only used internally by the approval controller when finalizing a save. It is never exposed as an API parameter.

6. **Notification non-fatal**: If notification creation fails, the anomaly interception still succeeds. The error is logged but does not block the flow.

7. **CSV approval replay**: When a CSV row is approved via `PendingApproval`, it is saved as a single `DataEntry` (not as a CSV import). The audit log will reflect this as a manual-style create, not a CSV import.

---

## Testing Checklist

1. No threshold config for scope → entry saves normally, response unchanged
2. Create `ThresholdConfig` with `thresholdPercentage: 50, baselineSampleSize: 5`
3. Submit 5 historical entries with daily-normalized values around 2.0
4. Submit entry with raw value 10× average → `PendingApproval` created, HTTP 207/202 returned, Notification sent to `consultant_admin`
5. `GET /api/verification/pending-approvals?clientId=...` returns the record
6. `GET /api/verification/pending-approvals/:id` returns full `verificationMeta` and `originalPayload`
7. `POST /api/verification/pending-approvals/:id/approve` → `DataEntry` created, `finalizedEntryId` populated, submitter notified
8. `POST /api/verification/pending-approvals/:id/reject` with `{ reason: "..." }` → no `DataEntry`, `rejectionReason` stored, submitter notified
9. Same tests for NetReduction M1, M2, M3
10. `appliesToInputTypes: ["manual"]` → API input saves normally despite threshold
11. `isActive: false` → saves normally
12. First 2 entries on new scope → saves normally (insufficient baseline)
13. Double-approve or double-reject → HTTP 409 returned
