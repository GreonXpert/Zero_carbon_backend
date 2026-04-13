# Module-Specific Subscription Expiry — Change Log & Integration Guide

**Project:** Zero Carbon Platform
**Date:** 2026-04-12
**Backend status:** ✅ Complete
**Frontend status:** ⏳ Pending (see Section 4)

---

## 1. Why This Change Was Made

**Problem:** When the ZeroCarbon subscription expired, the backend was setting a global
`accountDetails.isActive = false` flag and blocking ALL users of that client from every
route — including ESGLink routes that had a completely valid subscription.

Additionally, consultants had no `clientId` on their user record, so the subscription
check block was silently skipped for them. Consultants could access all feature pages
of expired modules with no restriction.

**Goal:** Make subscription expiry module-specific.
- ZeroCarbon expiry → block ZeroCarbon routes only
- ESGLink expiry → block ESGLink routes only
- Consultants → blocked from expired module feature pages, but always able to reach
  the subscription management page to renew

---

## 2. What Changed in the Backend (3 Files)

### File 1 — `middleware/auth.js`  (lines 93–117)

**Old logic (broken):**
- Checked `accountDetails.isActive !== true` globally → blocked ALL users when ZeroCarbon expired
- Then looped through ALL user modules → blocked the entire request if ANY module was expired

**New logic:**
- Removed the global `isActive` check entirely
- Now computes which of the user's modules are active
- Only hard-blocks at the auth level if **every** module the user holds is expired
- If at least one module is active → lets the request through
- Attaches two things to `req` for downstream route middleware to use:
  - `req.expiredModules` — list of which modules are expired
  - `req.client` — the client document (so route middleware does not need a second DB call)

---

### File 2 — `utils/Permissions/modulePermission.js`  (new function added)

**Added:** `requireActiveModuleSubscription(moduleName)`

This is an Express middleware factory. It is applied per-route group in `index.js`.

How it works:
1. Reads `req.client` if already attached (client users — no extra DB call needed)
2. If `req.client` is absent (consultant users) → looks up client via `req.params.clientId`
3. Skips sandbox clients
4. Calls `isModuleSubscriptionActive(client, moduleName)` to check subscription status
5. If expired → returns `403` with:
   ```json
   {
     "message": "The ZeroCarbon subscription has expired or is not active",
     "module": "zero_carbon",
     "subscriptionExpired": true
   }
   ```
6. If active → calls `next()` and the request proceeds normally

**Exported as:** `requireActiveModuleSubscription` (alongside existing exports)

---

### File 3 — `index.js`  (route registrations updated)

**Added import:**
```js
const { requireActiveModuleSubscription } = require('./utils/Permissions/modulePermission');
const zcGate = requireActiveModuleSubscription('zero_carbon');
```

**ZeroCarbon feature routes now have `zcGate` inserted before their router:**

| Route | Module Gate Applied |
|-------|-------------------|
| `/api/flowchart` | ✅ zcGate |
| `/api/processflow` | ✅ zcGate |
| `/api/transport-flowchart` | ✅ zcGate |
| `/api/summaries` | ✅ zcGate |
| `/api/reductions` | ✅ zcGate |
| `/api/net-reduction` | ✅ zcGate |
| `/api/formulas` | ✅ zcGate |
| `/api/sbti` | ✅ zcGate |
| `/api/data-collection` | ✅ zcGate |
| `/api/verification` | ✅ zcGate |
| `/api/clients` | ❌ No gate — subscription management lives here |
| `/api/notifications` | ❌ No gate — cross-module shared |
| `/api/tickets` | ❌ No gate — cross-module shared |
| `/api/audit-logs` | ❌ No gate — cross-module shared |
| `/api/defra`, `/api/gwp`, etc. | ❌ No gate — reference data only |

Also removed a duplicate `app.use('/api/verification', ...)` registration that was
further down in the file (would have caused double routing).

---

## 3. How the System Now Works (Flow)

```
Request arrives
      │
      ▼
[auth.js]
  • Verifies JWT + session
  • For client users only (they have clientId):
      → Find active modules
      → If ALL modules expired → 403 immediately
      → If at least one active → attach req.expiredModules + req.client
  • Consultants pass through (no clientId on their record)
      │
      ▼
[zcGate middleware]  ← only on ZeroCarbon routes
  • Client users: uses req.client (no DB call)
  • Consultants: reads req.params.clientId → fetches client
  • Checks ZeroCarbon subscription status
  • Expired → 403 { subscriptionExpired: true, module: 'zero_carbon' }
  • Active  → proceed
      │
      ▼
[Route handler / controller]
```

