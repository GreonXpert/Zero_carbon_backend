# Subscription Expiry Jobs — Developer Reference

## Overview

Two dedicated cron jobs manage the subscription lifecycle for the ZeroCarbon and ESGLink modules:

| Job file | Module | Schedule |
|---|---|---|
| `utils/jobs/zeroCarbonExpiryChecker.js` | ZeroCarbon | Daily **02:05 UTC** |
| `utils/jobs/esgLinkExpiryChecker.js` | ESGLink | Daily **02:00 UTC** |

Both jobs run automatically when the server starts (registered in `index.js`). They are safe to re-run — deduplication logic prevents duplicate emails and double transitions.

---

## Subscription Status Flow

```
         ┌──────────────────────────────────────────────────────────┐
         │                                                          │
  [active] ──(end date passed, ≤30 days ago)──► [grace_period]     │
                                                      │             │
                                          (>30 days after end date) │
                                                      │             │
                                                      ▼             │
                                               [expired] ──────────┘
                                               (isActive = false)
```

| Status | Meaning | Access allowed? |
|---|---|---|
| `active` | Subscription is current | ✅ Full access |
| `grace_period` | Subscription expired, within 30-day grace window | ✅ Access still allowed |
| `expired` | Grace period exhausted | ❌ Access blocked (403) |
| `suspended` | Manually suspended by admin | ❌ Access blocked (403) |
| `pending_suspension` | Suspension requested, awaiting approval | ✅ Access still allowed |

**Grace period duration:** 30 days (constant in both job files).

---

## Email Notifications

All emails are sent to the **client admin** (`accountDetails.clientAdminId`).

### Pre-expiry warnings (sent while subscription is still `active`)

| Threshold | Subject |
|---|---|
| 30 days before expiry | `ZeroCarbon - Subscription Expiring in 30 Days` |
| 7 days before expiry | `ZeroCarbon - Subscription Expiring in 7 Days` |
| 1 day before expiry | `ZeroCarbon - Subscription Expiring in 1 Day` |
| (same thresholds) | `ESGLink - Subscription Expiring in X Days` |

Duplicate prevention: once a threshold email is sent, `expiryWarningsSent[]` is updated with `{ daysBeforeExpiry, sentAt }`. Re-running the job will not send the same email twice.

### Grace period start (sent when status moves `active → grace_period`)

| Module | Subject |
|---|---|
| ZeroCarbon | `ZeroCarbon - Subscription Expired (Grace Period Active)` |
| ESGLink | `ESGLink - Subscription Expired (Grace Period Active)` |

The email states the grace period end date and instructs the client to contact their consultant.

---

## User Deactivation Rules

When a subscription reaches **fully expired** (`grace_period → expired`):

| Module | Users deactivated |
|---|---|
| ZeroCarbon | Users whose `accessibleModules` is exactly `["zero_carbon"]` |
| ESGLink | Users whose `accessibleModules` is exactly `["esg_link"]` |
| Both | Dual-module users (`["zero_carbon", "esg_link"]`) are **never** auto-deactivated |

This means:
- If a client's **ZeroCarbon** subscription expires, their ESGLink-only staff remain active.
- If a client's **ESGLink** subscription expires, their ZeroCarbon-only staff remain active.
- A user who has access to both modules is not deactivated by either job — manual admin action is required.

---

## Frontend Integration Guide

### Reading subscription status

The client object returned from the API contains:

```json
{
  "accountDetails": {
    "subscriptionStatus": "grace_period",
    "subscriptionEndDate": "2025-03-01T00:00:00.000Z",
    "isActive": true,
    ...
  },
  "accountDetails": {
    "esgLinkSubscription": {
      "subscriptionStatus": "active",
      "subscriptionEndDate": "2025-06-01T00:00:00.000Z",
      "isActive": true
    }
  },
  "accessibleModules": ["zero_carbon", "esg_link"]
}
```

| Field | Path |
|---|---|
| ZeroCarbon status | `client.accountDetails.subscriptionStatus` |
| ZeroCarbon end date | `client.accountDetails.subscriptionEndDate` |
| ESGLink status | `client.accountDetails.esgLinkSubscription.subscriptionStatus` |
| ESGLink end date | `client.accountDetails.esgLinkSubscription.subscriptionEndDate` |
| Modules available | `client.accessibleModules` |

