# ESGLink Quota System — Implementation Guide

## Architecture Overview

The quota system is split across three files:

| File | Responsibility |
|---|---|
| `ConsultantClientQuota.js` | Mongoose schema + atomic static methods (`reserveUserSlot`, `releaseUserSlot`) |
| `quotaService.js` | Business logic — `reserveUserTypeSlot`, `releaseUserTypeSlot`, `checkConcurrentLoginLimit` |
| `quotaController.js` | HTTP endpoints — GET / PATCH / POST quota routes |

---

## ESGLink User Types Already Integrated

All three ESGLink user types are fully supported:

```javascript
// ConsultantClientQuota.js — UserTypeQuotasSchema
contributor: { type: UserTypeQuotaEntrySchema, default: () => ({}) },
reviewer:    { type: UserTypeQuotaEntrySchema, default: () => ({}) },
approver:    { type: UserTypeQuotaEntrySchema, default: () => ({}) },

// quotaService.js — USER_TYPE_TO_QUOTA_KEY
'contributor': 'contributor',
'reviewer':    'reviewer',
'approver':    'approver',

// quotaController.js — ALLOWED_USER_TYPE_QUOTA_KEYS
'contributor', 'reviewer', 'approver',
```

---

## How Quota Enforcement Works at User Creation

The flow for `createContributor` / `createReviewer` / `createApprover`:

```
client_admin calls POST /api/users/contributor
        │
        ▼
reserveUserTypeSlot(clientId, 'contributor')
        │
        ├─ Maps 'contributor' → 'contributor' quota key
        ├─ Resolves assignedConsultantId from Client doc
        ├─ If no consultant assigned → allowed (no quota enforcement yet)
        ├─ Gets or creates ConsultantClientQuota doc
        ├─ Reads maxCount (default: 1 if undefined)
        │
        ├─ maxCount === 0 → { allowed: false } → 429 "Blocked"
        │
        ├─ Calls ConsultantClientQuota.reserveUserSlot() atomic increment:
        │     findOneAndUpdate({ usedCount: { $lt: maxCount } }, { $inc: usedCount: 1 })
        │     → returns null if quota full
        │
        ├─ null returned → { allowed: false } → 429 "Quota exceeded"
        │
        └─ updated doc returned → { allowed: true, reserved: true }
                │
                ▼
           new User(...).save()
                │
                ├─ save() fails → releaseUserTypeSlot() rollback (decrements usedCount)
                └─ save() succeeds → 201 Created
```

---

## Atomic Concurrency Safety

The `usedCount` is never incremented with a read-then-write pattern. The MongoDB `findOneAndUpdate` with a conditional filter is used:

```javascript
// Only matches if usedCount < maxCount → atomic guard
findOneAndUpdate(
  { clientId, consultantId, 'userTypeQuotas.contributor.usedCount': { $lt: maxCount } },
  { $inc: { 'userTypeQuotas.contributor.usedCount': 1 } },
  { new: true }
)
```

If two requests arrive simultaneously and one slot remains, only one will get the updated document back. The other gets `null` → denied. This prevents over-quota creation under concurrent load.

---

## Rollback Pattern

Always release the slot if `user.save()` fails:

```javascript
const slot = await reserveUserTypeSlot(req.user.clientId, 'contributor');
if (!slot.allowed) {
  return res.status(429).json({ message: slot.message, quota: { ... } });
}

try {
  await user.save();
} catch (saveErr) {
  if (slot.reserved && slot.consultantId) {
    await releaseUserTypeSlot(req.user.clientId, 'contributor', slot.consultantId).catch(() => {});
  }
  throw saveErr;
}
```

`releaseUserTypeSlot` uses a guarded decrement (`{ $gt: 0 }`) to prevent going negative:

```javascript
findOneAndUpdate(
  { ..., usedCount: { $gt: 0 } },
  { $inc: { usedCount: -1 } }
)
```

---

## When Quota is Not Enforced

`reserveUserTypeSlot` returns `{ allowed: true, controlled: false }` (no enforcement) in these cases:

1. `userType` is not in `USER_TYPE_TO_QUOTA_KEY` (e.g. `super_admin`)
2. The client has no assigned consultant yet

This means quota only kicks in once a consultant is assigned to the client.

---

## Concurrent Login Limit

`checkConcurrentLoginLimit(user)` is called at login time (OTP verification). It:

1. Maps `user.userType` → quota key
2. Resolves the client's assigned consultant
3. Reads `userTypeQuotas[key].concurrentLoginLimit` from the quota doc
4. Counts active `UserSession` documents for that user
5. Denies login if `activeCount >= concurrentLimit`

```javascript
// Called in verifyLoginOTP controller:
const loginCheck = await checkConcurrentLoginLimit(user);
if (!loginCheck.allowed) {
  return res.status(429).json({ message: loginCheck.message });
}
```

Set the concurrent limit via:
```
PATCH /api/quota/clients/:clientId/quota/user-types
{ "userTypeQuotas": { "contributor": { "concurrentLoginLimit": 2 } } }
```

---

## Sync Used Counts (Maintenance)

If `usedCount` drifts from reality (e.g. after bulk deletes or migrations), use:

```
POST /api/quota/clients/:clientId/quota/user-types/sync-counts
```

This recomputes `usedCount` for all 7 user types from live `User.countDocuments` calls. Filters: `isActive: true, isDeleted: { $ne: true }`.

Run this after:
- Bulk user import/export
- Manual DB corrections
- Moving users between clients

---

## Setting Up ESGLink Quotas for a New Client

When a new client is assigned a consultant and ESGLink is enabled:

1. A `ConsultantClientQuota` doc is auto-created via `getOrCreate()` on first user creation attempt
2. Default `maxCount` is `1` for all types — **explicitly set ESGLink quotas before creating users**:

```
PATCH /api/quota/clients/CLIENT_001/quota/user-types
{
  "userTypeQuotas": {
    "contributor": { "maxCount": 10 },
    "reviewer":    { "maxCount": 3 },
    "approver":    { "maxCount": 2 }
  },
  "notes": "Initial ESGLink team setup"
}
```

3. Optionally set concurrent login limits:

```json
{
  "userTypeQuotas": {
    "contributor": { "concurrentLoginLimit": 1 },
    "reviewer":    { "concurrentLoginLimit": 1 }
  }
}
```

---

## File Locations

| File | Path |
|---|---|
| Schema + statics | `src/modules/client-management/quota/ConsultantClientQuota.js` |
| Service functions | `src/modules/client-management/quota/quotaService.js` |
| HTTP controller | `src/modules/client-management/quota/quotaController.js` |
| Routes | `src/modules/client-management/quota/quotaRoutes.js` |