**Business rules enforced:**
- ZeroCarbon expires → only `/api/flowchart`, `/api/reductions`, etc. are blocked
- ESGLink expires → ZeroCarbon routes are completely unaffected (no gate on them)
- Consultants → caught by `zcGate` even though they bypassed auth's client check
- Subscription management → never gated; consultants can always renew
- Sandbox → always allowed through, no subscription check

---

## 4. Frontend Developer — What You Must Build

The backend now sends a structured response when a module is expired. The frontend
currently shows raw 403 errors with no redirection. The following 6 tasks are required.

---

### Task 1 — Handle the 403 globally in the Axios interceptor

**File:** `src/api/axios.js`

When any API call returns `403` with `subscriptionExpired: true`, redirect the user to a
dedicated page. Do this in the Axios response interceptor so every component is covered
automatically.

```js
axiosInstance.interceptors.response.use(
  response => response,
  error => {
    const data = error.response?.data;

    if (error.response?.status === 403 && data?.subscriptionExpired === true) {
      const module = data.module || 'zero_carbon';
      // Update Redux so sidebar reacts (see Task 3)
      store.dispatch(setModuleSubscriptionStatus({ module, status: 'expired' }));
      // Redirect — guard against infinite loop if already on this page
      if (!window.location.pathname.startsWith('/subscription-expired')) {
        window.location.href = `/subscription-expired/${module}`;
      }
    }

    return Promise.reject(error);
  }
);
```

**The two fields the backend sends that you must read:**

| Field | Value | Meaning |
|-------|-------|---------|
| `subscriptionExpired` | `true` | This is a subscription block — not a role/permission error |
| `module` | `"zero_carbon"` or `"esg_link"` | Which module expired |

> Do NOT confuse this with a regular 403. Regular 403s have no `subscriptionExpired` field.

---

### Task 2 — Create a SubscriptionExpired page

**New file:** `src/pages/SubscriptionExpired/SubscriptionExpired.jsx`

- Read the module from the URL param `:module`
- Display which module expired and what the user should do
- Provide a button to go to the subscription management page
- For `consultant` / `consultant_admin` role → link to their leads/client management page
  (where `SubscriptionManager` component is already present)
- For client roles → link to their dashboard or profile subscription section

```jsx
import { useParams, useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { Box, Typography, Button } from '@mui/material';

export default function SubscriptionExpired() {
  const { module } = useParams(); // 'zero_carbon' or 'esg_link'
  const navigate = useNavigate();
  const { userType } = useSelector(state => state.auth);

  const moduleName = module === 'esg_link' ? 'ESGLink' : 'ZeroCarbon';

  const handleGoToSubscription = () => {
    if (userType === 'consultant' || userType === 'consultant_admin') {
      navigate('/consultant/leads'); // adjust to your actual subscription management route
    } else {
      navigate('/client_admin/dashboard'); // adjust to your actual route
    }
  };

  return (
    <Box sx={{ p: 4, textAlign: 'center' }}>
      <Typography variant="h5" sx={{ mb: 2 }}>
        {moduleName} Subscription Expired
      </Typography>
      <Typography variant="body1" sx={{ mb: 3 }}>
        Your organisation's {moduleName} subscription has expired or is not active.
        Please contact your consultant administrator to renew the subscription.
      </Typography>
      <Button variant="contained" onClick={handleGoToSubscription}>
        Go to Subscription Management
      </Button>
    </Box>
  );
}
```

---

### Task 3 — Store module subscription status in Redux

**File:** `src/redux/features/auth/authSlice.jsx`

Add to `initialState`:
```js
moduleSubscriptionStatus: JSON.parse(localStorage.getItem("moduleSubscriptionStatus")) || {}
// shape: { zero_carbon: 'active', esg_link: 'expired' }
```

Add a new reducer action inside the `reducers` object:
```js
setModuleSubscriptionStatus(state, action) {
  // action.payload = { module: 'zero_carbon', status: 'expired' }
  state.moduleSubscriptionStatus = {
    ...state.moduleSubscriptionStatus,
    [action.payload.module]: action.payload.status,
  };
  localStorage.setItem(
    "moduleSubscriptionStatus",
    JSON.stringify(state.moduleSubscriptionStatus)
  );
},
```

Export this action so the Axios interceptor can dispatch it:
```js
export const { logout, clearError, clearMessages, refreshAuth, updateUser,
  resetOTPState, decrementResendCooldown, setModuleSubscriptionStatus } = authSlice.actions;
```