### Recommended UI behaviour

| Status | Recommended UI |
|---|---|
| `active` | No banner — normal experience |
| `grace_period` | **Yellow warning banner** — "Your subscription has expired. You have until [grace end date] to renew. Contact your consultant." |
| `expired` | **Red error banner / locked screen** — "Your subscription has expired. Please contact your consultant to restore access." |
| `suspended` | **Red banner** — "Your account has been suspended. Contact support." |

### Checking which modules a user can access

Use `user.accessibleModules` (array) to show/hide module-specific UI sections:

```js
const canUseZeroCarbon = user.accessibleModules.includes('zero_carbon');
const canUseEsgLink    = user.accessibleModules.includes('esg_link');
```

### Handling API 403 responses

When a subscription is `expired` or `suspended`, the auth middleware returns:

```json
{
  "message": "Your ZeroCarbon subscription has expired. Please renew to continue.",
  "status": 403
}
```

or for ESGLink:

```json
{
  "message": "Your ESGLink subscription has expired. Please renew to continue.",
  "status": 403
}
```

**Frontend action:** Intercept 403 in your API client. If the error message contains "subscription", redirect to a subscription renewal / contact-consultant page rather than a generic error page.

---

## Access Control Reference

Access enforcement is handled in `middleware/auth.js`. For each API request:

1. User's `accessibleModules` is checked against the route's required module.
2. The corresponding subscription status is checked:
   - ZeroCarbon: `client.accountDetails.subscriptionStatus` must be `"active"` or `"grace_period"`
   - ESGLink: `client.accountDetails.esgLinkSubscription.subscriptionStatus` must be `"active"` or `"grace_period"`
3. If the status is `"expired"` or `"suspended"` → **HTTP 403** is returned immediately.

---

## Cron Job Schedule Reference

| Job | File | Schedule | What it does |
|---|---|---|---|
| ESGLink expiry checker | `utils/jobs/esgLinkExpiryChecker.js` | `0 2 * * *` (02:00 UTC) | Pre-expiry warnings + active→grace_period + grace_period→expired for ESGLink |
| ZeroCarbon expiry checker | `utils/jobs/zeroCarbonExpiryChecker.js` | `5 2 * * *` (02:05 UTC) | Pre-expiry warnings + active→grace_period + grace_period→expired for ZeroCarbon |
| API key expiry checker | `utils/jobs/apiKeyExpiryChecker.js` | `0 9 * * *` (09:00 IST) | Warns about expiring API keys; marks expired keys inactive |
| Missed cycle detector | `utils/jobs/missedCycleDetector.js` | `0 3 * * *` (03:00 UTC) | Flags survey cycles that passed their due date without a DataEntry |
| Ticket SLA checker | `utils/jobs/ticketSlaChecker.js` | `*/15 * * * *` (every 15 min) | Checks SLA breaches and warnings; auto-escalates tickets |
| Summary maintenance | `utils/jobs/summaryMaintenanceJob.js` | `0 * * * *` + `0 2 * * *` | Hourly: recalculates pending summaries. Daily: cleans summaries >90 days old |

All jobs are registered in `index.js` inside the `connectDB().then(...)` block, ensuring they only start after the database is connected.

---

## Manual Trigger (for testing / admin use)

Both expiry checkers export a manual trigger function:

```js
const { manualEsgLinkExpiryCheck }    = require('./utils/jobs/esgLinkExpiryChecker');
const { manualZeroCarbonExpiryCheck } = require('./utils/jobs/zeroCarbonExpiryChecker');

// Run all three phases (warnings → grace_period → expired)
await manualEsgLinkExpiryCheck();
await manualZeroCarbonExpiryCheck();
```

These can be wired to a protected admin route or called from a one-off script for testing.

---

## Schema Fields Added

Two new fields were added to `models/CMS/Client.js`:

**`accountDetails.expiryWarningsSent`** (ZeroCarbon):
```json
[{ "daysBeforeExpiry": 7, "sentAt": "2025-02-22T02:00:00.000Z" }]
```

**`accountDetails.esgLinkSubscription.expiryWarningsSent`** (ESGLink):
```json
[{ "daysBeforeExpiry": 30, "sentAt": "2025-01-30T02:00:00.000Z" }]
```

These fields default to `[]` for all existing documents — no migration required.
