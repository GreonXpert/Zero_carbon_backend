# ESGLink Core — Reviewer/Approver SLA Escalation: Test Report

**Test file:** `__tests__/EsgLink/dataEscalation.test.js`
**Run command:** `npx jest __tests__/EsgLink/dataEscalation.test.js --runInBand`
**Date:** 2026-06-10
**Result:** ✅ **9 / 9 tests passed**

```
Test Suites: 1 passed, 1 total
Tests:       9 passed, 9 total
Snapshots:   0 total
Time:        6.568 s
```

## Test environment

- Jest + `mongodb-memory-server` (in-memory MongoDB instance, no external DB required)
- `process.env.FIELD_ENCRYPTION_KEY` set to a freshly generated 64-char hex string at the
  top of the test file (required before `EsgLinkBoundary` — and anything that transitively
  requires it — is loaded, due to the AES-256-GCM field encryption plugin on
  `nodes`/`edges`).
- All collections (`EsgLinkBoundary`, `EsgDataEntry`, `EsgWorkflowAction`, `Notification`,
  `Client`, `User`) are cleared in `afterEach` to keep tests isolated.

## Results by suite

### 1. Model defaults

| Test | Result | Notes |
|---|---|---|
| `EsgLinkBoundary.slaConfig` defaults to `reviewDeadlineDays=3, approvalDeadlineDays=3, escalationEnabled=true` | ✅ Pass | Confirms the new `slaConfig` subdocument applies its defaults when not provided at creation. |
| `EsgDataEntry` escalation fields default to `null`/`false` | ✅ Pass | Confirms `underReviewAt`, `isEscalated`, `escalatedAt`, `escalationStage` all default correctly on a fresh `draft` entry. |

### 2. `workflowService.transition()`

| Test | Result | Notes |
|---|---|---|
| Transitioning `submitted` → `under_review` sets `underReviewAt` and resets escalation flags | ✅ Pass | Entry was seeded with `isEscalated: true`, `escalatedAt`, `escalationStage: 'review'` (simulating a prior escalation). After `transition(..., 'under_review', ...)` with a `super_admin` actor, `underReviewAt` is set to a non-null timestamp and all three escalation fields reset to `false`/`null`. |

### 3. `workflowService.recordApproverDecision()`

| Test | Result | Notes |
|---|---|---|
| Approving an `under_review` submission resets escalation flags | ✅ Pass | Entry was seeded as `under_review` with `isEscalated: true`, `escalatedAt`, `escalationStage: 'approval'`, and a single pending approval decision. After the approver approves (100% approval → `finalStatus = 'approved'`), `workflowStatus` becomes `'approved'` and all escalation flags reset to `false`/`null` because the submission left `under_review`. |

### 4. `checkEsgReviewerApproverEscalations()`

| Test | Result | Notes |
|---|---|---|
| Escalates a `submitted` entry past `reviewDeadlineDays` → `stage='review'`, logs `EsgWorkflowAction`, notifies reviewers + consultant + client_admin | ✅ Pass | Entry's `submittedAt` was set 5 days in the past on a boundary with `reviewDeadlineDays: 3`. After running the checker: `isEscalated=true`, `escalatedAt` set, `escalationStage='review'`; an `EsgWorkflowAction` with `action:'escalated'` and `metadata.stage:'review'` was created; a `Notification` (`systemAction:'esg_submission_escalated'`) was created with `targetUsers` containing the mapping's reviewer, the client's assigned consultant, and the `client_admin`. |
| Escalates an `under_review` entry past `approvalDeadlineDays` → `stage='approval'`, notifies approvers + consultant + client_admin | ✅ Pass | Entry's `underReviewAt` was set 5 days in the past on a boundary with `approvalDeadlineDays: 3`. After running the checker: `isEscalated=true`, `escalationStage='approval'`; `EsgWorkflowAction` with `metadata.stage:'approval'` created; `Notification.targetUsers` contains the mapping's approver, consultant, and client_admin. |
| Skips escalation when `boundary.slaConfig.escalationEnabled = false` | ✅ Pass | An overdue `submitted` entry (5 days past a 3-day review deadline) on a boundary with `escalationEnabled: false` is left untouched (`isEscalated` stays `false`, no `EsgWorkflowAction` created). |
| Does not re-escalate an entry that is already `isEscalated=true` | ✅ Pass | The checker's query filters on `isEscalated: false`, so an already-escalated entry is excluded entirely (`result.checked === 0`) and its original `escalatedAt` timestamp is preserved. |
| Does not escalate a `submitted` entry still within `reviewDeadlineDays` | ✅ Pass | An entry submitted 1 day ago against a 3-day review deadline is checked (`result.checked === 1`) but not escalated (`result.escalated === 0`, `isEscalated` stays `false`). |

## Notes / fixes made during testing

1. **Notification schema fix** (`src/common/models/Notification/Notification.js`): `createdBy` and
   `creatorType` were `required: true`, but system-generated notifications (frequency reminders,
   and the new escalation alerts) have no human actor and never set these fields. This caused
   `Notification.save()` to silently fail validation (the error was swallowed by a `.catch()` in
   `esgDataNotificationService`), so **no escalation notification was ever persisted**. Both
   fields were changed to optional. This is a pre-existing latent bug affecting `notify()` and
   `sendFrequencyReminder()` as well, now fixed for all three.

2. **Escalation checker recipient resolution fix**
   (`src/modules/esg-link/esgLink_core/workflow/jobs/esgReviewerApproverEscalationChecker.js`):
   `Client.workflowTracking` is stored as a single AES-256-GCM encrypted field (whole-subdocument
   encryption). The original `_resolveEscalationRecipients()` used
   `.select('workflowTracking.assignedConsultantId leadInfo.assignedConsultantId').lean()`, which
   cannot retrieve a sub-path of an encrypted field. Changed to
   `.select('workflowTracking leadInfo.assignedConsultantId').lean()` so the whole
   `workflowTracking` field is fetched and decrypted by the encryption plugin's `post('find')`
   hook before `assignedConsultantId` is read from it.

3. **Test fixtures**: `Client.leadInfo` requires `companyName`, `contactPersonName`, `email`,
   `mobileNumber`, and `createdBy` whenever the `leadInfo` subdocument is present (even though
   `leadInfo` itself is optional at the top level, Mongoose materializes it with defaults and
   validates required sub-fields). Test fixtures supply minimal valid values for these fields.

## Out of scope for this Jest suite

Per the approved plan, full HTTP/`supertest`-based API tests for the 4 new endpoints
(`GET/PATCH /:clientId/boundary/sla-settings`, `GET /:clientId/escalations`,
`POST /:clientId/escalations/run-check`) were **not** written, because no
`supertest`/API-test precedent exists anywhere in `__tests__/` for this codebase. Instead, a
Postman collection (`Document/Esg_link/esgLink_core/DataCollection/dataEslacaltion/dataEscalation.postman_collection.json`)
is provided to exercise these endpoints against a running server.