The Axios interceptor (Task 1) dispatches this action when it receives a
`subscriptionExpired` 403. The sidebar (Task 4) reads it to decide which items to show.

---

### Task 4 — Filter the sidebar by subscription status

**File:** `src/util/sidebarHelpers.js`

Add this new helper after the existing `filterSidebarByAssessmentLevel` function:

```js
/**
 * Filter out sidebar items that belong to a module with an expired subscription.
 *
 * Each module-specific sidebar item should have a `module` property set to
 * 'zero_carbon' or 'esg_link' (see Task 5 — sidebarConfig.js).
 *
 * Items with no `module` property are always shown
 * (Dashboard, Notifications, Tickets, Audit Logs, etc.)
 *
 * @param {Array}  items         - Sidebar items array
 * @param {Object} moduleStatus  - e.g. { zero_carbon: 'expired', esg_link: 'active' }
 * @returns {Array} Filtered items
 */
export const filterSidebarBySubscriptionStatus = (items, moduleStatus = {}) => {
  const ACTIVE_STATUSES = ['active', 'grace_period'];
  return items.filter(item => {
    if (!item.module) return true;                    // no tag = always visible
    const status = moduleStatus[item.module];
    if (!status) return true;                         // unknown = show (safe default)
    return ACTIVE_STATUSES.includes(status);
  });
};
```

**File:** `src/components/Admin/Sidebar.jsx`

Import the new helper and apply it:

```js
import {
  filterSidebarByAssessmentLevel,
  filterSidebarBySubscriptionStatus   // ← add this
} from '../../util/sidebarHelpers';

// Inside the Sidebar component, read from Redux:
const { moduleSubscriptionStatus } = useSelector(state => state.auth);

// Inside the useMemo that builds `items`, after the existing assessmentLevel filter:
const items = useMemo(() => {
  let baseItems = /* ... existing switch/case logic unchanged ... */;

  // Existing filter (keep as-is)
  if (['client_admin', 'client_employee_head', 'employee'].includes(userType)) {
    baseItems = filterSidebarByAssessmentLevel(baseItems, clientAssessmentLevel);
  }

  // NEW — filter by module subscription status for ALL roles
  baseItems = filterSidebarBySubscriptionStatus(baseItems, moduleSubscriptionStatus);

  return baseItems;
}, [userType, clientAssessmentLevel, moduleSubscriptionStatus]);
```

---

### Task 5 — Tag sidebar config items by module

**File:** `src/components/Layout/sidebarConfig.js`

Add `module: 'zero_carbon'` to every ZeroCarbon feature menu item.
Cross-module items (Dashboard, Notifications, etc.) must have **no** `module` property.

**Add `module: 'zero_carbon'` to these items (all roles that have them):**
- Organisation Flowchart
- Process Flowchart
- Transport Flowchart
- Data Entry / Data Collection
- Emissions Summary
- Reductions / Net Reduction
- Formulas
- SBTi / Decarbonisation

**Add `module: 'esg_link'` to these items (when ESGLink items are added):**
- Any ESGLink-specific menu entries

**Leave with NO `module` property (always visible regardless of subscription):**
- Dashboard
- Notifications
- Tickets
- Audit Logs
- Profile / Settings
- Subscription Management

Example:
```js
// Before
{ id: 'flowchart', label: 'Organisation', path: '/consultant/flowchart', icon: <...> }

// After
{ id: 'flowchart', label: 'Organisation', path: '/consultant/flowchart', icon: <...>, module: 'zero_carbon' }
```

This single property change is all that is needed. The `filterSidebarBySubscriptionStatus`
helper from Task 4 reads it automatically.

---

### Task 6 — Register the SubscriptionExpired route in App.js

**File:** `src/App.js`

```jsx
import SubscriptionExpired from './pages/SubscriptionExpired/SubscriptionExpired';

// Place this OUTSIDE any role-restricted ProtectedRoute block
// so every authenticated user type can reach it:
<Route path="/subscription-expired/:module" element={<SubscriptionExpired />} />
```

---

## 5. Role Behaviour After This Change

| Role | When ZeroCarbon expires | When ESGLink expires |
|------|------------------------|---------------------|
| `client_admin` | Blocked from ZeroCarbon routes | Blocked from ESGLink routes |
| `client_employee_head` | Blocked from ZeroCarbon routes | Blocked from ESGLink routes |
| `employee` | Blocked from ZeroCarbon routes | N/A (no ESGLink role) |
| `viewer` | Blocked from whichever module is in their `accessibleModules` | Same |
| `auditor` | Same as viewer | Same as viewer |
| `contributor` | N/A (ESGLink only) | Blocked |
| `reviewer` | N/A (ESGLink only) | Blocked |
| `approver` | N/A (ESGLink only) | Blocked |
| `consultant` | Blocked from ZeroCarbon feature routes for that client | Blocked from ESGLink feature routes for that client |
| `consultant_admin` | Same as consultant | Same as consultant |
| `super_admin` | **Never blocked** — no `clientId`, no subscription check | **Never blocked** |

