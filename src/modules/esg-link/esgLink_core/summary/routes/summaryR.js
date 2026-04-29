'use strict';

const express = require('express');
const { auth } = require('../../../../../common/middleware/auth');
const { requireActiveModuleSubscription } = require('../../../../../common/utils/Permissions/modulePermission');
const { checkEsgSummaryPermission }       = require('../utils/summaryPermissions');
const ctrl = require('../controllers/summaryController');

const router = express.Router();

// All routes require: valid JWT + active esg_link subscription + role-based layer access
const guard = [auth, requireActiveModuleSubscription('esg_link'), checkEsgSummaryPermission];

// ─────────────────────────────────────────────────────────────────────────────
// PERIOD QUERY PARAMS (apply to all GET routes below)
//
//   Yearly (default)   ?year=2024
//   Monthly            ?periodType=month&year=2024&month=3
//   Daily              ?periodType=day&date=2024-03-15
//   Financial Year     ?periodType=financial_year&fyStart=2023-04-01&fyEnd=2024-03-31
//
// Optional modifiers:
//   ?refresh=true      force recompute before returning (boundary routes only)
//   ?layers=approved,draft  restrict which workflow layers are returned
// ─────────────────────────────────────────────────────────────────────────────

// ── Org-wide dashboard ────────────────────────────────────────────────────────
// Returns combined approved totals across all active boundaries for the period.
router.get('/:clientId/summary/dashboard', guard, ctrl.getDashboardSummary);

// ── Role-scoped personal view ─────────────────────────────────────────────────
// reviewer    → their assigned reviewer-pending entries
// approver    → their assigned approver-pending entries
// contributor → their own submitted entries
// others      → same as dashboard
router.get('/:clientId/summary/my-view', guard, ctrl.getMyViewSummary);

// ── Reviewer pending queue ────────────────────────────────────────────────────
// full-access roles: all pending entries across all boundaries
// reviewer: only entries assigned to them
router.get('/:clientId/summary/reviewer-pending', guard, ctrl.getReviewerPendingSummary);

// ── Approver pending queue ────────────────────────────────────────────────────
// full-access roles: all under-review entries with decisions
// approver: only entries assigned to them
router.get('/:clientId/summary/approver-pending', guard, ctrl.getApproverPendingSummary);

// ── Single boundary summary ───────────────────────────────────────────────────
// Returns the cached summary for the given period.
// Cache is computed on first request; pass ?refresh=true to force recompute.
router.get('/:clientId/boundaries/:boundaryId/summary', guard, ctrl.getBoundarySummary);

// ── Node-level hierarchy (approved layer only) ────────────────────────────────
// Returns per-node metric breakdown for the approved summary layer.
router.get('/:clientId/boundaries/:boundaryId/summary/hierarchy', guard, ctrl.getHierarchySummary);

// ── List all period summaries saved for a boundary ────────────────────────────
// Returns [{periodType, periodKey, periodStart, periodEnd, lastComputedAt, totalEntries}]
// for every summary document that exists for this boundary (year + month + day + FY).
router.get('/:clientId/boundaries/:boundaryId/summary/periods', guard, ctrl.getAvailablePeriods);

// ── Manual single-period refresh (admin / consultant only) ────────────────────
// Recomputes the summary for the period specified by query params and saves it.
// Broadcasts a socket update on completion.
router.post('/:clientId/boundaries/:boundaryId/summary/refresh', guard, ctrl.refreshSummary);

// ── Refresh ALL period types for a boundary (admin / consultant only) ─────────
// Finds every unique periodLabel in EsgDataEntry for this boundary,
// derives all 4 period defs (year / month / day / financial_year),
// and recomputes + saves each one.
// Returns {results:[{periodType,periodKey,success}], succeeded, failed}.
router.post('/:clientId/boundaries/:boundaryId/summary/refresh-all', guard, ctrl.refreshAllPeriods);

module.exports = router;