> Consultants and consultant_admins can always reach
> `PATCH /api/clients/:clientId/subscription` to renew, regardless of expiry.

---

## 6. Concerns the Frontend Developer Must Know

### ⚠️  1. Consultant routes must use `:clientId` as a URL param

The `requireActiveModuleSubscription` middleware reads `req.params.clientId` to fetch
the client for consultants (who have no `clientId` on their user record).

If any consultant-facing feature route passes `clientId` in the request **body** instead
of the URL, the gate will not fire and the route will be unprotected.

**Action:** When building or reviewing consultant routes, always make sure `clientId`
is in the URL path (e.g. `GET /api/flowchart/:clientId/nodes`) not in POST body only.

---

### ⚠️  2. Sidebar state may be stale after renewal

`moduleSubscriptionStatus` is stored in localStorage. If an admin renews a subscription
from a different device or session, the local state may still say "expired" until:
- The user logs out and back in, OR
- An API call succeeds and the 403 interceptor is no longer triggered

**Recommendation:** On `verifyLoginOTP.fulfilled` (login success), include subscription
status in the login response from the backend and populate `moduleSubscriptionStatus`
immediately in Redux. This guarantees accuracy on every fresh login.

---

### ⚠️  3. Pages that render before any API call

If a page renders visual content before making any API call, the user will briefly see
the page before the 403 interceptor fires and redirects them.

**Recommendation:** For ZeroCarbon feature pages (Organisation, Reduction, SBTi, etc.),
add a route-level check in `App.js` that reads `moduleSubscriptionStatus` from Redux
and redirects to `/subscription-expired/zero_carbon` before the page renders.

---

### ⚠️  4. Grace period — no warning banner yet

During the 30-day grace period (`subscriptionStatus = 'grace_period'`), the backend
treats the subscription as fully active. No 403 is returned. Users can access everything.

The frontend should ideally show a warning banner: "Your subscription expires in X days."
This is not yet implemented. It requires the backend login response to include the
subscription end date, or a separate lightweight API call for subscription info.

---

### ⚠️  5. Adding future ESGLink feature routes (backend)

When ESGLink feature routes are created on the backend, apply the gate in `index.js`:
```js
const esgGate = requireActiveModuleSubscription('esg_link');
app.use('/api/esg-some-feature', esgGate, esgFeatureRouter);
```

On the frontend side, once Task 4 and Task 5 are done, ESGLink expiry will already
be handled automatically by the existing interceptor and sidebar filter — no extra
frontend changes needed.

---

## 7. Verification Steps

After the backend changes are deployed, verify with a REST client (Postman / Insomnia):

1. In MongoDB, set a test client:
   ```js
   db.clients.updateOne(
     { clientId: "YOUR_TEST_CLIENT_ID" },
     { $set: { "accountDetails.subscriptionStatus": "expired" } }
   )
   // leave esgLinkSubscription.subscriptionStatus as "active"
   ```

2. Run these requests and check responses:

| Request | Token | Expected Response |
|---------|-------|-------------------|
| `GET /api/flowchart` | Client user (ZeroCarbon) | `403 { subscriptionExpired: true, module: 'zero_carbon' }` |
| `GET /api/notifications` | Same client user | `200 OK` |
| `GET /api/flowchart` | ESGLink-only user | `200 OK` |
| `GET /api/flowchart` | Consultant for that client | `403 { subscriptionExpired: true, module: 'zero_carbon' }` |
| `PATCH /api/clients/:clientId/subscription` | Same consultant | `200 / 202` |
| `GET /api/flowchart` after setting status back to `active` | Client user | `200 OK` |

---

## 8. Remaining Limitations

| # | Limitation | Owner |
|---|-----------|-------|
| 1 | Frontend Tasks 1–6 not yet implemented — users see raw 403 errors | Frontend |
| 2 | Sidebar still shows expired module items until Tasks 4 & 5 done | Frontend |
| 3 | No grace period warning banner | Frontend + Backend |
| 4 | Consultant routes passing `clientId` in body (not URL param) bypass the gate | Backend audit needed |
| 5 | ESGLink feature routes do not exist yet — gate will be added when they are created | Backend |

---

*End of document.*
